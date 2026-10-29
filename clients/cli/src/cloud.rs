//! Cloud Task 客户端：只提交与读取远端任务，不启动本地 Core 或同步 Harness。
use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand};
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf, time::Duration};

#[derive(Args)]
pub struct Options {
    /// Cloud 配置文件，沿用 AREAL_HARNESS_CONFIG 和默认配置目录。
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// 后端 API 基地址，例如 https://backend.example/openapi/v1。
    #[arg(long, env = "AREAL_CLOUD_URL", global = true)]
    url: Option<String>,
    /// 包含原始 token 的私有文件；省略时读取 AREAL_CLOUD_TOKEN。
    #[arg(long, env = "AREAL_CLOUD_TOKEN_FILE", global = true)]
    token_file: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 提交无状态任务；不挂载本地目录，不指定 Harness。
    Exec {
        /// 省略时从 stdin 读取 prompt。
        prompt: Option<String>,
        #[arg(long)]
        no_wait: bool,
        #[arg(long, default_value_t = 900)]
        timeout_seconds: u64,
        /// 保留此标识以核对未知提交；客户端不自动重发。
        #[arg(long)]
        request_id: Option<String>,
    },
    /// 读取任务作业状态。
    Status { job_id: String },
    /// 读取已完成任务结果与产物清单。
    Result { task_id: String },
    /// 下载指定产物并校验字节摘要，不覆盖已有文件。
    Artifact {
        task_id: String,
        name: String,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = 1)]
        attempt: u32,
    },
}

struct Backend {
    url: Url,
    token: String,
    client: Client,
}

fn base_url(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw).context("invalid Cloud URL")?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Cloud URL must be HTTP(S), without credentials, query or fragment"
    );
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    Ok(url)
}

impl Backend {
    #[cfg(test)]
    fn new(url: &str, token_file: Option<&PathBuf>) -> Result<Self> {
        let home = tempfile::tempdir()?;
        let inputs = areal_config::ConfigInputs {
            cwd: std::env::current_dir()?,
            homedir: Some(home.path().to_path_buf()),
            ..Default::default()
        };
        let config = areal_config::cloud::load_cloud_config(
            &inputs,
            areal_config::cloud::CloudOverrides {
                url: Some(url.into()),
                token_file: token_file.cloned(),
            },
        )?;
        Self::from_config(config)
    }
    fn from_config(config: areal_config::cloud::CloudConfig) -> Result<Self> {
        Ok(Self {
            url: base_url(&config.url)?,
            token: config.token,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(120))
                .build()?,
        })
    }
    fn resource(&self, segments: &[&str]) -> Result<Url> {
        let mut url = self.url.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("invalid Cloud base path"))?;
            path.pop_if_empty();
            for segment in segments {
                ensure!(
                    !segment.is_empty() && !matches!(*segment, "." | ".."),
                    "invalid Cloud resource ID"
                );
                path.push(segment);
            }
        }
        // URL 路径段默认保留冒号，但网关会将其解释为路由语法。
        // 在路径段转义后补编码，不改变 ID 中原有百分号和斜杠的含义。
        url.set_path(&url.path().replace(':', "%3A"));
        Ok(url)
    }
    async fn request(
        &self,
        method: Method,
        segments: &[&str],
        body: Option<Value>,
        request_id: Option<&str>,
    ) -> Result<Value> {
        let url = self.resource(segments)?;
        let mut request = self
            .client
            .request(method.clone(), url)
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(id) = request_id {
            request = request.header("Idempotency-Key", id);
        }
        let mut response = request.send().await.map_err(|_| anyhow::anyhow!(
            if method == Method::GET { "Cloud network request failed" } else { "Cloud submission outcome unknown; retain the request ID and do not resubmit automatically" }
        ))?;
        ensure!(
            response.status().is_success(),
            "Cloud request failed (HTTP {})",
            response.status().as_u16()
        );
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("Cloud response interrupted; submission may be unknown"))?
        {
            ensure!(
                data.len() + chunk.len() <= 8 * 1024 * 1024,
                "Cloud response exceeds 8 MiB"
            );
            data.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&data).context("invalid Cloud JSON response")
    }
    async fn result(&self, task_id: &str) -> Result<Value> {
        let result = self
            .request(Method::GET, &["tasks", task_id, "result"], None, None)
            .await?;
        let artifacts = self
            .request(Method::GET, &["tasks", task_id, "artifacts"], None, None)
            .await?;
        Ok(json!({ "task_id": task_id, "result": result, "artifacts": artifacts }))
    }
    async fn artifact(
        &self,
        task_id: &str,
        name: &str,
        output: PathBuf,
        attempt: u32,
    ) -> Result<Value> {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        ensure!(attempt > 0, "attempt must be positive");
        ensure!(!output.exists(), "output already exists");
        let parent = output
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(std::path::Path::new("."));
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        let mut url = self.resource(&["tasks", task_id, "artifacts", name])?;
        url.query_pairs_mut()
            .append_pair("attempt", &attempt.to_string());
        let mut response = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Cloud artifact request failed"))?;
        ensure!(
            response.status().is_success(),
            "Cloud artifact failed (HTTP {})",
            response.status().as_u16()
        );
        let mut size = 0usize;
        let mut hash = Sha256::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("Cloud artifact transfer interrupted"))?
        {
            size += chunk.len();
            ensure!(size <= 256 * 1024 * 1024, "Cloud artifact exceeds 256 MiB");
            hash.update(&chunk);
            file.write_all(&chunk)?;
        }
        file.as_file().sync_all()?;
        file.persist_noclobber(&output)?;
        Ok(json!({"path":output,"bytes":size,"sha256":format!("{:x}",hash.finalize())}))
    }
}

pub async fn run(options: Options) -> Result<()> {
    let inputs = areal_config::ConfigInputs {
        cwd: std::env::current_dir()?,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file: options.config,
        ..Default::default()
    };
    let config = areal_config::cloud::load_cloud_config(
        &inputs,
        areal_config::cloud::CloudOverrides {
            url: options.url,
            token_file: options.token_file,
        },
    )?;
    let backend = Backend::from_config(config)?;
    match options.command {
        Command::Artifact {
            task_id,
            name,
            output,
            attempt,
        } => {
            crate::run::emit(&backend.artifact(&task_id, &name, output, attempt).await?)?;
        }
        Command::Status { job_id } => {
            let job = backend
                .request(Method::GET, &["jobs", &job_id], None, None)
                .await?;
            let value = job.get("job").unwrap_or(&job);
            crate::run::emit(&json!({ "job_id": job_id, "status": value.get("status") }))?;
        }
        Command::Result { task_id } => {
            crate::run::emit(&backend.result(&task_id).await?)?;
        }
        Command::Exec {
            prompt,
            no_wait,
            timeout_seconds,
            request_id,
        } => {
            let prompt = match prompt {
                Some(value) => value,
                None => {
                    let mut value = String::new();
                    std::io::stdin()
                        .take(1024 * 1024 + 1)
                        .read_to_string(&mut value)?;
                    value
                }
            };
            ensure!(
                !prompt.trim().is_empty() && prompt.len() <= 1024 * 1024,
                "prompt must be between 1 byte and 1 MiB"
            );
            ensure!(
                (1..=86400).contains(&timeout_seconds),
                "timeout must be 1..86400 seconds"
            );
            let id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            ensure!(
                uuid::Uuid::parse_str(&id).is_ok(),
                "request ID must be a UUID"
            );
            eprintln!("Cloud request ID: {id}");
            let accepted = backend
                .request(
                    Method::POST,
                    &["harness-tasks"],
                    Some(json!({ "prompt": prompt })),
                    Some(&id),
                )
                .await?;
            crate::run::emit(&accepted)?;
            if no_wait {
                return Ok(());
            }
            let job_id = accepted
                .get("job_id")
                .and_then(Value::as_str)
                .context("Cloud acceptance missing job_id")?;
            let task_id = accepted
                .get("task_id")
                .and_then(Value::as_str)
                .context("Cloud acceptance missing task_id")?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_seconds);
            loop {
                let job = tokio::time::timeout_at(
                    deadline,
                    backend.request(Method::GET, &["jobs", job_id], None, None),
                )
                .await
                .context(
                    "Cloud wait timed out; task may still run remotely; use cloud status/result",
                )??;
                let job = job.get("job").unwrap_or(&job);
                match job.get("status").and_then(Value::as_str) {
                    Some("DONE") => {
                        let value = backend.result(task_id).await?;
                        crate::run::emit(&value)?;
                        ensure!(
                            value["result"]["status"] == "OK",
                            "Cloud task finished without an OK result"
                        );
                        break;
                    }
                    Some("FAILED" | "CANCELLED" | "CANCELED") => {
                        bail!("Cloud job ended without success; inspect cloud status/result")
                    }
                    _ => {
                        tokio::time::sleep_until(
                            (tokio::time::Instant::now() + Duration::from_secs(2)).min(deadline),
                        )
                        .await
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn http_fixture(status: &str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/api", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            loop {
                let mut buffer = [0u8; 4096];
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                raw.extend_from_slice(&buffer[..count]);
                if let Some(end) = raw.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .map(|value| value.parse::<usize>().unwrap())
                        .unwrap_or(0);
                    if raw.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(raw).unwrap()
        });
        (address, task)
    }

    fn token_file() -> tempfile::NamedTempFile {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"private-fixture-token").unwrap();
        file
    }

    #[test]
    fn urls_preserve_api_path_and_reject_embedded_credentials() {
        assert_eq!(
            base_url("https://backend.test/openapi/v1")
                .unwrap()
                .as_str(),
            "https://backend.test/openapi/v1/"
        );
        for url in [
            "ftp://backend.test",
            "https://user:secret@backend.test",
            "https://backend.test?token=secret",
            "https://backend.test#fragment",
        ] {
            assert!(base_url(url).is_err());
        }
    }

    #[tokio::test]
    async fn exec_sends_only_prompt_and_accepts_without_starting_local_core() {
        let (url, receipt) = http_fixture(
            "202 Accepted",
            r#"{"accepted":true,"job_id":"job","task_id":"task"}"#,
        )
        .await;
        let file = token_file();
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("cloud.toml");
        std::fs::write(
            &config,
            format!(
                "schema_version = 1\n[cloud]\nurl = {url:?}\ntoken_file = {:?}\n",
                file.path().to_str().unwrap()
            ),
        )
        .unwrap();
        run(Options {
            config: Some(config),
            url: None,
            token_file: None,
            command: Command::Exec {
                prompt: Some("write an artifact".into()),
                no_wait: true,
                timeout_seconds: 30,
                request_id: Some("b4784903-60eb-442f-a7c2-80654a969b98".into()),
            },
        })
        .await
        .unwrap();
        let request = receipt.await.unwrap();
        assert!(request.starts_with("POST /api/harness-tasks HTTP/1.1"));
        assert!(request.contains("idempotency-key: b4784903-60eb-442f-a7c2-80654a969b98"));
        assert_eq!(
            serde_json::from_str::<Value>(request.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            json!({"prompt":"write an artifact"})
        );
    }

    #[tokio::test]
    async fn refusal_does_not_echo_secrets_or_follow_redirects() {
        let (url, receipt) = http_fixture(
            "302 Found\r\nLocation: https://another.example/steal",
            "private-fixture-token",
        )
        .await;
        let file = token_file();
        let backend = Backend::new(&url, Some(&file.path().to_path_buf())).unwrap();
        let error = backend
            .request(
                Method::POST,
                &["harness-tasks"],
                Some(json!({"prompt":"hello"})),
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Cloud request failed (HTTP 302)");
        receipt.await.unwrap();
    }

    #[tokio::test]
    async fn task_result_escapes_colons_for_gateway_routes() {
        let (url, receipt) = http_fixture("200 OK", r#"{"status":"OK"}"#).await;
        let token = token_file();
        let backend = Backend::new(&url, Some(&token.path().to_path_buf())).unwrap();
        backend
            .request(Method::GET, &["tasks", "job:env:0", "result"], None, None)
            .await
            .unwrap();
        assert!(
            receipt
                .await
                .unwrap()
                .starts_with("GET /api/tasks/job%3Aenv%3A0/result HTTP/1.1")
        );
        assert_eq!(
            backend
                .resource(&["tasks", "job%3Aenv:0", "artifacts", "dir/file.txt"])
                .unwrap()
                .path(),
            "/api/tasks/job%253Aenv%3A0/artifacts/dir%2Ffile.txt"
        );
    }

    #[tokio::test]
    async fn artifact_download_preserves_bytes_and_never_overwrites() {
        let content = "artifact\0内容\n";
        let (url, receipt) = http_fixture("200 OK", content).await;
        let token = token_file();
        let backend = Backend::new(&url, Some(&token.path().to_path_buf())).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("output.bin");
        let result = backend
            .artifact("task:one", "output.bin", output.clone(), 1)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), content.as_bytes());
        assert_eq!(result["bytes"], content.len());
        assert!(
            receipt
                .await
                .unwrap()
                .starts_with("GET /api/tasks/task%3Aone/artifacts/output.bin?attempt=1 HTTP/1.1")
        );
        assert!(
            backend
                .artifact("task:one", "output.bin", output.clone(), 1)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(output).unwrap(), content.as_bytes());
    }

    #[cfg(unix)]
    #[test]
    fn public_token_files_are_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let file = token_file();
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Backend::new("https://backend.test", Some(&file.path().to_path_buf())).is_err());
    }
}
