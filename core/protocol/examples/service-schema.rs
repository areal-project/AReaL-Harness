use areal_protocol::service::*;
fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "protocolVersion": VERSION,
            "identity": schemars::schema_for!(Identity),
            "service": schemars::schema_for!(Service),
            "request": schemars::schema_for!(Request),
            "response": schemars::schema_for!(Response),
            "browserBootstrap": schemars::schema_for!(BrowserBootstrap),
            "browserBootstrapExchange": schemars::schema_for!(BrowserBootstrapExchange),
        }))
        .unwrap()
    );
}
