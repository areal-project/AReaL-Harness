//! 资料库整理只在 Host 事务内计算；Core 数据与页面宿主归属由调用方提供只读视图。
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct ContextView {
    pub projects: Vec<Value>,
    pub summaries: BTreeMap<String, Vec<String>>,
    pub readable: Vec<(String, String)>,
}
impl ContextView {
    fn projectless(&self, id: &str) -> bool {
        self.projects
            .iter()
            .any(|p| p["id"] == id && p["projectless"] == true)
    }
    fn projects(&self) -> Vec<String> {
        self.projects
            .iter()
            .filter_map(|p| p["id"].as_str().map(str::to_owned))
            .collect()
    }
    fn threads(&self) -> Vec<String> {
        self.projects()
            .iter()
            .flat_map(|id| {
                self.summaries
                    .get(id)
                    .into_iter()
                    .flatten()
                    .map(move |thread| format!("{id}:{thread}"))
            })
            .collect()
    }
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field].as_str().context("INVALID_PARAMS")
}
fn ids(value: &Value) -> Result<Vec<String>> {
    value
        .as_array()
        .context("INVALID_PARAMS")?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).context("INVALID_PARAMS"))
        .collect()
}
fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut result = Vec::new();
    for id in values {
        if !result.contains(&id) {
            result.push(id);
        }
    }
    result
}
fn title(request: &Value) -> Result<Value> {
    let title = text(request, "title")?;
    ensure!(
        !title.trim().is_empty() && title.encode_utf16().count() <= 200,
        "名称需要 1–200 个字符"
    );
    Ok(json!(title.trim()))
}
fn meta<'a>(state: &'a mut Value, field: &str, id: &str) -> &'a mut Value {
    state[field]
        .as_object_mut()
        .unwrap()
        .entry(id)
        .or_insert_with(|| json!({}))
}
fn remove(value: &mut Value, key: &str) {
    value.as_object_mut().unwrap().remove(key);
}
fn reorder(
    current: Vec<String>,
    available: Vec<String>,
    id: &str,
    before: Option<&str>,
) -> Result<Value> {
    ensure!(
        before.is_none_or(|b| available.iter().any(|id| id == b)),
        "排序位置已变化，请刷新"
    );
    let all = unique(current.into_iter().chain(available.iter().cloned()));
    if before == Some(id) {
        return Ok(json!(all));
    }
    let mut result: Vec<_> = all
        .into_iter()
        .filter(|v| v != id && available.contains(v))
        .collect();
    let index = before
        .and_then(|b| result.iter().position(|v| v == b))
        .unwrap_or(result.len());
    result.insert(index, id.to_owned());
    Ok(json!(result))
}
fn bucket(state: &Value, view: &ContextView, id: &str) -> String {
    if state["threads"][id]["pinned"] == true {
        "pinned".into()
    } else {
        let project = id.rsplit_once(':').map_or("", |v| v.0);
        if view.projectless(project) {
            "chats".into()
        } else {
            project.into()
        }
    }
}

pub(super) fn apply(state: &mut Value, request: &Value, view: &ContextView) -> Result<()> {
    let operation = text(request, "operation")?;
    let project = request["projectId"].as_str();
    let thread = request["threadId"].as_str();
    let global = [
        "settings",
        "createSection",
        "renameSection",
        "removeSection",
        "orderSection",
        "markAllRead",
        "dropSidebar",
    ]
    .contains(&operation);
    if !global {
        ensure!(
            project.is_some_and(|id| view.projects().iter().any(|p| p == id)),
            "未知工作区"
        );
    }
    if [
        "renameThread",
        "pinThread",
        "orderThread",
        "moveThread",
        "readThread",
        "orderSidebarThread",
    ]
    .contains(&operation)
    {
        let (p, t) = (project.context("未知会话")?, thread.context("未知会话")?);
        ensure!(
            view.summaries
                .get(p)
                .is_some_and(|v| v.iter().any(|id| id == t))
                || (operation == "readThread"
                    && view.readable.iter().any(|(a, b)| a == p && b == t)),
            "未知会话"
        );
    }
    let key = format!(
        "{}:{}",
        project.unwrap_or("undefined"),
        thread.unwrap_or("undefined")
    );
    if let Some(project) = project {
        meta(state, "projects", project);
    }
    let section = state["sections"]
        .as_array()
        .unwrap()
        .iter()
        .position(|s| s["id"] == request["sectionId"]);
    if ["renameSection", "removeSection", "orderSection"].contains(&operation)
        || (["moveThread", "moveProject"].contains(&operation) && !request["sectionId"].is_null())
    {
        ensure!(section.is_some(), "分组已不存在，请刷新");
    }
    let before = request["before"].as_str();
    match operation {
        "renameProject" => meta(state, "projects", project.unwrap())["title"] = title(request)?,
        "renameThread" => meta(state, "threads", &key)["title"] = title(request)?,
        "pinThread" | "pinProject" => {
            let entry = if operation == "pinThread" {
                meta(state, "threads", &key)
            } else {
                meta(state, "projects", project.unwrap())
            };
            entry["pinned"] = json!(request["pinned"] == true);
            if entry["pinned"] == true {
                remove(entry, "sectionId");
            }
        }
        "createSection" => state["sections"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":uuid::Uuid::new_v4().to_string(),"title":title(request)?})),
        "renameSection" => state["sections"][section.unwrap()]["title"] = title(request)?,
        "removeSection" => {
            let id = state["sections"]
                .as_array_mut()
                .unwrap()
                .remove(section.unwrap())["id"]
                .clone();
            for field in ["projects", "threads"] {
                for entry in state[field].as_object_mut().unwrap().values_mut() {
                    if entry["sectionId"] == id {
                        remove(entry, "sectionId");
                    }
                }
            }
        }
        "orderSection" => {
            let available: Vec<_> = state["sections"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].as_str().unwrap().to_owned())
                .collect();
            let order = ids(&reorder(
                available.clone(),
                available,
                text(request, "sectionId")?,
                before,
            )?)?;
            state["sections"]
                .as_array_mut()
                .unwrap()
                .sort_by_key(|v| order.iter().position(|id| v["id"] == *id));
        }
        "moveThread" | "moveProject" => {
            let entry = if operation == "moveThread" {
                meta(state, "threads", &key)
            } else {
                meta(state, "projects", project.unwrap())
            };
            entry["sectionId"] = request["sectionId"].clone();
            entry["pinned"] = json!(false);
        }
        "readThread" => {
            let read = request["read"].as_bool().context("无效已读状态")?;
            if !(read
                && request.get("completionId").is_some()
                && request["completionId"] != state["threads"][&key]["completionId"])
            {
                meta(state, "threads", &key)["unread"] = json!(!read);
            }
        }
        "markAllRead" => {
            for entry in state["threads"].as_object_mut().unwrap().values_mut() {
                entry["unread"] = json!(false);
            }
        }
        "hideProject" => {
            meta(state, "projects", project.unwrap())["hidden"] = json!(request["hidden"] == true)
        }
        "orderProject" => {
            state["projectOrder"] = reorder(
                ids(&state["projectOrder"])?,
                view.projects(),
                project.unwrap(),
                before,
            )?
        }
        "orderThread" => {
            let current = state["projects"][project.unwrap()]
                .get("threadOrder")
                .map(ids)
                .transpose()?
                .unwrap_or_default();
            meta(state, "projects", project.unwrap())["threadOrder"] = reorder(
                current,
                view.summaries
                    .get(project.unwrap())
                    .cloned()
                    .unwrap_or_default(),
                thread.unwrap(),
                before,
            )?;
        }
        "orderSidebarThread" => {
            let current = ids(&state["sidebarThreadOrder"])?;
            let available = unique(current.iter().cloned().chain(view.threads()));
            ensure!(
                before.is_none_or(|b| bucket(state, view, b) == bucket(state, view, &key)),
                "排序位置已变化，请刷新"
            );
            state["sidebarThreadOrder"] = reorder(current, available, &key, before)?;
            let setting = if state["threads"][&key]["pinned"] == true {
                "sidebarSortPinned"
            } else if view.projectless(project.unwrap()) {
                "sidebarSortChats"
            } else {
                "sidebarSortProjects"
            };
            state["settings"][setting] = json!("manual");
        }
        "settings" => {
            let key = text(request, "key")?;
            ensure!(
                [
                    "sidebarSort",
                    "sidebarSortChats",
                    "sidebarSortProjects",
                    "sidebarSortPinned",
                    "showPinned",
                    "showCompleted"
                ]
                .contains(&key),
                "无效偏好设置"
            );
            let value = &request["value"];
            ensure!(
                if key.starts_with("sidebarSort") {
                    value
                        .as_str()
                        .is_some_and(|v| ["manual", "priority", "updated_at"].contains(&v))
                } else {
                    value.is_boolean()
                },
                "INVALID_PARAMS"
            );
            if key.starts_with("sidebarSort")
                && value == "manual"
                && state["sidebarThreadOrder"].as_array().unwrap().is_empty()
            {
                let available = view.threads();
                let order = ids(&request["order"])?;
                ensure!(
                    unique(order.clone()).len() == order.len()
                        && order.iter().all(|id| available.contains(id)),
                    "排序列表已变化，请刷新"
                );
                state["sidebarThreadOrder"] = json!(unique(order.into_iter().chain(available)));
            }
            state["settings"][key] = value.clone();
        }
        "dropSidebar" => drop_sidebar(state, request, view)?,
        _ => bail!("不支持的整理操作"),
    }
    Ok(())
}

fn group(state: &Value, view: &ContextView, field: &str, id: &str) -> String {
    let metadata = &state[field][id];
    if metadata["pinned"] == true {
        "pinned".into()
    } else if let Some(section) = metadata["sectionId"].as_str().filter(|s| !s.is_empty()) {
        format!("section:{section}")
    } else if field == "threads" {
        let owner = id.rsplit_once(':').map_or("", |v| v.0);
        if view.projectless(owner) {
            "chats".into()
        } else {
            format!("project:{owner}")
        }
    } else {
        "projects".into()
    }
}
fn around(mut ids: Vec<String>, id: &str, target: &str, edge: &str) -> Result<Vec<String>> {
    ensure!(
        ids.iter().any(|i| i == target) && id != target && ["before", "after"].contains(&edge),
        "整理位置已变化，请刷新后重试"
    );
    ids.retain(|i| i != id);
    let index = ids.iter().position(|i| i == target).unwrap() + usize::from(edge == "after");
    ids.insert(index, id.into());
    Ok(ids)
}
fn drop_sidebar(state: &mut Value, request: &Value, view: &ContextView) -> Result<()> {
    let changed = "整理位置已变化，请刷新后重试";
    ensure!(
        request["expectedSidebarRevision"]
            .as_u64()
            .is_some_and(|n| n <= 9007199254740991 && state["sidebarRevision"] == n),
        "{changed}"
    );
    let source = &request["source"];
    let target = &request["target"];
    let id = text(source, "id")?;
    let edge = request["edge"].as_str().unwrap_or("");
    if source["type"] == "section" {
        let ids: Vec<_> = state["sections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_owned())
            .collect();
        ensure!(
            ids.iter().any(|s| s == id) && target["type"] == "section",
            "{changed}"
        );
        let order = around(ids, id, text(target, "id")?, edge)?;
        state["sections"]
            .as_array_mut()
            .unwrap()
            .sort_by_key(|s| order.iter().position(|id| s["id"] == *id));
        return Ok(());
    }
    ensure!(
        source["type"] == "thread" || source["type"] == "project",
        "{changed}"
    );
    let thread = source["type"] == "thread";
    let field = if thread { "threads" } else { "projects" };
    let key = if thread {
        format!("{}:{id}", text(source, "projectId")?)
    } else {
        id.into()
    };
    let available = if thread {
        view.threads()
    } else {
        view.projects()
    };
    ensure!(
        available.contains(&key) && source["group"] == group(state, view, field, &key),
        "{changed}"
    );
    let projectless = thread && view.projectless(text(source, "projectId")?);
    let destination = if target["type"] == "section"
        && state["sections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == target["id"])
    {
        format!("section:{}", text(target, "id")?)
    } else if target["type"] == "pinned" {
        "pinned".into()
    } else if thread && target["type"] == "chats" && projectless {
        "chats".into()
    } else if thread
        && !projectless
        && target["type"] == "project"
        && target["id"] == source["projectId"]
    {
        format!("project:{}", text(source, "projectId")?)
    } else if !thread && target["type"] == "projects" {
        "projects".into()
    } else {
        bail!("{changed}")
    };
    let entry = meta(state, field, &key);
    entry["pinned"] = json!(destination == "pinned");
    entry["sectionId"] = if target["type"] == "section" {
        target["id"].clone()
    } else {
        Value::Null
    };
    let members: Vec<_> = available
        .into_iter()
        .filter(|id| group(state, view, field, id) == destination)
        .collect();
    let order = request
        .get("order")
        .map(ids)
        .transpose()?
        .unwrap_or_default();
    ensure!(
        unique(order.clone()).len() == order.len() && order.iter().all(|id| members.contains(id)),
        "{changed}"
    );
    let anchor = request["anchor"].as_str();
    ensure!(
        anchor.is_none_or(|a| a != key && members.iter().any(|id| id == a)),
        "{changed}"
    );
    let order_field = if thread {
        "sidebarThreadOrder"
    } else {
        "projectOrder"
    };
    let existing = ids(&state[order_field])?;
    let seed = unique(
        order
            .into_iter()
            .chain(existing.iter().filter(|id| members.contains(id)).cloned())
            .chain(members.iter().cloned()),
    );
    let next = match anchor {
        Some(anchor) => around(seed, &key, anchor, edge)?,
        None => seed
            .into_iter()
            .filter(|id| id != &key)
            .chain([key.clone()])
            .collect(),
    };
    state[order_field] = json!(
        existing
            .into_iter()
            .filter(|id| !members.contains(id))
            .chain(next)
            .collect::<Vec<_>>()
    );
    let setting = if destination == "pinned" {
        Some("sidebarSortPinned")
    } else if thread && (target["type"] == "section" || target["type"] == "chats") {
        Some("sidebarSortChats")
    } else if thread {
        Some("sidebarSortProjects")
    } else {
        None
    };
    if let Some(setting) = setting {
        state["settings"][setting] = json!("manual");
    }
    Ok(())
}

/// 与旧侧栏的布局失效条件一致；名称、阅读和时间更新不使拖放失效。
pub(super) fn layout(state: &Value) -> Value {
    let placement = |v: &Value| json!([v["pinned"] == true, v["sectionId"]]);
    let projects: Vec<_> = state["projects"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, m)| {
            let mut summaries: Vec<_> = m["navigationSummaries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| json!([s["id"], s["desktop"]["archived"] == true]))
                .collect();
            summaries.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
            json!([id, placement(m), m["hidden"] == true, summaries])
        })
        .collect();
    let threads: Vec<_> = state["threads"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, m)| {
            m["pinned"] == true || m["sectionId"].as_str().is_some_and(|s| !s.is_empty())
        })
        .map(|(id, m)| json!([id, placement(m)]))
        .collect();
    let settings: Vec<_> = [
        "sidebarSort",
        "sidebarSortChats",
        "sidebarSortProjects",
        "sidebarSortPinned",
        "showPinned",
        "showCompleted",
    ]
    .iter()
    .map(|k| state["settings"][k].clone())
    .collect();
    json!([
        state["projectOrder"],
        state["sidebarThreadOrder"],
        state["sections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].clone())
            .collect::<Vec<_>>(),
        projects,
        threads,
        settings
    ])
}

#[cfg(test)]
#[path = "library_commands/tests.rs"]
mod tests;
