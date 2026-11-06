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
    request["roots"] = json!({"repo":runtime.workspace,"scratch":runtime.command_scratch,"host":if runtime.client.info().capabilities["fullAccess"] == true { Some("/") } else { None }});
    let argv = if name == "search_files" {
        let capability = &runtime.client.info().capabilities["builtinTools"]["searchFiles"];
        let helper = capability["path"]
            .as_str()
            .filter(|p| p.starts_with('/'))
            .filter(|_| capability["version"] == 1)
            .ok_or_else(|| {
                rt::Error::new(
                    rt::ErrorCode::Unsupported,
                    "Runtime has no embedded search; upgrade the complete Harness deployment",
                )
            })?;
        vec![helper.to_owned(), "--search".into(), request.to_string()]
    } else {
        vec![
            python_executable()?,
            "-I".into(),
            "-B".into(),
            "-c".into(),
            if name == "environment_info" {
                include_str!("environment.py")
            } else {
                include_str!("navigation.py")
            }
            .into(),
            request.to_string(),
        ]
    };
    let started = runtime
        .client
        .start_queued(rt::StartProcess {
            operation_id: operation.into(),
            scope_id: scope.into(),
            argv,
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
    let mut value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| rt::Error::new(rt::ErrorCode::InvalidArgument, "invalid navigation result"))?;
    add_search_guidance(name, &mut value);
    Ok(if value.get("error").is_some() {
        (false, value)
    } else {
        (true, value["result"].clone())
    })
}

fn add_search_guidance(name: &str, value: &mut Value) {
    if name == "search_files"
        && value["error"]
            .as_str()
            .is_some_and(|s| s.contains("regex parse error:"))
    {
        // 仅补充已知正则语法错误的用法提示；不改错误、不重试，也不掩盖权限或 IO 失败。
        value["guidance"] = json!(
            "pattern is a ripgrep regex. Correct its syntax; when using tool_program, put it in input rather than a JavaScript string. JSON example for a literal parenthesis: {\"pattern\":\"def fit\\\\(\"}. Resubmit only the corrected read, not earlier program edits."
        );
    }
}

pub(super) fn python_executable() -> rt::Result<String> {
    areal_runtime_host_tools::system_python()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| {
            rt::Error::new(
                rt::ErrorCode::Unavailable,
                format!("system Python is unavailable: {error}"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regex_guidance_preserves_error_and_does_not_reclassify_other_failures() {
        for (name, error, expected) in [
            ("search_files", "regex parse error: unclosed group", true),
            ("search_files", "permission denied", false),
            ("search_files", "invalid navigation result", false),
            ("read_file", "regex parse error: unclosed group", false),
        ] {
            let mut value = json!({"error":error});
            add_search_guidance(name, &mut value);
            assert_eq!(value["error"], error);
            assert_eq!(value.get("guidance").is_some(), expected);
        }
        let mut success = json!({"result":{"matches":[],"limited":false}});
        let before = success.clone();
        add_search_guidance("search_files", &mut success);
        assert_eq!(success, before);
    }
}
