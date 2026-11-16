//! 用户显式评价的可选接收端适配；不参与主会话或原始轨迹结算。
use super::*;
use std::time::Duration;

const MAX_REQUEST: usize = (16 << 20) + (128 << 10);

async fn bounded_json(mut response: reqwest::Response, maximum: usize) -> Result<Value> {
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= maximum as u64),
        "feedback_response_oversize"
    );
    let mut raw = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("feedback_response_incomplete"))?
    {
        anyhow::ensure!(
            raw.len().saturating_add(chunk.len()) <= maximum,
            "feedback_response_oversize"
        );
        raw.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&raw).map_err(|_| anyhow::anyhow!("feedback_response_invalid"))
}

fn supported(value: &Value) -> bool {
    value["schema_version"] == "arena.user-feedback/v1"
        && value["enabled"] == true
        && value["owner"]
            .as_str()
            .is_some_and(|owner| !owner.trim().is_empty())
}

fn feedback_endpoint(config: &TrajectoryConfig) -> Result<url::Url> {
    let mut url = endpoint(config)?;
    let path = url.path().trim_end_matches('/');
    let base = path
        .strip_suffix("/otlp/v1/logs")
        .or_else(|| path.strip_suffix("/v1/logs"))
        .context("feedback_endpoint_unsupported")?;
    let path = format!("{base}/external-feedback");
    url.set_path(&path);
    Ok(url)
}

fn active(config: &TrajectoryConfig) -> Result<bool> {
    if !config.enabled {
        return Ok(false);
    }
    let Some(control) = persisted_control(&config.spool_dir)? else {
        return Ok(false);
    };
    Ok(control.enabled
        && owns_control(config, &control)
        && destination(config) == destination(&control))
}

/// 凭据只在可信配置边界读取，Renderer 不能选择地址或自报安装身份。
pub fn request(config: &TrajectoryConfig, input: Option<Value>) -> Result<Value> {
    let config = config.clone();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(invoke(&config, input))
    })
    .join()
    .map_err(|_| anyhow::anyhow!("feedback_worker_failed"))?
}

async fn invoke(config: &TrajectoryConfig, input: Option<Value>) -> Result<Value> {
    if !active(config)? {
        anyhow::ensure!(input.is_none(), "feedback_export_disabled");
        return Ok(json!({"enabled":false,"connected":false}));
    }
    let url = feedback_endpoint(config)?;
    let identity = destination(config);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .build()?;
    let headers = worker::headers(config)?;
    let Some(mut input) = input else {
        let mut caps = url;
        caps.set_path(&format!("{}/capabilities", caps.path()));
        let response = match client.get(caps).headers(headers).send().await {
            Ok(value) if value.status().is_success() => value,
            _ => return Ok(json!({"enabled":true,"connected":false})),
        };
        let value = bounded_json(response, 16384).await?;
        let installation = queue::read::<String>(&config.spool_dir, "installation.json", 256)
            .ok()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok());
        let connected = supported(&value) && installation.is_some();
        return Ok(
            json!({"enabled":true,"connected":connected,"destination":identity,"account":value["owner"],"installation":installation,"max_context_bytes":value["max_context_bytes"]}),
        );
    };
    anyhow::ensure!(
        input["expected_destination"] == identity,
        "feedback_destination_changed"
    );
    let mut caps = url.clone();
    caps.set_path(&format!("{}/capabilities", caps.path()));
    let check = client
        .get(caps)
        .headers(headers.clone())
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("feedback_account_unavailable"))?;
    anyhow::ensure!(check.status().is_success(), "feedback_account_unavailable");
    let value = bounded_json(check, 16384).await?;
    anyhow::ensure!(
        supported(&value) && value["owner"] == input["expected_owner"],
        "feedback_account_changed"
    );
    input
        .as_object_mut()
        .context("invalid_feedback_request")?
        .remove("expected_destination");
    input
        .as_object_mut()
        .context("invalid_feedback_request")?
        .remove("expected_owner");
    let installation: String = queue::read(&config.spool_dir, "installation.json", 256)?;
    anyhow::ensure!(
        uuid::Uuid::parse_str(&installation).is_ok(),
        "feedback_installation_unavailable"
    );
    anyhow::ensure!(
        input["expected_installation"] == installation,
        "feedback_installation_changed"
    );
    input
        .as_object_mut()
        .context("invalid_feedback_request")?
        .remove("expected_installation");
    input["installation_id"] = json!(installation);
    let bytes = serde_json::to_vec(&input)?;
    anyhow::ensure!(bytes.len() <= MAX_REQUEST, "feedback_request_oversize");
    let response = client
        .post(url)
        .headers(headers)
        .header("content-type", "application/json")
        .body(bytes)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("feedback_submission_unknown"))?;
    anyhow::ensure!(
        response.status().is_success(),
        "feedback_http_{}",
        response.status().as_u16()
    );
    let receipt = bounded_json(response, 2 << 20).await?;
    anyhow::ensure!(
        receipt["feedback_id"] == input["feedback_id"] && receipt["rating"] == input["rating"],
        "feedback_receipt_mismatch"
    );
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn fixture(
        response: String,
    ) -> (
        tempfile::TempDir,
        TrajectoryConfig,
        std::thread::JoinHandle<()>,
    ) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let root = tempfile::tempdir().unwrap();
        let config:TrajectoryConfig=serde_json::from_value(json!({"enabled":true,"endpoint":format!("http://127.0.0.1:{port}/openapi/v1/otlp/v1/logs"),"spool_dir":root.path(),
            "max_disk_bytes":1024,"max_memory_bytes":1024,"max_batch_bytes":1024,"max_records":10,"max_retries":1,
            "retry_initial_seconds":1,"retry_max_seconds":1,"request_timeout_seconds":1,"upload_interval_ms":1})).unwrap();
        queue::directory(root.path()).unwrap();
        queue::atomic(
            root.path(),
            "control.json",
            &serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        queue::atomic(
            root.path(),
            "installation.json",
            &serde_json::to_vec(&uuid::Uuid::new_v4().to_string()).unwrap(),
        )
        .unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut input = [0; 4096];
            let size = socket.read(&mut input).unwrap();
            assert!(
                String::from_utf8_lossy(&input[..size])
                    .starts_with("GET /openapi/v1/external-feedback/capabilities ")
            );
            socket.write_all(response.as_bytes()).unwrap();
        });
        (root, config, worker)
    }

    #[test]
    fn capabilities_require_identified_account_and_do_not_follow_redirects() {
        for body in [
            json!({"schema_version":"arena.user-feedback/v1","enabled":true,"owner":"alice"}),
            json!({"schema_version":"arena.user-feedback/v1","enabled":true}),
        ] {
            let raw = body.to_string();
            let (_root, config, worker) = fixture(format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                raw.len(),
                raw
            ));
            let value = request(&config, None).unwrap();
            assert_eq!(value["connected"], body["owner"].is_string());
            worker.join().unwrap();
        }
        let(_root,config,worker)=fixture("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/credentials-must-stay-local\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into());
        assert_eq!(request(&config, None).unwrap()["connected"], false);
        worker.join().unwrap();
    }

    #[test]
    fn oversize_capabilities_are_rejected_before_body_allocation() {
        let (_root, config, worker) =
            fixture("HTTP/1.1 200 OK\r\nContent-Length: 17000\r\nConnection: close\r\n\r\n".into());
        assert!(
            request(&config, None)
                .unwrap_err()
                .to_string()
                .contains("oversize")
        );
        worker.join().unwrap();
    }
    #[test]
    fn endpoint_stays_on_configured_origin_and_does_not_add_otlp_suffix() {
        let mut config: TrajectoryConfig = serde_json::from_value(json!({"enabled":false,"endpoint":"","spool_dir":"/tmp/unused",
            "max_disk_bytes":1024,"max_memory_bytes":1024,"max_batch_bytes":1024,"max_records":10,"max_retries":1,
            "retry_initial_seconds":1,"retry_max_seconds":1,"request_timeout_seconds":1,"upload_interval_ms":1})).unwrap();
        config.endpoint = "https://example.test/openapi/v1/otlp/v1/logs".into();
        assert_eq!(
            feedback_endpoint(&config).unwrap().as_str(),
            "https://example.test/openapi/v1/external-feedback"
        );
        config.endpoint = "https://example.test:4318/v1/logs".into();
        assert_eq!(
            feedback_endpoint(&config).unwrap().as_str(),
            "https://example.test:4318/external-feedback"
        );
        config.endpoint = "https://user:password@example.test/v1/logs".into();
        assert!(feedback_endpoint(&config).is_err());
    }
}
