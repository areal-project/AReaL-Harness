use super::*;

pub(super) async fn invoke(
    runtime: &RuntimeConfig,
    scope: &str,
    operation: &str,
    name: &str,
    args: &Value,
) -> rt::Result<(bool, Value)> {
    let mut request = args.clone();
    request["operation"] = json!(name);
    request["roots"] = json!({"repo":runtime.workspace,"scratch":runtime.command_scratch});
    let started = runtime
        .client
        .start(rt::StartProcess {
            operation_id: operation.into(),
            scope_id: scope.into(),
            argv: vec![
                "/usr/bin/python3".into(),
                "-I".into(),
                "-B".into(),
                "-c".into(),
                include_str!("navigation.py").into(),
                request.to_string(),
            ],
            cwd: "workspace://repo".into(),
            env: BTreeMap::new(),
            tty: false,
            pipe_stdin: false,
            limits: rt::LimitRequest {
                wall_time_ms: Some(15_000),
                ..Default::default()
            },
        })
        .await?;
    let mut after = None;
    let mut bytes = Vec::new();
    let mut stderr = Vec::new();
    let mut lost = false;
    loop {
        let page = runtime
            .client
            .output(rt::ReadOutput {
                process_id: started.process_id.clone(),
                after,
                max_bytes: rt::MAX_READ_BYTES,
                wait_ms: 1000,
            })
            .await?;
        lost |= page.gap || page.truncated;
        for chunk in page.chunks {
            if chunk.stream == rt::OutputStream::Stderr {
                if let Ok(chunk) = STANDARD.decode(&chunk.data_base64) {
                    stderr.extend(
                        chunk
                            .into_iter()
                            .take(2048usize.saturating_sub(stderr.len())),
                    );
                }
                continue;
            }
            if chunk.stream == rt::OutputStream::Stdout {
                let chunk = STANDARD.decode(chunk.data_base64).map_err(|_| {
                    rt::Error::new(rt::ErrorCode::Unavailable, "invalid navigation output")
                })?;
                if bytes.len() + chunk.len() > MAX_RESULT {
                    lost = true;
                } else {
                    bytes.extend(chunk);
                }
            }
        }
        after = Some(page.next_cursor);
        if page.closed {
            break;
        }
    }
    let done = runtime.client.wait(&started.process_id).await?;
    if lost || done.exit_code != Some(0) || done.stop_reason.is_some() {
        return Ok((
            false,
            json!({"error":"read/search process failed or exceeded its output/time bounds","state":done.state,"exitCode":done.exit_code,"stopReason":done.stop_reason,"stderr":String::from_utf8_lossy(&stderr)}),
        ));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| rt::Error::new(rt::ErrorCode::InvalidArgument, "invalid navigation result"))?;
    Ok(if value.get("error").is_some() {
        (false, value)
    } else {
        (true, value["result"].clone())
    })
}
