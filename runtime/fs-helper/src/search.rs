//! 在 Runtime 的执行边界内使用 ripgrep 库搜索，不调用宿主工具或读取 rg 配置。
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use ignore::{WalkBuilder, overrides::OverrideBuilder};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::File,
    io,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
pub struct Request {
    path: String,
    roots: BTreeMap<String, Option<PathBuf>>,
    pattern: String,
    glob: Option<String>,
    #[serde(default = "default_context")]
    context: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}
fn default_context() -> usize {
    2
}
fn default_limit() -> usize {
    50
}

pub fn execute(request: Request) -> Result<Value, String> {
    search(request).map_err(|e| format!("search failed: {e}"))
}

pub fn execute_scoped(
    root: &str,
    relative: &str,
    pattern: String,
    glob: Option<String>,
    context: usize,
    limit: usize,
) -> Result<Value, String> {
    let path = if relative.is_empty() || relative == "." {
        "workspace://repo".to_owned()
    } else {
        format!("workspace://repo/{relative}")
    };
    execute(Request {
        path,
        roots: BTreeMap::from([("repo".into(), Some(root.into()))]),
        pattern,
        glob,
        context,
        limit,
    })
}

fn search(request: Request) -> Result<Value, Box<dyn std::error::Error>> {
    if request.context > 20 || request.limit == 0 || request.limit > 1000 {
        return Err("invalid search context or limit".into());
    }
    let uri = request
        .path
        .strip_prefix("workspace://")
        .ok_or("unsupported workspace path")?;
    let (name, relative) = uri.split_once('/').unwrap_or((uri, ""));
    let root = request
        .roots
        .get(name)
        .and_then(Option::as_ref)
        .ok_or("workspace root is not configured")?;
    if !root.is_absolute() || relative.split('/').any(|p| p == "." || p == "..") {
        return Err("path traversal rejected".into());
    }
    let mut selected = root.clone();
    for part in Path::new(relative).components() {
        let Component::Normal(part) = part else {
            return Err("invalid search path".into());
        };
        selected.push(part);
        if std::fs::symlink_metadata(&selected)?
            .file_type()
            .is_symlink()
        {
            return Err("symlink path rejected".into());
        }
    }
    let metadata = std::fs::metadata(&selected)?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("expected a file or directory".into());
    }
    let matcher = RegexMatcherBuilder::new()
        .line_terminator(Some(b'\n'))
        .build(&request.pattern)?;
    let mut overrides = OverrideBuilder::new(root);
    if let Some(glob) = &request.glob {
        overrides.add(glob)?;
    }
    // 始终从工作区根遍历，保留内部祖先 ignore，同时剪掉选定路径以外的子树。
    let filter_path = selected.clone();
    let mut walk = WalkBuilder::new(root);
    walk.parents(false)
        .git_global(false)
        .follow_links(false)
        .overrides(overrides.build()?)
        .filter_entry(move |entry| {
            entry.path().starts_with(&filter_path) || filter_path.starts_with(entry.path())
        });
    let mut output = Output {
        path: PathBuf::new(),
        rows: Vec::new(),
        bytes: 2,
        matches: 0,
        limit: request.limit,
        limited: false,
        scanned: 0,
    };
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .before_context(request.context)
        .after_context(request.context)
        .binary_detection(BinaryDetection::quit(0))
        .heap_limit(Some(8 * 1024 * 1024))
        .build();
    for entry in walk.build() {
        let entry = entry?;
        if let Some(error) = entry.error() {
            return Err(error.clone().into());
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) || !entry.path().starts_with(&selected) {
            continue;
        }
        output.path = entry.path().to_owned();
        // 不跟随最终路径替换出的链接，也不让 FIFO 替换阻塞助手。
        let file: File = rustix::fs::open(
            entry.path(),
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )?
        .into();
        if !file.metadata()?.is_file() {
            return Err("search requires regular files".into());
        }
        searcher.search_file(&matcher, &file, &mut output)?;
        if output.limited {
            break;
        }
    }
    Ok(json!({"matches":output.rows,"limited":output.limited,
        "guidance":"Narrow path/pattern when limited; no matches is meaningful only when limited=false."}))
}

struct Output {
    path: PathBuf,
    rows: Vec<Value>,
    bytes: usize,
    matches: usize,
    limit: usize,
    limited: bool,
    scanned: usize,
}
impl Output {
    fn row(&mut self, line: Option<u64>, bytes: &[u8], kind: &str) -> io::Result<bool> {
        self.scanned = self.scanned.saturating_add(bytes.len());
        if kind == "match" {
            self.matches += 1;
        }
        let row = json!({"path":self.path.to_str(), "line":line,
            "text":std::str::from_utf8(bytes).ok(), "kind":kind});
        let size = serde_json::to_vec(&row)?.len() + 1;
        if self.matches > self.limit
            || bytes.len() > 65536
            || self.scanned > 8 * 1024 * 1024
            || self.bytes + size > 13000
        {
            self.limited = true;
            return Ok(false);
        }
        self.bytes += size;
        self.rows.push(row);
        Ok(true)
    }
}
impl Sink for Output {
    type Error = io::Error;
    fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> io::Result<bool> {
        self.row(mat.line_number(), mat.bytes(), "match")
    }
    fn context(&mut self, _: &Searcher, context: &SinkContext<'_>) -> io::Result<bool> {
        self.row(context.line_number(), context.bytes(), "context")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_respects_workspace_ignore_selection_and_bounds() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(temp.path().join(".ignore"), "keep.py\n").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.py\n").unwrap();
        std::fs::write(
            root.join("src/keep.py"),
            "before\nneedle 中文\nafter\nneedle\n",
        )
        .unwrap();
        std::fs::write(root.join("src/ignored.py"), "needle forbidden\n").unwrap();
        std::fs::write(root.join("outside.py"), "needle outside\n").unwrap();
        let mut request = json!({"path":"workspace://repo/src", "roots":{"repo":root}, "pattern":"needle", "context":1});
        let run = |request: &Value| execute(serde_json::from_value(request.clone()).unwrap());
        let result = run(&request).unwrap();
        assert_eq!(result["limited"], false);
        assert_eq!(result["matches"].as_array().unwrap().len(), 4);
        assert_eq!(result["matches"][1]["text"], "needle 中文\n");
        request["limit"] = json!(1);
        assert_eq!(run(&request).unwrap()["limited"], true);
        request["pattern"] = json!("absent");
        assert_eq!(run(&request).unwrap()["matches"], json!([]));
        request["pattern"] = json!("[");
        assert!(run(&request).is_err());
        request["pattern"] = json!("needle");
        std::os::unix::fs::symlink(root.join("src"), root.join("link")).unwrap();
        request["path"] = json!("workspace://repo/link");
        assert!(run(&request).unwrap_err().contains("symlink"));
    }
}
