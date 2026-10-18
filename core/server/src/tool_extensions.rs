use anyhow::{Context, Result, ensure};
use areal_engine::tools::ToolExtensions;
use std::{io::Read, path::Path};

pub fn load(path: Option<&Path>) -> Result<ToolExtensions> {
    let Some(path) = path else {
        return Ok(ToolExtensions::default());
    };
    ensure!(
        std::fs::metadata(path)
            .context("cannot access tool extensions file")?
            .is_file(),
        "tool extensions must be a regular file"
    );
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1024 * 1024, "tool extensions exceed 1 MiB");
    let extensions: ToolExtensions =
        serde_json::from_slice(&bytes).context("invalid tool extensions JSON")?;
    extensions.validate()?;
    Ok(extensions)
}
