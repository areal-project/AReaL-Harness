//! 在解析输入前限制分配，并给适配器保留无媒体正文的拒绝原因。
use anyhow::{Context, Result};
use std::{io::Read, path::Path};

pub(super) fn read(path: &Path, receipt: Option<&Path>) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path).context("read turn input file")?;
    let limit = areal_protocol::MAX_FRAME_BYTES / 2;
    let size = file.metadata()?.len();
    let mut bytes = Vec::new();
    if size <= limit as u64 {
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    }
    let actual = size.max(bytes.len() as u64);
    if actual > limit as u64 {
        let outcome = serde_json::json!({"code":"INPUT_ENVELOPE_TOO_LARGE","class":"infrastructure","source":"cli_input","details":{"actualBytes":actual,"maxBytes":limit,"requestSent":false}});
        if let Some(receipt) = receipt {
            std::fs::write(receipt, serde_json::to_vec(&outcome)?)?;
        }
        anyhow::bail!(
            "INPUT_ENVELOPE_TOO_LARGE: turn input file exceeds 2 MiB ({actual} > {limit}); supply a small task entry and read attachments with tools"
        );
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_boundary_and_structured_rejection() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("input.json");
        let receipt = temp.path().join("error.json");
        for size in [
            areal_protocol::MAX_FRAME_BYTES / 2 - 1,
            areal_protocol::MAX_FRAME_BYTES / 2,
            areal_protocol::MAX_FRAME_BYTES / 2 + 1,
        ] {
            std::fs::write(&path, vec![b' '; size]).unwrap();
            let result = read(&path, Some(&receipt));
            assert_eq!(result.is_ok(), size <= areal_protocol::MAX_FRAME_BYTES / 2);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
        assert_eq!(value["code"], "INPUT_ENVELOPE_TOO_LARGE");
        assert_eq!(value["details"]["requestSent"], false);
    }
}
