use serde::{Deserialize, Serialize};

pub const MAX_FILE_CHUNK: usize = 64 * 1024;
pub const MAX_EDIT_FILE: usize = 8 * 1024 * 1024;

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
    Write {
        path: String,
        data_base64: String,
        expected: ExpectedFile,
    },
    ApplyPatch {
        path: String,
        old_text: String,
        new_text: String,
        expected_sha256: String,
    },
}

impl FileCommand {
    pub fn path(&self) -> &str {
        match self {
            Self::Read { path, .. }
            | Self::Stat { path }
            | Self::List { path, .. }
            | Self::Write { path, .. }
            | Self::ApplyPatch { path, .. } => path,
        }
    }
    pub fn path_mut(&mut self) -> &mut String {
        match self {
            Self::Read { path, .. }
            | Self::Stat { path }
            | Self::List { path, .. }
            | Self::Write { path, .. }
            | Self::ApplyPatch { path, .. } => path,
        }
    }
    pub fn writes(&self) -> bool {
        matches!(self, Self::Write { .. } | Self::ApplyPatch { .. })
    }
}

/// Private helper envelope; never accepted as a caller-supplied authorization.
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileHelperRequest {
    pub root: String,
    pub command: FileCommand,
}
