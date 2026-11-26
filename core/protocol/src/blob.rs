//! 工具媒体归属来自当前 Core 账本；供应商调用 ID 只用于兼容旧客户端。
#[derive(Debug)]
pub enum ToolBlobOwner {
    ByCallId {
        call_id: String,
        generation: String,
    },
    ByItem {
        turn_id: String,
        item_id: String,
        generation: String,
    },
}

impl ToolBlobOwner {
    pub fn generation(&self) -> &str {
        match self {
            Self::ByCallId { generation, .. } | Self::ByItem { generation, .. } => generation,
        }
    }

    pub fn matches(&self, turn: &str, item: &str, call: &str) -> bool {
        match self {
            Self::ByCallId { call_id, .. } => call_id == call,
            Self::ByItem {
                turn_id, item_id, ..
            } => turn_id == turn && item_id == item,
        }
    }
}
