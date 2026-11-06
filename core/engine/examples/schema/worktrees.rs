//! Core 工作树协议的有界输入与原生命周期投影。
use serde_json::{Value, json};
fn string() -> Value {
    json!({"type":"string","maxLength":4096})
}
fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
pub fn operation() -> Value {
    let record = object(
        json!({"requestId":string(),"directory":string(),"target":string(),"sourceCwd":string(),"relativeCwd":string(),"sourceHead":string(),"source":{"enum":["head","branch"]},"sourceRef":{"type":["string","null"],"maxLength":4096},"base":string(),"branch":string(),"cwd":string(),"commonDir":string(),"copied":{"type":"array","items":string(),"maxItems":65536},"createdAt":string()}),
        &["directory", "target", "base", "branch"],
    );
    let mut operation = object(
        json!({"kind":{"enum":["thread","checkout"]},"requestId":string(),"projectId":string(),"parameters":{"type":"object","maxProperties":32},"state":{"enum":["creating","created","binding","settingUp","ready","cancelled","failed","unknown"]},"record":record,"events":{"type":"array","maxItems":65536,"items":object(json!({"id":string(),"state":string(),"time":string(),"message":string()}),&["id","state","time"])},"deleted":{"type":"boolean"},"deletedAt":string(),"createdAt":string(),"message":string()}),
        &["kind", "requestId", "projectId", "parameters", "state"],
    );
    // 原生命周期记录允许领域扩展字段，不能为导入旧工作树删掉未识别事实。
    operation["additionalProperties"] = json!(true);
    operation["maxProperties"] = json!(64);
    operation
}
pub fn requests() -> [(String, Value); 2] {
    let read = json!({"oneOf":[
        object(json!({"operation":{"const":"worktreeList"}}),&["operation"]),
        object(json!({"operation":{"const":"worktreeOptions"},"projectId":string(),"sourceRoot":string()}),&["operation"]),
        object(json!({"operation":{"const":"worktreeRead"},"projectId":string(),"requestId":string()}),&["operation","requestId"]),
        object(json!({"operation":{"const":"worktreeInspect"},"requestId":string(),"allowDirty":{"type":"boolean"},"legacyOperation":operation()}),&["operation","requestId"])
    ]});
    let command = json!({"oneOf":[
        object(json!({"operation":{"const":"worktreeCreate"},"projectId":string(),"requestId":string(),"source":{"enum":["head","branch"]},"sourceRoot":string(),"ref":string(),"worktreeRoot":string(),"branch":string(),"branchPrefix":string(),"fetchBeforeCreate":{"type":"boolean"},"environmentId":string()}),&["operation","projectId","requestId","worktreeRoot"]),
        object(json!({"operation":{"const":"worktreeCancel"},"projectId":string(),"requestId":string(),"worktreeRequestId":string()}),&["operation","requestId","worktreeRequestId"]),
        object(json!({"operation":{"const":"worktreeDelete"},"projectId":string(),"requestId":string(),"worktreeRequestId":string(),"automatic":{"type":"boolean"},"legacyOperation":operation()}),&["operation","requestId","worktreeRequestId"])
    ]});
    [
        ("areal/worktree/read".into(), read),
        ("areal/worktree/command".into(), command),
    ]
}
pub fn responses() -> [(String, Value); 2] {
    let row = object(
        json!({"root":string(),"head":string(),"branch":string(),"locked":{"type":"boolean"},"prunable":{"type":"boolean"},"detached":{"type":"boolean"}}),
        &["root"],
    );
    let read = json!({"anyOf":[operation(),object(json!({"state":{"const":"missing"}}),&["state"]),object(json!({"worktrees":{"type":"array","items":row,"maxItems":65536},"branches":{"type":"array","items":string(),"maxItems":65536}}),&["worktrees"])]});
    [
        ("areal/worktree/read".into(), read),
        ("areal/worktree/command".into(), operation()),
    ]
}
