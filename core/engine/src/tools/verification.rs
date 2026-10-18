use super::*;

pub(super) async fn attach(client: &Client, scope: &str, receipt: &str, result: &mut Value) {
    result["verification"] =
        json!({"receiptPath":receipt,"status":"pending","correctness":"not certified"});
    if result["state"] != "exited" {
        return;
    }
    match client
        .filesystem(rt::FileRequest {
            operation_id: client.operation_id(),
            scope_id: scope.into(),
            command: rt::FileCommand::Read {
                path: receipt.into(),
                offset: 0,
                max_bytes: rt::MAX_FILE_CHUNK,
            },
        })
        .await
    {
        Ok(reply) => {
            let parsed = reply["dataBase64"]
                .as_str()
                .and_then(|s| STANDARD.decode(s).ok())
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            if let Some(mut value) =
                parsed.filter(|v| v["schema"] == "areal.verification.v1" && reply["eof"] == true)
            {
                value.as_object_mut().unwrap().remove("outputTail");
                value.as_object_mut().unwrap().remove("argv");
                value["status"] = json!("complete");
                result["verification"] = value;
            } else {
                result["verification"]["status"] = json!("unavailable");
                result["verification"]["error"] =
                    json!("receipt malformed or too large; inspect the saved log");
            }
        }
        Err(error) => {
            result["verification"]["status"] = json!("unavailable");
            result["verification"]["error"] = json!(error.code);
        }
    }
}
