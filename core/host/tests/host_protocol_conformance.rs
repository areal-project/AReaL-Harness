#[path = "../../protocol/generated/host_protocol.rs"]
mod generated;
#[allow(dead_code)]
#[path = "../src/wire.rs"]
mod wire;

use serde_json::{Value, json};
use tokio::io::BufReader;

fn hello() -> Value {
    json!({
        "version": 1,
        "id": "hello-conformance",
        "method": "hello",
        "params": {"protocolVersions": [1], "capabilities": [], "authToken": "isolated-test"}
    })
}

#[tokio::test]
async fn generated_hello_crosses_the_actual_local_wire_and_request_owner() {
    let value = hello();
    let generated: generated::LocalHelloRequest = serde_json::from_value(value.clone()).unwrap();
    let mut bytes = Vec::new();
    wire::write(&mut bytes, &generated).await.unwrap();
    assert_eq!(bytes.last(), Some(&b'\n'));
    assert_eq!(bytes.iter().filter(|&&byte| byte == b'\n').count(), 1);
    let observed = wire::read(&mut BufReader::new(bytes.as_slice()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed, value);
    let owner: wire::Request = serde_json::from_value(observed).unwrap();
    assert_eq!(owner.version, 1);
    assert_eq!(owner.id, "hello-conformance");
    assert_eq!(owner.method, "hello");
    let params: generated::LocalHelloParams = serde_json::from_value(owner.params).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), value["params"]);
}

#[test]
fn generated_envelope_and_actual_request_owner_reject_unknown_and_missing_fields() {
    let mut unknown = hello();
    unknown["unexpected"] = json!(true);
    assert!(serde_json::from_value::<wire::Request>(unknown.clone()).is_err());
    assert!(serde_json::from_value::<generated::LocalHelloRequest>(unknown).is_err());
    for field in ["version", "id", "method", "params"] {
        let mut missing = hello();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<wire::Request>(missing.clone()).is_err());
        assert!(serde_json::from_value::<generated::LocalHelloRequest>(missing).is_err());
    }
    let mut params = hello()["params"].clone();
    params["unexpected"] = json!(true);
    assert!(serde_json::from_value::<generated::LocalHelloParams>(params).is_err());
}

#[tokio::test]
async fn actual_local_frame_budget_counts_utf8_bytes_and_the_line_feed() {
    assert_eq!(wire::MAX_FRAME, 1_048_576);
    let mut value = json!({"text": "界".repeat((wire::MAX_FRAME - 12) / 3)});
    let padding = wire::MAX_FRAME - serde_json::to_vec(&value).unwrap().len() - 1;
    value["text"] = json!(format!(
        "{}{}",
        value["text"].as_str().unwrap(),
        "x".repeat(padding)
    ));
    assert_eq!(
        serde_json::to_vec(&value).unwrap().len() + 1,
        wire::MAX_FRAME
    );
    let mut bytes = Vec::new();
    wire::write(&mut bytes, &value).await.unwrap();
    assert_eq!(bytes.len(), wire::MAX_FRAME);
    let mut reader = BufReader::with_capacity(7, bytes.as_slice());
    assert_eq!(wire::read(&mut reader).await.unwrap(), Some(value.clone()));
    assert!(wire::read(&mut reader).await.unwrap().is_none());

    let over = json!({"text": format!("{}x", value["text"].as_str().unwrap())});
    let mut output = Vec::new();
    assert!(wire::write(&mut output, &over).await.is_err());
    assert!(
        output.is_empty(),
        "oversize output must not publish a partial frame"
    );
    let mut bytes = serde_json::to_vec(&over).unwrap();
    bytes.push(b'\n');
    assert_eq!(bytes.len(), wire::MAX_FRAME + 1);
    assert!(
        wire::read(&mut BufReader::with_capacity(11, bytes.as_slice()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn actual_local_reader_rejects_truncated_invalid_utf8_and_unbounded_frames() {
    for bytes in [b"{\"x\":1}".as_slice(), b"\"\xff\"\n".as_slice()] {
        assert!(wire::read(&mut BufReader::new(bytes)).await.is_err());
    }
    let bytes = vec![b' '; wire::MAX_FRAME + 1];
    assert!(
        wire::read(&mut BufReader::with_capacity(13, bytes.as_slice()))
            .await
            .is_err()
    );
}
