use super::Host;
use crate::shell::{self, ShellProject, ShellView};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, os::unix::fs::MetadataExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct ReadModels {
    gate: Mutex<()>,
    cached: RefCell<Option<(Value, ShellView)>>,
    online: RefCell<BTreeMap<String, Online>>,
}
#[derive(Clone)]
struct Online {
    revision: (String, String, u64),
    summaries: Vec<Value>,
    attention: Option<u64>,
}

fn source_stamp(path: &std::path::Path, directory: bool) -> Result<Value> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            ensure!(
                (if directory {
                    meta.is_dir()
                } else {
                    meta.is_file()
                }) && meta.uid() == unsafe { libc::geteuid() },
                "invalid navigation source"
            );
            Ok(json!([
                meta.dev(),
                meta.ino(),
                meta.len(),
                meta.mtime(),
                meta.mtime_nsec()
            ]))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(error.into()),
    }
}

impl ReadModels {
    pub(super) async fn shell(&self, host: &Host) -> Result<ShellView> {
        self.read(host, false).await
    }

    async fn read(&self, host: &Host, fresh: bool) -> Result<ShellView> {
        let _guard = self.gate.lock().await;
        // Core 的创建事件可能只发给创建者；新订阅不能沿用其他连接的目录缓存。
        if fresh {
            *self.cached.borrow_mut() = None;
            self.online.borrow_mut().clear();
        }
        let status = host.status().await;
        let registrations: Vec<_> = status
            .projects
            .iter()
            .map(|p| p.registration.clone())
            .collect();
        let sources = host.migration.navigation_sources(&registrations)?;
        let mut source_stamps = Vec::new();
        for source in &sources {
            source_stamps.push(json!({
                "sourceId":source.source_id,"home":source.core_home,"bindings":source.bindings,
                "library":source_stamp(&source.core_home.join("library.json"), false)?,
                "projects":source_stamp(&source.core_home.join("projects.json"), false)?,
                "worktrees":source_stamp(&source.core_home.join("worktree-requests"), true)?
            }));
        }
        let mut revisions = BTreeMap::new();
        for project in &status.projects {
            if project.state == "ready"
                && let Ok(revision) = host
                    .schedules
                    .connections
                    .shell_revision(host, &project.registration.project_id)
            {
                revisions.insert(project.registration.project_id.clone(), revision);
            }
        }
        let stamp =
            json!({"projects":status.projects,"sources":source_stamps,"revisions":revisions});
        if let Some((previous, view)) = &*self.cached.borrow()
            && *previous == stamp
        {
            return Ok(view.clone());
        }
        let mut view = shell::snapshot(&status.projects, &sources)?;
        let mut complete = true;
        self.online
            .borrow_mut()
            .retain(|id, _| revisions.contains_key(id));
        for project in &mut view.projects {
            let Some(revision) = revisions.get(&project.project_id) else {
                continue;
            };
            let cached = self
                .online
                .borrow()
                .get(&project.project_id)
                .filter(|value| value.revision == *revision)
                .cloned();
            let online = match cached {
                Some(cached) => Some(cached),
                None => match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    read_online(host, &project.project_id, revision),
                )
                .await
                {
                    Ok(Ok(value)) => Some(value),
                    _ => {
                        complete = false;
                        None
                    }
                },
            };
            if let Some(online) = online
                && shell::apply_observation(
                    project,
                    &revision.1,
                    online.summaries.clone(),
                    online.attention,
                )
                .is_ok()
            {
                self.online
                    .borrow_mut()
                    .insert(project.project_id.clone(), online);
            }
        }
        // 读取期间的源变化不被标记成新鲜；下一次观察会重新读取。
        *self.cached.borrow_mut() = complete.then(|| (stamp, view.clone()));
        Ok(view)
    }
}

async fn request(
    host: &Host,
    id: &str,
    generation: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    let (service, current, connection) = host.schedules.connections.shared_identity(host, id)?;
    ensure!(current == generation, "RESYNC_REQUIRED");
    host.schedules
        .connections
        .remote_request(
            host,
            id,
            (&service, generation, &connection),
            method,
            params,
        )
        .await
}

async fn pages(
    host: &Host,
    id: &str,
    generation: &str,
    method: &str,
    mut params: Value,
) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    let mut cursors = std::collections::BTreeSet::new();
    loop {
        let page = request(host, id, generation, method, params.clone()).await?;
        let data = page["data"].as_array().context("invalid Core directory")?;
        ensure!(
            rows.len() + data.len() <= 65_536,
            "directory exceeds read budget"
        );
        rows.extend(data.iter().cloned());
        let Some(cursor) = page["nextCursor"].as_str() else {
            ensure!(page["complete"] != false, "incomplete Core directory");
            return Ok(rows);
        };
        ensure!(
            !cursor.is_empty() && cursor.len() <= 16_384 && cursors.insert(cursor.to_owned()),
            "invalid Core directory cursor"
        );
        params["cursor"] = json!(cursor);
    }
}

async fn read_online(host: &Host, id: &str, revision: &(String, String, u64)) -> Result<Online> {
    let summaries = pages(
        host,
        id,
        &revision.1,
        "areal/conversation/list",
        json!({"view":"main","includeArchived":true,"limit":100}),
    )
    .await?
    .into_iter()
    .filter(|thread| {
        !thread["desktop"]["configuration"]["options"]["appendInstructions"]
            .as_str()
            .is_some_and(|text| text.starts_with("AREAL_TASK_DRAFT_V1\n"))
    })
    .collect();
    let attention = match pages(
        host,
        id,
        &revision.1,
        "areal/work/overview",
        json!({"filter":"attention","limit":100}),
    )
    .await
    {
        Ok(rows) if rows.iter().all(|row| row["attentionComplete"] == true) => {
            rows.iter().try_fold(0u64, |sum, row| {
                sum.checked_add(row["attentionCount"].as_u64()?)
            })
        }
        _ => None,
    };
    ensure!(
        host.schedules.connections.shell_revision(host, id)? == *revision,
        "RESYNC_REQUIRED"
    );
    Ok(Online {
        revision: revision.clone(),
        summaries,
        attention,
    })
}

pub(super) struct Subscription {
    id: String,
    connection: String,
    generation: String,
    sequence: u64,
    view: ShellView,
    scope: Option<(std::collections::BTreeSet<String>, String)>,
}
impl Subscription {
    pub(super) async fn open(host: &Host, connection: &str) -> Result<(Self, Value)> {
        let view = host.read_models.read(host, true).await?;
        let sub = Self {
            id: uuid::Uuid::new_v4().to_string(),
            connection: connection.into(),
            generation: host.identity.generation.clone(),
            sequence: 0,
            view,
            scope: None,
        };
        let mut result = sub.keys();
        result["snapshot"] = serde_json::to_value(&sub.view)?;
        Ok((sub, result))
    }
    pub(super) fn id(&self) -> &str {
        &self.id
    }
    pub(super) async fn open_remote(
        host: &Host,
        connection: &str,
        generation: &str,
        projects: std::collections::BTreeSet<String>,
        source: &str,
    ) -> Result<(Self, Value)> {
        let (mut sub, _) = Self::open(host, connection).await?;
        sub.generation = generation.into();
        sub.scope = Some((projects, source.into()));
        sub.view = restrict(sub.view, sub.scope.as_ref().unwrap());
        let mut result = sub.keys();
        result["snapshot"] = serde_json::to_value(&sub.view)?;
        Ok((sub, result))
    }
    fn keys(&self) -> Value {
        json!({"connectionId":self.connection,"gatewayGeneration":self.generation,"subscriptionId":self.id,"sequence":self.sequence})
    }
    pub(super) fn invalidated(&self) -> Value {
        let mut event = self.keys();
        event["event"] = json!("shell.invalidated");
        event["sequence"] = json!(self.sequence + 1);
        event
    }
    pub(super) async fn refresh(&mut self, host: &Host) -> Result<Option<Value>> {
        let mut view = host.read_models.shell(host).await?;
        if let Some(scope) = &self.scope {
            view = restrict(view, scope);
        }
        if view == self.view {
            return Ok(None);
        }
        let old_projects: BTreeMap<_, _> = self
            .view
            .projects
            .iter()
            .map(|p| (&p.project_id, p))
            .collect();
        let new_projects: BTreeMap<_, _> =
            view.projects.iter().map(|p| (&p.project_id, p)).collect();
        let old_nav: BTreeMap<_, _> = self
            .view
            .navigation
            .iter()
            .map(|n| (&n.source_id, n))
            .collect();
        let new_nav: BTreeMap<_, _> = view.navigation.iter().map(|n| (&n.source_id, n)).collect();
        let upsert: Vec<&ShellProject> = new_projects
            .iter()
            .filter(|(id, p)| old_projects.get(*id).copied() != Some(*p))
            .map(|(_, p)| *p)
            .collect();
        let removed: Vec<_> = old_projects
            .keys()
            .filter(|id| !new_projects.contains_key(*id))
            .collect();
        let nav_upsert: Vec<_> = new_nav
            .iter()
            .filter(|(id, n)| old_nav.get(*id).copied() != Some(*n))
            .map(|(_, n)| *n)
            .collect();
        let nav_removed: Vec<_> = old_nav
            .keys()
            .filter(|id| !new_nav.contains_key(*id))
            .collect();
        let delta = json!({"projects":{"upsert":upsert,"remove":removed},"navigation":{"upsert":nav_upsert,"remove":nav_removed}});
        self.view = view;
        self.sequence += 1;
        let mut result = self.keys();
        result["event"] = json!("shell.updated");
        result["delta"] = delta;
        Ok(Some(result))
    }
}

fn restrict(
    mut view: ShellView,
    (projects, source): &(std::collections::BTreeSet<String>, String),
) -> ShellView {
    view.projects
        .retain(|project| projects.contains(&project.project_id));
    view.navigation
        .retain(|navigation| navigation.source_id == *source);
    for navigation in &mut view.navigation {
        navigation
            .bindings
            .retain(|binding| projects.contains(&binding.project_id));
        let aliases: std::collections::BTreeSet<_> = navigation
            .bindings
            .iter()
            .map(|binding| binding.alias.clone())
            .collect();
        navigation
            .projects
            .retain(|alias, _| aliases.contains(alias));
        let belongs = |key: &str| {
            key.split_once(':')
                .is_some_and(|(alias, _)| aliases.contains(alias))
        };
        navigation.threads.retain(|key, _| belongs(key));
        navigation
            .project_order
            .retain(|alias| aliases.contains(alias));
        navigation.sidebar_thread_order.retain(|key| belongs(key));
        let sections: std::collections::BTreeSet<_> = navigation
            .projects
            .values()
            .chain(navigation.threads.values())
            .filter_map(|metadata| metadata.section_id.as_deref())
            .collect();
        navigation
            .sections
            .retain(|section| sections.contains(section.id.as_str()));
    }
    view
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn new_subscription_reads_threads_created_on_another_core_connection() {
        use futures_util::{SinkExt, StreamExt};
        use std::{cell::Cell, rc::Rc};
        use tokio_tungstenite::tungstenite::Message;
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let registration = host.slots.borrow()["project"].registration.clone();
            let service = areal_protocol::service::Service {
                identity: areal_protocol::service::Identity {
                    protocol_version: 1, service_id: "fixture".into(), generation: "first".into(),
                    workspace: registration.workspace, data_dir: registration.data_dir,
                    config_fingerprint: "fixture".into(),
                },
                owner: Some(host.owner()), endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
                web_url: String::new(), auth_file: host.home.join("core-auth.json"), log_file: host.home.join("core.log"),
                host_pid: 1, core_pid: 2, state: areal_protocol::service::State::Ready,
            };
            areal_local_service::storage::write(&service.auth_file, &json!({"principals":[{"id":"desktop-owner","token":"fixture"}]})).unwrap();
            let gate = host.slots.borrow()["project"].gate.clone();
            // 本测试只控制目录回复，保留已就绪项目状态，不启动项目监督进程。
            let _guard = gate.lock().await;
            {
                let mut slots = host.slots.borrow_mut();
                let slot = slots.get_mut("project").unwrap();
                slot.state = "ready".into();
                slot.service = Some(service.clone());
                let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
                slot.writer = Some(writer);
                slot.lifetime = Some(Rc::new(lifetime));
            }
            let added = Rc::new(Cell::new(false));
            let reads = Rc::new(Cell::new(0));
            let (server_added, server_reads) = (added.clone(), reads.clone());
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(&text).unwrap();
                    if request.get("id").is_none() { continue; }
                    let result = match request["method"].as_str().unwrap() {
                        "initialize" => json!({}),
                        "areal/conversation/list" => {
                            server_reads.set(server_reads.get() + 1);
                            let mut items = vec![json!({"id":"first","createdAt":1,"updatedAt":1,"desktop":{"archived":false}})];
                            if server_added.get() { items.push(json!({"id":"second","createdAt":2,"updatedAt":2,"desktop":{"archived":false}})); }
                            json!({"data":items,"nextCursor":null})
                        },
                        "areal/work/overview" => json!({"data":[],"nextCursor":null}),
                        method => panic!("unexpected method {method}"),
                    };
                    socket.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).await.unwrap();
                }
            });
            let close = host.schedules.connections.connect_test_core(host.clone(), "project", service).await.unwrap();
            let (mut original, first) = Subscription::open(&host, "first-browser").await.unwrap();
            assert_eq!(first["snapshot"]["projects"][0]["summaries"]["items"].as_array().unwrap().len(), 1);
            assert!(original.refresh(&host).await.unwrap().is_none());
            assert_eq!(reads.get(), 1, "unchanged subscriptions reuse their observation");
            added.set(true);
            let (_, reopened) = Subscription::open(&host, "second-browser").await.unwrap();
            assert_eq!(reopened["snapshot"]["projects"][0]["summaries"]["items"].as_array().unwrap().len(), 2);
            assert_eq!(reads.get(), 2);
            close();
            server.abort();
        }).await;
    }

    #[tokio::test]
    async fn stopped_project_shell_reads_do_not_launch_core_and_deltas_only_include_changes() {
        let root = tempfile::tempdir().unwrap();
        let host = super::super::schedules::tests::fixture(root.path());
        host.slots.borrow_mut().get_mut("project").unwrap().state = "stopped".into();
        let data = host.slots.borrow()["project"].registration.data_dir.clone();
        let (mut subscription, first) = Subscription::open(&host, "connection").await.unwrap();
        assert_eq!(first["snapshot"]["projects"][0]["projectId"], "project");
        assert_eq!(
            first["snapshot"]["projects"][0]["summaries"],
            json!({"state":"unknown","items":[]})
        );
        assert!(subscription.refresh(&host).await.unwrap().is_none());
        host.changed();
        assert!(subscription.refresh(&host).await.unwrap().is_none());
        let renamed = root.path().join("renamed-workspace");
        areal_local_service::storage::private_dir(&renamed).unwrap();
        host.slots
            .borrow_mut()
            .get_mut("project")
            .unwrap()
            .registration
            .workspace = renamed.clone();
        let changed = subscription.refresh(&host).await.unwrap().unwrap();
        assert_eq!(changed["sequence"], 1);
        assert_eq!(
            changed["delta"]["projects"]["upsert"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            changed["delta"]["projects"]["upsert"][0]["workspace"],
            json!(renamed)
        );
        assert_eq!(
            changed["delta"]["navigation"],
            json!({"upsert":[],"remove":[]})
        );
        assert!(changed.get("snapshot").is_none());
        assert!(subscription.refresh(&host).await.unwrap().is_none());
        assert_eq!(subscription.invalidated()["sequence"], 2);
        host.slots.borrow_mut().remove("project");
        let removed = subscription.refresh(&host).await.unwrap().unwrap();
        assert_eq!(removed["sequence"], 2);
        assert_eq!(
            removed["delta"]["projects"],
            json!({"upsert":[],"remove":["project"]})
        );
        assert!(!data.exists(), "shell must not materialize a stopped Store");
        assert!(
            !host.bin.exists(),
            "no Core executable was available to launch"
        );
    }

    #[tokio::test]
    async fn remote_shell_scope_filters_both_projects_and_source_navigation() {
        let root = tempfile::tempdir().unwrap();
        let host = super::super::schedules::tests::fixture(root.path());
        let status = host.status().await.projects;
        let source = root.path().join("source");
        let other = root.path().join("other");
        for path in [&source, &other] {
            areal_local_service::storage::private_dir(path).unwrap();
            areal_local_service::storage::write(&path.join("library.json"), &json!({
                "projects":{"alias":{"title":"Visible","sectionId":"public"},"hidden":{"title":"Private"}},
                "threads":{"alias:thread":{"title":"Visible thread","sectionId":"public"},"hidden:thread":{"title":"Private thread"}},
                "projectOrder":["alias","hidden"],"sidebarThreadOrder":["alias:thread","hidden:thread"],
                "sections":[{"id":"public","title":"Visible"},{"id":"private","title":"Private"}]
            })).unwrap();
        }
        let sources: Vec<_> = [("selected", source), ("other", other)]
            .into_iter()
            .map(|(id, home)| shell::NavigationSource {
                source_id: id.into(),
                core_home: home,
                bindings: vec![shell::NavigationBinding {
                    project_id: "project".into(),
                    alias: "alias".into(),
                    owned: id == "selected",
                    logical_project_id: None,
                    projectless: false,
                }],
            })
            .collect();
        let view = shell::snapshot(&status, &sources).unwrap();
        let scoped = serde_json::to_value(restrict(
            view.clone(),
            &(
                std::collections::BTreeSet::from(["project".into()]),
                "selected".into(),
            ),
        ))
        .unwrap();
        assert_eq!(scoped["projects"].as_array().unwrap().len(), 1);
        assert_eq!(scoped["navigation"].as_array().unwrap().len(), 1);
        assert_eq!(scoped["navigation"][0]["sourceId"], "selected");
        assert_eq!(
            scoped["navigation"][0]["sections"],
            json!([{"id":"public","title":"Visible"}])
        );
        let empty =
            serde_json::to_value(restrict(view, &(Default::default(), "selected".into()))).unwrap();
        assert_eq!(empty["projects"], json!([]));
        for key in ["bindings", "projectOrder", "sidebarThreadOrder", "sections"] {
            assert_eq!(empty["navigation"][0][key], json!([]));
        }
        for key in ["projects", "threads"] {
            assert_eq!(empty["navigation"][0][key], json!({}));
        }
    }
}
