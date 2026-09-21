//! One bounded file operation inside the Runtime-generated process sandbox.
use areal_runtime_protocol::*;
use serde_json::json;

fn main() {
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
