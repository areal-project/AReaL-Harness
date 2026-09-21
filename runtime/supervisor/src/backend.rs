use areal_runtime_protocol::{OutputStream, Result};
use async_trait::async_trait;
use std::{collections::BTreeMap, path::PathBuf};
use tokio::sync::mpsc;

/// 只由已通过准入的 Supervisor 构造，执行后端不能接收公开请求中的 sandbox 对象。
#[derive(Clone, Debug)]
pub struct Execution {
    pub process_id: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub read_roots: Vec<PathBuf>,
    pub write_roots: Vec<PathBuf>,
    /// Fixed deployment helper, never supplied through the public process API.
    pub trusted_executable: Option<PathBuf>,
    pub tty: bool,
    pub pipe_stdin: bool,
    pub network: areal_runtime_protocol::NetworkRequest,
}

#[derive(Debug)]
pub enum Event {
    Output(OutputStream, Vec<u8>),
    Exited {
        exit_code: Option<i32>,
        signal: Option<i32>,
        sandbox_denied: bool,
    },
    Closed,
}

/// start 的明确拒绝返回普通错误；传输错误使用 UNAVAILABLE，表示执行事实未知。
#[async_trait]
pub trait Backend: Send + Sync {
    /// 标识实际执行端的 OS 策略；测试/嵌入后端默认不宣称隔离能力。
    fn sandbox_profile(&self) -> &'static str {
        "unverified"
    }
    fn supports_input(&self) -> bool {
        false
    }
    async fn write(&self, _process_id: &str, _write_id: &str, _bytes: &[u8]) -> Result<()> {
        Err(areal_runtime_protocol::Error::new(
            areal_runtime_protocol::ErrorCode::Unsupported,
            "backend does not support process input",
        ))
    }
    fn supports_terminal_control(&self) -> bool {
        false
    }
    async fn resize(&self, _process_id: &str, _cols: u16, _rows: u16) -> Result<()> {
        Err(areal_runtime_protocol::Error::new(
            areal_runtime_protocol::ErrorCode::Unsupported,
            "backend does not support PTY resize",
        ))
    }
    async fn close_stdin(&self, _process_id: &str) -> Result<()> {
        Err(areal_runtime_protocol::Error::new(
            areal_runtime_protocol::ErrorCode::Unsupported,
            "backend does not support closing stdin",
        ))
    }
    async fn start(&self, execution: Execution) -> Result<mpsc::Receiver<Event>>;
    async fn terminate(&self, process_id: &str) -> Result<()>;
    async fn shutdown(&self) -> Result<()>;
}
