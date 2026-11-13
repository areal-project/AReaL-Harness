//! 离线历史查看器：只渲染已冻结内容，无脚本、网络请求或执行入口。
use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn render(thread: &Value, captured: u64, snapshot_id: &str) -> String {
    let title = thread["name"]
        .as_str()
        .or(thread["preview"].as_str())
        .unwrap_or("历史会话");
    let mut html = format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>{}</title><style>body{{margin:0;background:#181818;color:#e9e9e9;font:16px/1.65 system-ui,sans-serif}}main{{max-width:900px;margin:auto;padding:32px 24px}}header{{border-bottom:1px solid #444;padding-bottom:20px}}h1{{font-size:24px}}aside,small,summary{{color:#aaa}}article{{margin:28px 0}}.user{{background:#233c60;border-radius:16px;padding:16px}}pre{{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}}details{{border:1px solid #444;border-radius:8px;padding:12px;margin:12px 0}}summary{{cursor:pointer}}footer{{margin-top:40px;color:#aaa}}</style><main><header><h1>{}</h1><strong>只读历史快照</strong><aside>原后台与停止请求保持不变。未完成记录仍按原状态展示，不代表任务已结束；此页面不能发送消息或执行工具。</aside><small>快照时间（Unix 秒）：{} · 快照摘要：{}</small></header>",
        escape(title),
        escape(title),
        captured,
        escape(snapshot_id)
    );
    if let Some(turns) = thread["turns"].as_array() {
        for (n, turn) in turns.iter().enumerate() {
            html.push_str(&format!(
                "<article><small>第 {} 轮 · 原记录状态：{}</small>",
                n + 1,
                escape(turn["status"].as_str().unwrap_or("unknown"))
            ));
            for item in turn["items"].as_array().into_iter().flatten() {
                match item["type"].as_str() {
                    Some("agentMessage") => html.push_str(&format!(
                        "<pre>{}</pre>",
                        escape(item["text"].as_str().unwrap_or(""))
                    )),
                    Some("userMessage") => {
                        html.push_str("<section class=\"user\"><small>你</small>");
                        for content in item["content"].as_array().into_iter().flatten() {
                            if let Some(text) = content["text"].as_str() {
                                html.push_str(&format!("<pre>{}</pre>", escape(text)));
                            } else {
                                html.push_str("<p>附件记录（离线快照不加载附件）</p>");
                            }
                        }
                        html.push_str("</section>");
                    }
                    _ => html.push_str(&format!(
                        "<details><summary>{}</summary><pre>{}</pre></details>",
                        escape(item["type"].as_str().unwrap_or("记录详情")),
                        escape(&serde_json::to_string_pretty(item).unwrap_or_default())
                    )),
                }
            }
            html.push_str("</article>");
        }
    }
    html.push_str("<footer>本页仅包含会话自身及归档历史；引用会话与附件未加载。关闭页面即可退出。</footer></main></html>");
    html
}

pub fn export(service: &Path, thread: &str, output: &Path) -> Result<Value> {
    let snapshot = areal_host::read_history_snapshot(service, thread)?;
    let captured = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let html = render(
        &serde_json::to_value(snapshot.conversation.thread())?,
        captured,
        snapshot.conversation.snapshot_id(),
    );
    let parent = output.parent().context("output directory missing")?;
    let meta = std::fs::symlink_metadata(parent)?;
    use std::os::unix::fs::MetadataExt;
    anyhow::ensure!(
        meta.is_dir()
            && meta.uid() == unsafe { libc::geteuid() }
            && meta.mode() & 0o077 == 0
            && parent.canonicalize()? == parent,
        "output requires an existing private canonical directory (mode 700)"
    );
    // 不覆盖旧文件，也不跟随链接；正文永不进入 stdout。
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(output)?;
    file.write_all(html.as_bytes())?;
    file.sync_all()?;
    Ok(
        serde_json::json!({"readOnly":true,"path":output,"snapshotId":snapshot.conversation.snapshot_id(),"capturedAt":captured,"turns":snapshot.conversation.thread().turns.len(),"serviceGeneration":snapshot.service_generation}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_history_escapes_messages_and_tool_output_and_has_no_execution() {
        let html = render(
            &serde_json::json!({"preview":"<script>x</script>","turns":[{"status":"inProgress","items":[{"type":"userMessage","content":[{"text":"<img src=x onerror=evil()>"}]},{"type":"agentMessage","text":"hello & goodbye"},{"type":"tool","text":"</pre><script>evil()</script>"}]}]}),
            1,
            "digest",
        );
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("hello &amp; goodbye"));
        assert!(html.contains("inProgress"));
        assert!(html.contains("default-src 'none'"));
    }
}
