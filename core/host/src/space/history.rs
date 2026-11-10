//! 恢复空间只读旧资料库；来源身份始终由固定清单和原服务锁确认。
use super::*;
use std::{
    collections::BTreeSet,
    io::Read,
    sync::{Arc, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryQuery {
    pub space_id: Option<String>,
    pub project_id: String,
    pub thread_id: String,
    pub snapshot_id: Option<String>,
    pub cursor: Option<String>,
}
fn library(manifest: &Manifest) -> Result<Value> {
    let path = manifest.source.core_home.join("library.json");
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(error.into()),
    };
    let before = file.metadata()?;
    ensure!(
        before.is_file()
            && before.uid() == unsafe { libc::geteuid() }
            && before.mode() & 0o022 == 0
            && before.len() <= 8 * 1024 * 1024,
        "PERSISTED_HISTORY_UNAVAILABLE"
    );
    let mut bytes = Vec::new();
    (&mut file)
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let named = fs::symlink_metadata(&path)?;
    let stamp = |m: &fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    ensure!(
        bytes.len() <= 8 * 1024 * 1024
            && stamp(&before) == stamp(&after)
            && stamp(&before) == stamp(&named),
        "PERSISTED_HISTORY_UNAVAILABLE"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
pub(super) fn catalog(manifest: &Manifest, projects: &[Value]) -> Result<(Vec<Value>, bool)> {
    let library = library(manifest)?;
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    let mut truncated = false;
    for project in projects {
        let Some(project_id) = project["id"]
            .as_str()
            .filter(|id| id.len() == 24 && id.bytes().all(|c| c.is_ascii_hexdigit()))
        else {
            continue;
        };
        let cached = library["projects"][project_id]["navigationSummaries"].as_array();
        let mut ids = Vec::new();
        if let Some(cached) = cached {
            for entry in cached {
                if let Some(id) = entry["id"].as_str() {
                    ids.push(id.to_owned());
                }
            }
        }
        if let Some(threads) = library["threads"].as_object() {
            let prefix = format!("{project_id}:");
            for key in threads.keys() {
                if let Some(id) = key.strip_prefix(&prefix) {
                    ids.push(id.to_owned());
                }
            }
        }
        for id in ids {
            if uuid::Uuid::parse_str(&id).is_err()
                || !seen.insert((project_id.to_owned(), id.clone()))
            {
                continue;
            }
            if entries.len() >= 512 {
                truncated = true;
                continue;
            }
            let key = format!("{project_id}:{id}");
            let title = library["threads"][&key]["name"]
                .as_str()
                .or_else(|| {
                    cached
                        .and_then(|rows| rows.iter().find(|row| row["id"] == id))
                        .and_then(|row| row["name"].as_str().or_else(|| row["preview"].as_str()))
                })
                .unwrap_or("历史会话");
            entries.push(json!({"projectId":project_id,"threadId":id,"title":title.chars().take(256).collect::<String>()}));
        }
    }
    Ok((entries, truncated))
}
fn read(manifest: &Manifest, query: HistoryQuery) -> Result<Value> {
    ensure!(
        query.cursor.is_none() || query.snapshot_id.is_some(),
        "INVALID_PARAMS"
    );
    ensure!(
        query
            .cursor
            .as_ref()
            .is_none_or(|value| value.len() <= 8192),
        "INVALID_PARAMS"
    );
    let directory = inspect(manifest)?;
    ensure!(
        directory["history"].as_array().is_some_and(|rows| rows
            .iter()
            .any(|row| row["projectId"] == query.project_id && row["threadId"] == query.thread_id)),
        "FORBIDDEN"
    );
    let project = directory["projects"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == query.project_id))
        .context("FORBIDDEN")?;
    let workspace = PathBuf::from(project["root"].as_str().context("FORBIDDEN")?).canonicalize()?;
    let data = manifest
        .source
        .core_home
        .join(&query.project_id)
        .join("state");
    ensure!(
        data.canonicalize()? == data,
        "PERSISTED_HISTORY_UNAVAILABLE"
    );
    let instance = storage::digest(data.as_os_str().as_encoded_bytes())[..24].to_owned();
    let descriptor = storage::registry(&manifest.source.host_home, &instance)?.join("service.json");
    let snapshot = crate::history_snapshot::read_history_snapshot(&descriptor, &query.thread_id)?;
    ensure!(
        snapshot.data_dir == data && snapshot.workspace == workspace,
        "PERSISTED_HISTORY_UNAVAILABLE"
    );
    if let Some(expected) = &query.snapshot_id {
        ensure!(
            expected == snapshot.conversation.snapshot_id(),
            "TARGET_CHANGED"
        );
    }
    ensure!(
        query.cursor.is_none() || query.snapshot_id.is_some(),
        "INVALID_PARAMS"
    );
    let page = match query.cursor {
        Some(cursor) => snapshot.conversation.history(Some(cursor), 128 * 1024)?,
        None => snapshot.conversation.snapshot(128 * 1024)?,
    };
    Ok(
        json!({"projectId":query.project_id,"threadId":query.thread_id,"snapshotId":snapshot.conversation.snapshot_id(),"capturedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"serviceGeneration":snapshot.service_generation,"readOnly":true,"attachments":"unavailable","page":page}),
    )
}
pub(crate) async fn for_host(host_home: &Path, query: HistoryQuery) -> Result<Value> {
    static CAPACITY: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = CAPACITY
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| crate::wire::error("RESOURCE_BUSY", "close another history read"))?;
    let roots = roots()?;
    let host_home = host_home.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let manifest = manifest_for_host(&roots, &host_home, query.space_id.as_deref())?;
        read(&manifest, query)
    })
    .await?
    .map_err(|error| {
        if error.downcast_ref::<crate::wire::Error>().is_some() {
            return error;
        }
        let code = match error.to_string().as_str() {
            "FORBIDDEN" => "FORBIDDEN",
            "TARGET_CHANGED" => "TARGET_CHANGED",
            "INVALID_PARAMS" => "INVALID_PARAMS",
            "CAPABILITY_UNAVAILABLE" => "CAPABILITY_UNAVAILABLE",
            _ => "PERSISTED_HISTORY_UNAVAILABLE",
        };
        crate::wire::error(code, "Recorded history could not be read safely")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs2::FileExt;
    #[test]
    fn recovery_history_is_bound_to_old_catalog_locks_and_snapshot_without_settling_unknown() {
        let temp = tempfile::tempdir_in("/tmp").unwrap();
        let base = temp.path().canonicalize().unwrap();
        let source = SpaceSource {
            profile: base.join("profile"),
            core_home: base.join("core"),
            host_home: base.join("old"),
        };
        for dir in [&source.profile, &source.core_home, &source.host_home] {
            storage::private_dir(dir).unwrap();
        }
        let roots = Roots {
            long: base.join("spaces"),
            short: base.join("hosts"),
        };
        let project_id = "a".repeat(24);
        let thread_id = uuid::Uuid::new_v4().to_string();
        let workspace = base.join("workspace");
        storage::private_dir(&workspace).unwrap();
        let data = source.core_home.join(&project_id).join("state");
        storage::private_dir(&data).unwrap();
        storage::write(
            &source.core_home.join("projects.json"),
            &json!([{"id":project_id,"root":workspace,"name":"旧项目"}]),
        )
        .unwrap();
        storage::write(&source.core_home.join("library.json"),&json!({"projects":{&project_id:{"navigationSummaries":[{"id":thread_id,"name":"旧会话"}]}}})).unwrap();
        let instance = storage::digest(data.as_os_str().as_encoded_bytes())[..24].to_owned();
        let directory = storage::registry(&source.host_home, &instance).unwrap();
        storage::private_dir(&directory).unwrap();
        for path in [
            directory.join("start.lock"),
            data.join("owner.lock"),
            data.join("service.lock"),
        ] {
            drop(storage::open_private(&path, true).unwrap());
        }
        storage::write(&data.join("service-workspace"), &workspace).unwrap();
        let descriptor = directory.join("service.json");
        storage::write(&descriptor,&json!({"protocolVersion":1,"serviceId":instance,"generation":"old-generation","workspace":workspace,"dataDir":data,"configFingerprint":"fixture","endpoint":"ws://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":99999999,"corePid":99999998,"state":"stopped"})).unwrap();
        let record = data.join(format!("{thread_id}.json"));
        let original = json!({"version":17,"thread":{"id":thread_id,"sessionId":thread_id,"parentThreadId":null,"preview":"fixture","modelProvider":"fixture","createdAt":1,"updatedAt":2,"status":{"type":"active","activeFlags":[]},"cwd":workspace,"cliVersion":"fixture","source":"cli","ephemeral":false,"turns":[{"id":"pending","status":"inProgress","items":[{"type":"agentMessage","id":"message","text":"recorded"}]}]}});
        storage::write(&record, &original).unwrap();
        let receipt = source.host_home.join("unknown.json");
        storage::write(
            &receipt,
            &json!({"state":"admissionUnknown","requestId":"original"}),
        )
        .unwrap();
        let before = fs::read(&receipt).unwrap();
        let store_before = fs::read(&record).unwrap();
        let space_id = uuid::Uuid::new_v4().to_string();
        prepare(&roots, &space_id, source).unwrap();
        let manifest = read_manifest(&roots, &space_id).unwrap();
        let query = || HistoryQuery {
            space_id: None,
            project_id: project_id.clone(),
            thread_id: thread_id.clone(),
            snapshot_id: None,
            cursor: None,
        };
        assert_eq!(inspect(&manifest).unwrap()["history"][0]["title"], "旧会话");
        let owner = storage::open_private(&data.join("owner.lock"), false).unwrap();
        owner.try_lock_exclusive().unwrap();
        assert!(read(&manifest, query()).is_err());
        drop(owner);
        let loaded = read(&manifest, query()).unwrap();
        assert_eq!(loaded["page"]["thread"]["turns"][0]["status"], "inProgress");
        assert_eq!(loaded["readOnly"], true);
        assert_eq!(loaded["attachments"], "unavailable");
        let mut wrong = query();
        wrong.thread_id = uuid::Uuid::new_v4().to_string();
        assert!(read(&manifest, wrong).is_err());
        let mut wrong = query();
        wrong.project_id = "../outside".into();
        assert!(read(&manifest, wrong).is_err());
        let mut changed = original.clone();
        changed["thread"]["updatedAt"] = json!(3);
        storage::write(&record, &changed).unwrap();
        let mut stale = query();
        stale.snapshot_id = loaded["snapshotId"].as_str().map(str::to_owned);
        assert!(
            read(&manifest, stale)
                .unwrap_err()
                .to_string()
                .contains("TARGET_CHANGED")
        );
        storage::write(&record, &original).unwrap();
        assert_eq!(fs::read(&record).unwrap(), store_before);
        assert_eq!(fs::read(&receipt).unwrap(), before);
        assert!(!directory.join("auth.json").exists());
        fs::remove_file(descriptor).unwrap();
        assert!(read(&manifest, query()).is_err());
    }
}
