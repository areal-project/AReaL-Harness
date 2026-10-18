use serde::{Deserialize, Serialize};

pub const MAX_FILE_CHUNK: usize = 64 * 1024;
pub const MAX_EDIT_FILE: usize = 8 * 1024 * 1024;

/// 校验 workspace URI 命名空间之后的未编码后缀；不解析或授予命名空间权限。
/// 4096 字节上限包含前导斜线，不包含 `workspace://repo` 等命名空间。
pub fn workspace_relative_path(suffix: &str) -> crate::Result<&std::path::Path> {
    use std::path::{Component, Path};
    let invalid = |message| crate::Error::new(crate::ErrorCode::InvalidArgument, message);
    if !suffix.is_empty() && !suffix.starts_with('/') {
        return Err(invalid("workspace path suffix must begin with a slash"));
    }
    // v0 不做 URL 解码，防止解析器归一化掉越界证据。
    if suffix.contains(['%', '?', '#', '\\', '\0']) || suffix.len() > 4096 {
        return Err(invalid("unsupported workspace path encoding"));
    }
    let relative = Path::new(suffix.trim_start_matches('/'));
    if suffix.split('/').any(|part| part == "." || part == "..")
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid(
            "workspace paths cannot contain dot or parent components",
        ));
    }
    Ok(relative)
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRequest {
    pub operation_id: String,
    pub scope_id: String,
    pub command: FileCommand,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ExpectedFile {
    Absent,
    Sha256 { value: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPatch {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FileCommand {
    Read {
        path: String,
        #[serde(default)]
        offset: u64,
        max_bytes: usize,
    },
    Stat {
        path: String,
    },
    List {
        path: String,
        after: Option<String>,
        limit: usize,
    },
    Search {
        path: String,
        pattern: String,
        glob: Option<String>,
        context: usize,
        limit: usize,
    },
    Write {
        path: String,
        data_base64: String,
        expected: ExpectedFile,
    },
    StageFileChunk {
        path: String,
        upload_id: String,
        offset: u64,
        data_base64: String,
    },
    CommitFile {
        path: String,
        upload_id: String,
        expected: ExpectedFile,
        expected_executable: Option<bool>,
        sha256: String,
        executable: bool,
    },
    RemoveFile {
        path: String,
        expected_sha256: String,
        expected_executable: bool,
    },
    ApplyPatch {
        path: String,
        old_text: String,
        new_text: String,
        expected_sha256: String,
    },
    ApplyPatches {
        path: String,
        patches: Vec<TextPatch>,
        expected_sha256: String,
    },
}

impl FileCommand {
    pub fn path(&self) -> &str {
        match self {
            Self::Read { path, .. }
            | Self::Stat { path }
            | Self::List { path, .. }
            | Self::Search { path, .. }
            | Self::Write { path, .. }
            | Self::StageFileChunk { path, .. }
            | Self::CommitFile { path, .. }
            | Self::RemoveFile { path, .. }
            | Self::ApplyPatch { path, .. }
            | Self::ApplyPatches { path, .. } => path,
        }
    }
    pub fn path_mut(&mut self) -> &mut String {
        match self {
            Self::Read { path, .. }
            | Self::Stat { path }
            | Self::List { path, .. }
            | Self::Search { path, .. }
            | Self::Write { path, .. }
            | Self::StageFileChunk { path, .. }
            | Self::CommitFile { path, .. }
            | Self::RemoveFile { path, .. }
            | Self::ApplyPatch { path, .. }
            | Self::ApplyPatches { path, .. } => path,
        }
    }
    pub fn writes(&self) -> bool {
        matches!(
            self,
            Self::Write { .. }
                | Self::StageFileChunk { .. }
                | Self::CommitFile { .. }
                | Self::RemoveFile { .. }
                | Self::ApplyPatch { .. }
                | Self::ApplyPatches { .. }
        )
    }
}

/// Private helper envelope; never accepted as a caller-supplied authorization.
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileHelperRequest {
    pub root: String,
    pub command: FileCommand,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_suffix_preserves_literal_paths_and_bounds_the_leading_slash() {
        assert_eq!(
            workspace_relative_path("").unwrap(),
            std::path::Path::new("")
        );
        assert_eq!(
            workspace_relative_path("/folder with spaces/中文.txt").unwrap(),
            std::path::Path::new("folder with spaces/中文.txt")
        );
        assert!(workspace_relative_path(&format!("/{}", "a".repeat(4095))).is_ok());
        assert!(workspace_relative_path(&format!("/{}", "a".repeat(4096))).is_err());
        for suffix in [
            "relative",
            "/../outside",
            "/a/./b",
            "/name#part",
            "/name?part",
            "/name%part",
            "/%2e%2e/outside",
            "/a\\b",
            "/a\0b",
        ] {
            assert!(workspace_relative_path(suffix).is_err(), "{suffix:?}");
        }
    }
}
