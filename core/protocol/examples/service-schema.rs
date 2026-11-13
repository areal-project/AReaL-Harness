use areal_protocol::service::*;
fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "protocolVersion": VERSION,
            "identity": schemars::schema_for!(Identity),
            "service": schemars::schema_for!(Service),
            "capabilities": schemars::schema_for!(Capabilities),
            "stopOperation": schemars::schema_for!(StopOperation),
            "request": schemars::schema_for!(Request),
            "response": schemars::schema_for!(Response),
        }))
        .unwrap()
    );
}
