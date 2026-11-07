//! Runtime 生成视图，Core 只接收有界结果并登记模型媒体；不传输或自行解码原图。
use super::*;

fn invalid(error: impl std::fmt::Display) -> rt::Error {
    rt::Error::new(rt::ErrorCode::Unavailable, error.to_string())
}

pub(super) async fn read(
    engine: &Engine,
    runtime: &RuntimeConfig,
    scope: &str,
    operation: &str,
    args: &Value,
) -> rt::Result<(bool, Value)> {
    if runtime.client.info().capabilities["runtimeImageViewsV1"] != true {
        return Err(rt::Error::new(
            rt::ErrorCode::Unsupported,
            "image_read requires a matching Runtime with runtimeImageViewsV1; no source-transfer fallback was executed",
        ));
    }
    let path = resource_uri(
        args["path"]
            .as_str()
            .ok_or_else(|| invalid("path required"))?,
        runtime,
    )
    .map_err(invalid)?;
    let mut options = args.clone();
    let fields = options
        .as_object_mut()
        .ok_or_else(|| invalid("image options must be an object"))?;
    fields.remove("path");
    fields.remove("permissionRequest");
    let options: rt::ImageViewOptions = serde_json::from_value(options).map_err(invalid)?;
    let response = runtime
        .client
        .filesystem(rt::FileRequest {
            operation_id: operation.into(),
            scope_id: scope.into(),
            command: rt::FileCommand::ReadImage {
                path: path.clone(),
                options,
            },
        })
        .await?;
    let reference = &response["imageOutput"];
    let process = reference["processId"]
        .as_str()
        .ok_or_else(|| invalid("missing Runtime image output"))?;
    let expected = reference["bytes"]
        .as_u64()
        .filter(|n| *n <= rt::MAX_IMAGE_RESPONSE_BYTES as u64)
        .ok_or_else(|| invalid("invalid Runtime image output length"))? as usize;
    let info = owned_process(&runtime.client, scope, process).await?;
    if info.state != rt::ProcessState::Exited
        || info.exit_code != Some(0)
        || info.stop_reason.is_some()
    {
        return Err(invalid(
            "Runtime image preprocessing is not successfully complete",
        ));
    }
    let mut bytes = Vec::new();
    let mut after = None;
    loop {
        let page = runtime
            .client
            .output(rt::ReadOutput {
                process_id: process.into(),
                after: after.clone(),
                max_bytes: rt::MAX_READ_BYTES,
                wait_ms: 0,
            })
            .await?;
        if page.gap || page.truncated {
            return Err(invalid("Runtime image output is incomplete"));
        }
        for chunk in page.chunks {
            if chunk.stream != rt::OutputStream::Stdout {
                return Err(invalid("unexpected Runtime image diagnostic stream"));
            }
            let data = STANDARD.decode(chunk.data_base64).map_err(invalid)?;
            if bytes.len().saturating_add(data.len()) > expected {
                return Err(invalid("Runtime image output exceeded its receipt"));
            }
            bytes.extend(data);
        }
        if page.closed {
            break;
        }
        if after.as_ref() == Some(&page.next_cursor) {
            return Err(invalid("Runtime image read did not advance"));
        }
        after = Some(page.next_cursor);
    }
    if bytes.len() != expected {
        return Err(invalid("Runtime image output length mismatch"));
    }
    let envelope: Value = serde_json::from_slice(&bytes).map_err(invalid)?;
    let mut metadata = envelope["result"].clone();
    let views = metadata["views"]
        .as_array_mut()
        .filter(|v| !v.is_empty() && v.len() <= 3)
        .ok_or_else(|| invalid("invalid Runtime image views"))?;
    let mut items = Vec::new();
    for view in views {
        let encoded = view
            .as_object_mut()
            .ok_or_else(|| invalid("invalid Runtime image view"))?
            .remove("dataBase64")
            .ok_or_else(|| invalid("missing Runtime image pixels"))?;
        let png = STANDARD
            .decode(
                encoded
                    .as_str()
                    .ok_or_else(|| invalid("invalid Runtime image encoding"))?,
            )
            .map_err(invalid)?;
        if png.len() > 1024 * 1024 || view["outputBytes"].as_u64() != Some(png.len() as u64) {
            return Err(invalid("Runtime image view size mismatch"));
        }
        let media = engine
            .store
            .save_blob("image/png".into(), png)
            .await
            .map_err(invalid)?;
        view["media"] = json!(media);
        items.push(json!({"type":"arealMedia","modality":"image","media":media}));
    }
    metadata["path"] = json!(path);
    metadata["runtimeOutputBytes"] = json!(expected);
    metadata["preprocessLocation"] = json!("runtime");
    for field in ["sourceDimensions", "outputDimensions", "media"] {
        metadata[field] = metadata["views"][0][field].clone();
    }
    items.insert(0, json!({"type":"inputText","text":metadata.to_string()}));
    Ok((true, json!({"contentItems":items})))
}
