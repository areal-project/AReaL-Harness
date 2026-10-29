//! Cloud 连接配置只解析后端和凭据引用，不要求本地模型或启动 Core。
use crate::{ConfigInputs, file, resolve};
use anyhow::{Result, bail, ensure};
use std::{io::Read, path::PathBuf};

#[derive(Default)]
pub struct CloudOverrides {
    pub url: Option<String>,
    pub token_file: Option<PathBuf>,
}

// 含凭据，不实现 Debug/Serialize，避免诊断输出泄漏。
pub struct CloudConfig {
    pub url: String,
    pub token: String,
}

pub fn load_cloud_config(inputs: &ConfigInputs, overrides: CloudOverrides) -> Result<CloudConfig> {
    let location = resolve::location(inputs)?;
    let file = file::read(&location.selected, location.explicit)?;
    let entry = |key: &str| file.values.get(key).map(|v| v.value.clone());
    let env = |key: &str| -> Result<Option<String>> {
        inputs
            .env
            .get(std::ffi::OsStr::new(key))
            .map(|v| {
                v.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow::anyhow!("Cloud environment value must be UTF-8"))
            })
            .transpose()
    };
    ensure!(
        !(entry("cloud.token_file").is_some() && entry("cloud.token_env").is_some()),
        "cloud.token_file and cloud.token_env are mutually exclusive"
    );
    let url = overrides
        .url
        .or(env("AREAL_CLOUD_URL")?)
        .or(entry("cloud.url"))
        .ok_or_else(|| anyhow::anyhow!("set cloud.url, AREAL_CLOUD_URL or --url"))?;
    let parsed = url::Url::parse(&url).map_err(|_| anyhow::anyhow!("invalid Cloud URL"))?;
    ensure!(
        matches!(parsed.scheme(), "http" | "https")
            && parsed.host_str().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none(),
        "Cloud URL must be HTTP(S), without credentials, query or fragment"
    );
    let external_file = overrides
        .token_file
        .or(env("AREAL_CLOUD_TOKEN_FILE")?.map(PathBuf::from));
    let token = if let Some(path) = external_file {
        read_token(&if path.is_absolute() {
            path
        } else {
            inputs.cwd.join(path)
        })?
    } else if let Some(value) = env("AREAL_CLOUD_TOKEN")? {
        value
    } else if let Some(path) = entry("cloud.token_file") {
        ensure!(
            !path.trim().is_empty(),
            "cloud.token_file must not be empty"
        );
        let path = PathBuf::from(path);
        read_token(&if path.is_absolute() {
            path
        } else {
            location.selected.parent().unwrap().join(path)
        })?
    } else {
        let name = entry("cloud.token_env").unwrap_or_else(|| "AREAL_CLOUD_TOKEN".into());
        ensure!(
            !name.is_empty()
                && name.bytes().enumerate().all(|(i, b)| b == b'_'
                    || b.is_ascii_alphabetic()
                    || (i > 0 && b.is_ascii_digit())),
            "invalid Cloud token environment reference"
        );
        env(&name)?
            .ok_or_else(|| anyhow::anyhow!("Cloud token environment reference is not set"))?
    };
    let token = token.trim().to_owned();
    ensure!(
        !token.is_empty()
            && token.len() <= 16384
            && token.bytes().all(|b| (0x20..=0x7e).contains(&b)),
        "invalid Cloud token"
    );
    Ok(CloudConfig { url, token })
}

fn read_token(path: &std::path::Path) -> Result<String> {
    let metadata =
        std::fs::metadata(path).map_err(|_| anyhow::anyhow!("cannot read Cloud token file"))?;
    ensure!(
        metadata.is_file() && metadata.len() <= 16384,
        "invalid Cloud token file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Cloud token file must not be accessible by group or others"
        );
    }
    let mut value = String::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(16385).read_to_string(&mut value))
        .map_err(|_| anyhow::anyhow!("cannot read Cloud token file"))?;
    if value.len() > 16384 {
        bail!("invalid Cloud token file");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(text: &str) -> (tempfile::TempDir, ConfigInputs) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, text).unwrap();
        let inputs = ConfigInputs {
            cwd: dir.path().into(),
            homedir: Some(dir.path().into()),
            config_file: Some(path),
            ..Default::default()
        };
        (dir, inputs)
    }
    #[test]
    fn cloud_only_config_and_custom_token_reference() {
        let (_dir, mut inputs) = fixture(
            "schema_version=1\n[cloud]\nurl='https://backend.test/openapi/v1'\ntoken_env='PRIVATE_CLOUD_TOKEN'\n",
        );
        inputs
            .env
            .insert("PRIVATE_CLOUD_TOKEN".into(), "secret".into());
        let config = load_cloud_config(&inputs, CloudOverrides::default()).unwrap();
        assert_eq!(config.token, "secret");
        assert_eq!(config.url, "https://backend.test/openapi/v1");
        inputs
            .env
            .insert("AREAL_CLOUD_URL".into(), "https://env.test".into());
        inputs
            .env
            .insert("AREAL_CLOUD_TOKEN".into(), "env-secret".into());
        let config = load_cloud_config(
            &inputs,
            CloudOverrides {
                url: Some("https://explicit.test".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(config.url, "https://explicit.test");
        assert_eq!(config.token, "env-secret");
    }
    #[test]
    fn relative_token_file_uses_config_directory() {
        let (dir, mut inputs) =
            fixture("schema_version=2\n[cloud]\nurl='https://backend.test'\ntoken_file='token'\n");
        let path = dir.path().join("token");
        std::fs::write(&path, "file-secret\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        inputs.cwd = dir.path().join("different-cwd");
        assert_eq!(
            load_cloud_config(&inputs, CloudOverrides::default())
                .unwrap()
                .token,
            "file-secret"
        );
        inputs.config_file = None;
        inputs
            .env
            .insert("AREAL_HARNESS_HOME".into(), dir.path().into());
        assert_eq!(
            load_cloud_config(&inputs, CloudOverrides::default())
                .unwrap()
                .token,
            "file-secret"
        );
    }
    #[test]
    fn invalid_config_never_echoes_secret() {
        for text in [
            "schema_version=1\n[cloud]\nurl='https://secret:secret@host'",
            "schema_version=1\n[cloud]\ntoken_file='secret'\ntoken_env='secret'",
            "schema_version=1\n[cloud]\ntoken='secret'",
        ] {
            let (_dir, inputs) = fixture(text);
            let err = load_cloud_config(&inputs, CloudOverrides::default())
                .err()
                .unwrap()
                .to_string();
            assert!(!err.contains("secret"), "{err}");
        }
    }
}
