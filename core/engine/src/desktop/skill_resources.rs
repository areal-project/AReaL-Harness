//! Skill 附件的受控普通文件读取。
//!
//! 对照方案沿用 Codex/Claude Code 的调用语义：Skill 主体由 `skill_load`
//! 激活，附件使用普通 `read_file`/`fs_read`。`areal://` URI 只在 Core 内部
//! 解析，仍复用当前 Turn 的 Skill 选择、插件版本和撤权检查，不能交给
//! Runtime 的 workspace 根解析器。
use super::skills::Skill;
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

const MAX_RESOURCE_BYTES: usize = 8 * 1024 * 1024;
const BYTE_PAGE: usize = 8192;
const FILE_RESULT_LIMIT: usize = 14_000;

pub(crate) fn is_skill_uri(path: &str) -> bool {
    path.starts_with("areal://skill/")
}

pub(crate) fn is_skill_resource_path(tool: &str, args: &Value) -> bool {
    matches!(tool, "read_file" | "fs_read") && args["path"].as_str().is_some_and(is_skill_uri)
}

fn parse_uri(path: &str) -> anyhow::Result<(VersionRef, String)> {
    let rest = path
        .strip_prefix("areal://skill/")
        .context("Skill resource URI must start with areal://skill/")?;
    let mut parts = rest.splitn(3, '/');
    let id = parts.next().context("Skill URI is missing id")?;
    let revision = parts.next().context("Skill URI is missing revision")?;
    let resource = parts.next().context("Skill URI is missing resource")?;
    anyhow::ensure!(
        super::valid_id(id) && super::valid_id(revision),
        "invalid Skill URI identity"
    );
    anyhow::ensure!(
        !resource.is_empty() && resource.len() <= 4096,
        "invalid Skill resource path"
    );
    let path = Path::new(resource);
    anyhow::ensure!(
        path.components()
            .all(|part| matches!(part, Component::Normal(_))),
        "Skill resource path must be relative and cannot traverse parent directories"
    );
    anyhow::ensure!(
        !path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("SKILL.md")),
        "SKILL_MAIN_REQUIRES_LOAD: use skill_load to load the complete SKILL.md"
    );
    Ok((
        VersionRef {
            id: id.into(),
            revision: revision.into(),
        },
        resource.into(),
    ))
}

async fn read_all(skill: &Skill, resource: &str) -> Result<(Vec<u8>, String)> {
    let page = skill
        .read(resource, 0, MAX_RESOURCE_BYTES + 1)
        .await
        .map_err(|error| invalid(format!("{error:#}")))?;
    if page.size > MAX_RESOURCE_BYTES || page.bytes.len() != page.size {
        return Err(invalid("skill resource exceeds the 8 MiB read limit"));
    }
    let hash = format!("{:x}", Sha256::digest(&page.bytes));
    Ok((page.bytes, hash))
}

fn check_hash(expected: Option<&str>, actual: &str) -> Result<()> {
    if expected.is_some_and(|value| value != actual) {
        return Err(invalid(
            "file changed since the requested read; read the new version before continuing",
        ));
    }
    Ok(())
}

fn line_parts(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split_inclusive('\n').collect()
    }
}

fn line_result(
    path: &str,
    hash: &str,
    lines: &[&str],
    offset: usize,
    next_line: usize,
    rows: Vec<Value>,
    fragment: Option<(usize, usize)>,
) -> Value {
    let total = lines.len();
    let eof = next_line > total;
    let mut result = json!({
        "path": path,
        "sha256": hash,
        "totalLines": total,
        "offset": offset,
        "lines": rows,
        "nextLine": next_line,
        "eof": eof,
        "truncated": !eof,
    });
    if let Some((number, column)) = fragment {
        result["nextColumn"] = json!(column);
        result["nextRead"] = json!({
            "path": path,
            "offset": number,
            "column": column,
            "expectedSha256": hash,
        });
    }
    result
}

fn read_file_result(
    path: &str,
    bytes: &[u8],
    hash: &str,
    offset: usize,
    limit: usize,
    column: usize,
) -> Result<Value> {
    if offset == 0 || limit == 0 || column == 0 {
        return Err(invalid("offset, limit and column must be positive"));
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| invalid("read_file accepts UTF-8 text only; use fs_read for binary bytes"))?;
    let lines = line_parts(&text);
    if column > 1 && offset > lines.len() {
        return Err(invalid("column is outside the requested source line"));
    }
    let first = lines.get(offset - 1).copied().unwrap_or("");
    let first_chars = first.chars().count();
    if column > 1 && column > first_chars {
        return Err(invalid("column is outside the requested source line"));
    }
    let first_skip = column - 1;
    let mut selected = Vec::<Value>::new();
    let mut next_line = offset;
    let mut fragment = None;
    for index in offset.saturating_sub(1)..lines.len().min(offset.saturating_sub(1) + limit) {
        let start = if index == offset - 1 { first_skip } else { 0 };
        let content: String = lines[index].chars().skip(start).collect();
        let mut row = json!({"number":index + 1,"text":content});
        if start > 0 {
            row["column"] = json!(start + 1);
            row["complete"] = json!(true);
        }
        let mut probe_rows = selected.clone();
        probe_rows.push(row.clone());
        let probe = line_result(path, hash, &lines, offset, index + 2, probe_rows, None);
        if probe.to_string().len() > FILE_RESULT_LIMIT {
            if selected.is_empty() {
                let chars: Vec<char> = content.chars().collect();
                let mut low = 0usize;
                let mut high = chars.len();
                while low < high {
                    let middle = low + (high - low).div_ceil(2);
                    let prefix: String = chars[..middle].iter().collect();
                    let mut partial = json!({"number":index + 1,"text":prefix,"column":start + 1,"complete":false});
                    if start == 0 {
                        partial.as_object_mut().unwrap().remove("column");
                    }
                    let candidate = line_result(
                        path,
                        hash,
                        &lines,
                        offset,
                        index + 1,
                        vec![partial],
                        Some((index + 1, start + middle + 1)),
                    );
                    if candidate.to_string().len() <= FILE_RESULT_LIMIT {
                        low = middle;
                    } else {
                        high = middle - 1;
                    }
                }
                if low == 0 {
                    return Err(invalid("file read metadata exceeds output budget"));
                }
                let prefix: String = chars[..low].iter().collect();
                let mut partial =
                    json!({"number":index + 1,"text":prefix,"column":start + 1,"complete":false});
                if start == 0 {
                    partial.as_object_mut().unwrap().remove("column");
                }
                selected = vec![partial];
                fragment = Some((index + 1, start + low + 1));
                next_line = index + 1;
            }
            break;
        }
        selected.push(row);
        next_line = index + 2;
    }
    Ok(line_result(
        path, hash, &lines, offset, next_line, selected, fragment,
    ))
}

impl Engine {
    pub(crate) async fn read_skill_resource_file(
        &self,
        thread_id: &str,
        turn_id: &str,
        tool: &str,
        args: &Value,
    ) -> Result<Value> {
        let path = args["path"]
            .as_str()
            .ok_or_else(|| invalid("path is required"))?;
        let (reference, resource) = parse_uri(path).map_err(invalid)?;
        let skill = self
            .skill_for_read(thread_id, Some(turn_id), &reference)
            .await?;
        let (bytes, hash) = read_all(&skill, &resource).await?;
        check_hash(args["expectedSha256"].as_str(), &hash)?;
        let result = if tool == "read_file" {
            read_file_result(
                path,
                &bytes,
                &hash,
                args["offset"].as_u64().unwrap_or(1) as usize,
                args["limit"].as_u64().unwrap_or(120) as usize,
                args["column"].as_u64().unwrap_or(1) as usize,
            )?
        } else if tool == "fs_read" {
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let max_bytes = args["maxBytes"].as_u64().unwrap_or(BYTE_PAGE as u64) as usize;
            if max_bytes == 0 || max_bytes > BYTE_PAGE {
                return Err(invalid("maxBytes must be 1..8192"));
            }
            if offset > bytes.len() {
                return Err(invalid("offset exceeds resource size"));
            }
            let end = offset.saturating_add(max_bytes).min(bytes.len());
            json!({
                "path": path,
                "dataBase64": STANDARD.encode(&bytes[offset..end]),
                "sha256": hash,
                "size": bytes.len(),
                "nextOffset": end,
                "eof": end == bytes.len(),
                "executable": false,
            })
        } else {
            return Err(invalid("Skill resources are read-only"));
        };
        self.record_skill_access(thread_id, &reference).await?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_parser_keeps_main_body_on_the_activation_path() {
        assert!(parse_uri("areal://skill/demo/v1/references/check.md").is_ok());
        for path in [
            "areal://skill/demo/v1/SKILL.md",
            "areal://skill/demo/v1/./SKILL.md",
            "areal://skill/demo/v1/../secret.txt",
        ] {
            assert!(parse_uri(path).is_err(), "{path}");
        }
    }

    #[test]
    fn ordinary_line_read_preserves_hash_and_explicit_continuation() {
        let text = "第一行\n第二行\n第三行\n";
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let first = read_file_result(
            "areal://skill/demo/v1/reference.md",
            text.as_bytes(),
            &hash,
            1,
            2,
            1,
        )
        .unwrap();
        assert_eq!(first["lines"][0]["text"], "第一行\n");
        assert_eq!(first["nextLine"], 3);
        assert_eq!(first["eof"], false);
        let second = read_file_result(
            "areal://skill/demo/v1/reference.md",
            text.as_bytes(),
            &hash,
            3,
            120,
            1,
        )
        .unwrap();
        assert_eq!(second["lines"][0]["text"], "第三行\n");
        assert_eq!(second["eof"], true);
    }
}
