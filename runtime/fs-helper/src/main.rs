//! One bounded file operation inside the Runtime-generated process sandbox.
use areal_runtime_protocol::*;
use serde_json::json;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--search") {
        let result = std::env::args()
            .nth(2)
            .ok_or_else(|| "missing search request".to_owned())
            .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
            .and_then(areal_runtime_fs::search::execute);
        println!(
            "{}",
            match result {
                Ok(value) => json!({"result":value}),
                Err(error) => json!({"error":error}),
            }
        );
        return;
    }
    let result = std::env::args()
        .nth(1)
        .ok_or_else(|| Error::new(ErrorCode::InvalidArgument, "missing helper request"))
        .and_then(|request| {
            serde_json::from_str(&request)
                .map_err(|_| Error::new(ErrorCode::InvalidArgument, "invalid helper request"))
        })
        .and_then(areal_runtime_fs::execute);
    println!(
        "{}",
        match result {
            Ok(value) => json!({"result": value}),
            Err(error) => json!({"error":error}),
        }
    );
}
