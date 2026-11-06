use super::*;
use serde::{Deserialize, Serialize};

const PROOF: &str = "legacyReceiptProof";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ObservedStore {
    pub service_id: String,
    pub identity: String,
    pub journal_epoch: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    request_id: String,
    method: String,
    digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue_item_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    version: u32,
    source: crate::migration::JournalSource,
    record_digest: String,
    store: ObservedStore,
    receipt: Receipt,
}
struct Expected {
    operation: String,
    method: String,
    thread: String,
    task: Option<String>,
    task_params: Option<Value>,
    digest: Option<String>,
    accepted: bool,
    enqueue: bool,
    control: bool,
}
pub(super) fn is_legacy(record: &Value) -> bool {
    matches!(
        record["remote"]["method"].as_str(),
        Some("session.send" | "session.control" | "task.pause" | "task.question.reply")
    ) && record.get("nativeDigest").is_none()
        && record.get("coreScope").is_none()
}
fn id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 128)
}
fn expected(record: &Value) -> Option<Expected> {
    if !is_legacy(record) {
        return None;
    }
    let operation = id(&record["operationId"])?;
    uuid::Uuid::parse_str(operation).ok()?;
    uuid::Uuid::parse_str(id(&record["remote"]["commandId"])?).ok()?;
    id(&record["remote"]["hostId"])?;
    id(&record["remote"]["devicePeerId"])?;
    id(&record["remote"]["projectId"])?;
    let method = record["method"].as_str()?;
    if matches!(
        record["remote"]["method"].as_str(),
        Some("task.pause" | "task.question.reply")
    ) {
        if !session::send::remote_control(record) {
            return None;
        }
        let task = id(&record["params"]["taskId"])?;
        if record.get("admissionState").is_some() || record.get("accepted").is_some() {
            return None;
        }
        return Some(Expected {
            operation: operation.into(),
            method: method.into(),
            thread: String::new(),
            task: Some(task.into()),
            task_params: Some(record["params"].clone()),
            digest: Some(session::tasks::native_digest(method, &record["params"]).ok()?),
            accepted: false,
            enqueue: false,
            control: true,
        });
    }
    if record["remote"]["capability"] != "submit" {
        return None;
    }
    let (enqueue, control) = match (method, record["remote"]["method"].as_str()) {
        ("areal/turn/start", Some("session.send")) => (false, false),
        ("areal/turn/enqueue", Some("session.send")) => (true, false),
        (_, Some("session.control"))
            if session::controls::method(record["remote"]["target"]["operation"].as_str()?)
                == Some(method)
                && method != "turn/steer" =>
        {
            (false, true)
        }
        _ => return None,
    };
    let thread = id(&record["remote"]["target"]["threadId"])?;
    let revision = record["remote"]["target"][if control {
        "expectedRevision"
    } else {
        "expectedConfigRevision"
    }]
    .as_u64()?;
    let accepted = record["admissionState"] == "accepted" && record["accepted"] == true;
    let digest = if accepted {
        if record.get("params").is_some() || record["threadId"] != thread {
            return None;
        }
        if !control {
            if enqueue {
                id(&record["receipt"]["queueItemId"])?;
            } else {
                id(&record["turnId"])?;
            }
        }
        None
    } else {
        if record.get("admissionState").is_some() || record.get("accepted").is_some() {
            return None;
        }
        if control {
            let params = &record["params"];
            if params["requestId"] != operation
                || params["threadId"] != thread
                || params["expectedRevision"] != revision
            {
                return None;
            }
            if method == "areal/thread/configure" {
                let typed: areal_protocol::desktop::ConfigureThread =
                    serde_json::from_value(params.clone()).ok()?;
                if typed.agent_profile.is_some()
                    || typed.reset_model
                    || typed.selected_skills.is_some()
                {
                    return None;
                }
            }
            if method == "areal/goal/create"
                && !params.as_object()?.keys().all(|key| {
                    [
                        "requestId",
                        "threadId",
                        "expectedRevision",
                        "objective",
                        "inferLimits",
                    ]
                    .contains(&key.as_str())
                })
            {
                return None;
            }
            Some(session::controls::native_digest(method, params).ok()??)
        } else {
            let params: areal_protocol::desktop::TurnStart =
                serde_json::from_value(record["params"].clone()).ok()?;
            let guard = params.admission_guard.as_ref()?;
            if params.request_id != operation
                || params.thread_id != thread
                || params.expected_config_revision != Some(revision)
                || !guard.ordinary_session
                || guard.config_revision != revision
                || params.interaction_mode.is_some()
                || (enqueue
                    && guard
                        .expected_turn_id
                        .as_ref()
                        .is_none_or(|id| id.is_empty()))
                || params.input.len() != 1
                || !matches!(&params.input[0], areal_protocol::Input::Text {text,text_elements,mcp_content} if !text.trim().is_empty() && text.len()<=64*1024 && text_elements.is_empty() && mcp_content.is_none())
            {
                return None;
            }
            Some(storage::digest(&serde_json::to_vec(&params).ok()?))
        }
    };
    Some(Expected {
        operation: operation.into(),
        method: method.into(),
        thread: thread.into(),
        task: None,
        task_params: None,
        digest,
        accepted,
        enqueue,
        control,
    })
}
fn digest(record: &Value) -> Result<String> {
    let mut record = record.clone();
    record
        .as_object_mut()
        .context("invalid legacy record")?
        .remove(PROOF);
    Ok(storage::digest(&serde_json::to_vec(&record)?))
}
fn source(
    host: &Host,
    selected: &str,
    project: &str,
    alias: &str,
    record: &Value,
) -> Result<crate::migration::JournalSource> {
    let snapshot = host.remote.snapshot(&host.migration)?;
    ensure!(
        snapshot["sourceId"] == selected && record["remote"]["projectId"] == alias,
        "legacy source changed"
    );
    let identity = wire::Identity::from_base64(
        snapshot["config"]["identity"]
            .as_str()
            .context("missing Remote identity")?,
    )?;
    ensure!(
        record["remote"]["hostId"] == identity.peer().to_string(),
        "legacy Remote identity differs"
    );
    let current = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect::<Vec<_>>();
    host.migration
        .journal_source(selected, project, alias, &current)
}
fn receipt(expected: &Expected, record: &Value, value: &Value, identity: &str) -> Result<Receipt> {
    let target = match &expected.task {
        Some(task) => json!({"kind":"task","taskId":task}),
        None => json!({"kind":"thread","threadId":expected.thread}),
    };
    ensure!(
        value["requestId"] == expected.operation
            && value["method"] == expected.method
            && value["identity"] == identity
            && expected.task.as_ref().map_or_else(
                || value["threadId"] == expected.thread,
                |task| value["taskId"] == *task
            )
            && value["operation"]["requestId"] == expected.operation
            && value["operation"]["method"] == expected.method
            && value["operation"]["target"] == target
            && value["status"] == "completed",
        "legacy receipt identity differs"
    );
    let actual_digest = value["digest"]
        .as_str()
        .context("missing original receipt digest")?;
    ensure!(
        actual_digest.len() == 64 && actual_digest.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid original receipt digest"
    );
    if let Some(digest) = &expected.digest {
        ensure!(
            actual_digest == digest,
            if expected.task.is_some() {
                "COMMAND_CONFLICT"
            } else {
                "original request digest differs"
            }
        );
    }
    let (turn, queue) = if expected.control {
        ensure!(
            if expected.task.is_some() {
                {
                    let mut native = record.clone();
                    native["params"] = expected
                        .task_params
                        .clone()
                        .context("missing original task parameters")?;
                    session::tasks::apply_result(&mut native, &value["result"])
                        && (!expected.accepted || native["receipt"] == record["receipt"])
                }
            } else {
                session::controls::apply_result(&mut record.clone(), &value["result"])
            },
            "original control result differs"
        );
        (None, None)
    } else if expected.enqueue {
        let queue =
            id(&value["result"]["queueItemId"]).context("missing original queue admission")?;
        ensure!(
            !expected.accepted || record["receipt"]["queueItemId"] == queue,
            "original queue result differs"
        );
        (None, Some(queue.to_owned()))
    } else {
        let turn = id(&value["result"]["turn"]["id"]).context("missing original Turn admission")?;
        ensure!(
            !expected.accepted || record["turnId"] == turn,
            "original Turn result differs"
        );
        (Some(turn.to_owned()), None)
    };
    Ok(Receipt {
        request_id: expected.operation.clone(),
        method: expected.method.clone(),
        digest: actual_digest.into(),
        thread_id: expected.task.is_none().then(|| expected.thread.clone()),
        task_id: expected.task.clone(),
        turn_id: turn,
        queue_item_id: queue,
    })
}
pub(super) fn observed_store(
    host: &Host,
    selected: &str,
    project: &str,
    alias: &str,
    record: &Value,
) -> Result<ObservedStore> {
    let expected = expected(record).context("legacy record shape differs")?;
    ensure!(expected.accepted, "legacy admission is not proved");
    ensure!(
        !expected.control,
        "configuration has no completion observation"
    );
    let proof: Proof = serde_json::from_value(record[PROOF].clone())?;
    let binding = source(host, selected, project, alias, record)?;
    ensure!(
        proof.version == 1
            && proof.source == binding
            && proof.record_digest == digest(record)?
            && proof.store.service_id
                == storage::digest(binding.data_dir.as_os_str().as_encoded_bytes())[..24]
            && proof.store.identity == "desktop-owner"
            && uuid::Uuid::parse_str(&proof.store.journal_epoch).is_ok()
            && proof.receipt.request_id == expected.operation
            && proof.receipt.method == expected.method
            && proof.receipt.thread_id.as_deref() == Some(expected.thread.as_str())
            && proof.receipt.digest.len() == 64
            && if expected.enqueue {
                proof.receipt.queue_item_id.as_deref() == record["receipt"]["queueItemId"].as_str()
                    && proof.receipt.turn_id.is_none()
            } else {
                proof.receipt.turn_id.as_deref() == record["turnId"].as_str()
                    && proof.receipt.queue_item_id.is_none()
            },
        "legacy observation proof differs"
    );
    Ok(proof.store)
}
pub(super) async fn task_retry(
    host: &Rc<Host>,
    selected: &str,
    project: &str,
    alias: &str,
    record: &Value,
    incoming: &Value,
) -> Result<Option<Value>> {
    ensure!(is_legacy(record), "COMMAND_CONFLICT");
    let operation = id(&record["operationId"]).context("COMMAND_CONFLICT")?;
    uuid::Uuid::parse_str(operation).context("COMMAND_CONFLICT")?;
    let pause = record["remote"]["method"] == "task.pause";
    ensure!(
        record["remote"]["method"]
            == if pause {
                "task.pause"
            } else {
                "task.question.reply"
            }
            && record["method"]
                == if pause {
                    "areal/task/pause"
                } else {
                    "areal/channel/reply"
                }
            && record["remote"]["capability"] == if pause { "pauseTask" } else { "answer" }
            && incoming["requestId"] == operation,
        "COMMAND_CONFLICT"
    );
    let keys = if pause {
        &["taskId", "expectedRunId", "expectedRevision"][..]
    } else {
        &["taskId", "runId", "questionId"][..]
    };
    ensure!(
        record["remote"]["target"]
            .as_object()
            .is_some_and(|target| target.len() == keys.len())
            && keys
                .iter()
                .all(|key| record["remote"]["target"][key] == incoming[key]),
        "COMMAND_CONFLICT"
    );
    let binding = source(host, selected, project, alias, record)?;
    let incoming_digest =
        session::tasks::native_digest(record["method"].as_str().unwrap(), incoming)?;
    if record.get("admissionState").is_none() {
        let original = expected(record).context("COMMAND_CONFLICT")?;
        ensure!(
            original.digest.as_deref() == Some(incoming_digest.as_str()),
            "COMMAND_CONFLICT"
        );
        return Ok(Some(recover(host, selected, project, alias, record).await));
    }
    ensure!(
        record["admissionState"] == "accepted"
            && record["accepted"] == true
            && record.get("params").is_none(),
        "COMMAND_CONFLICT"
    );
    if record.get(PROOF).is_some() {
        let proof: Proof = serde_json::from_value(record[PROOF].clone())?;
        ensure!(
            proof.version == 1
                && proof.source == binding
                && proof.record_digest == digest(record)?
                && proof.store.service_id
                    == storage::digest(binding.data_dir.as_os_str().as_encoded_bytes())[..24]
                && proof.store.identity == "desktop-owner"
                && uuid::Uuid::parse_str(&proof.store.journal_epoch).is_ok()
                && proof.receipt.request_id == operation
                && proof.receipt.method == record["method"]
                && proof.receipt.task_id.as_deref() == incoming["taskId"].as_str()
                && proof.receipt.thread_id.is_none(),
            "legacy task proof differs"
        );
        ensure!(proof.receipt.digest == incoming_digest, "COMMAND_CONFLICT");
        return Ok(Some(record.clone()));
    }
    let expected = Expected {
        operation: operation.into(),
        method: record["method"].as_str().unwrap().into(),
        thread: String::new(),
        task: Some(id(&incoming["taskId"]).context("COMMAND_CONFLICT")?.into()),
        task_params: Some(incoming.clone()),
        digest: Some(incoming_digest),
        accepted: true,
        enqueue: false,
        control: true,
    };
    match recover_inner(host, selected, project, alias, record, Some(expected)).await {
        Ok(record) => Ok(record),
        Err(error) if error.to_string() == "COMMAND_CONFLICT" => Err(error),
        Err(_) => Ok(None),
    }
}
pub(super) async fn recover(
    host: &Rc<Host>,
    selected: &str,
    project: &str,
    alias: &str,
    record: &Value,
) -> Value {
    match recover_inner(host, selected, project, alias, record, None).await {
        Ok(Some(record)) => record,
        _ => record.clone(),
    }
}
async fn recover_inner(
    host: &Rc<Host>,
    selected: &str,
    project: &str,
    alias: &str,
    record: &Value,
    task_retry: Option<Expected>,
) -> Result<Option<Value>> {
    let Some(expected) = task_retry.or_else(|| expected(record)) else {
        return Ok(None);
    };
    if expected.control && expected.accepted && expected.task.is_none() {
        return Ok(Some(record.clone()));
    }
    if record.get(PROOF).is_some() {
        observed_store(host, selected, project, alias, record)?;
        return Ok(Some(record.clone()));
    }
    let binding = source(host, selected, project, alias, record)?;
    let scope = host.schedules.connections.shared_identity(host, project)?;
    ensure!(
        scope.0 == storage::digest(binding.data_dir.as_os_str().as_encoded_bytes())[..24],
        "legacy Core Store differs"
    );
    let caps = host
        .schedules
        .connections
        .remote_request(
            host,
            project,
            (&scope.0, &scope.1, &scope.2),
            "areal/capabilities",
            json!({}),
        )
        .await?;
    let store = &caps["features"]["threadCreationJournal"]["binding"];
    ensure!(
        store["identity"] == "desktop-owner"
            && store["journalEpoch"]
                .as_str()
                .is_some_and(|epoch| uuid::Uuid::parse_str(epoch).is_ok()),
        "legacy receipt principal unavailable"
    );
    let read = host
        .schedules
        .connections
        .remote_request(
            host,
            project,
            (&scope.0, &scope.1, &scope.2),
            "areal/request/read",
            if expected.task.is_some() {
                json!({"requestId":expected.operation})
            } else {
                json!({"threadId":expected.thread,"requestId":expected.operation})
            },
        )
        .await?;
    let candidates = read["data"]
        .as_array()
        .context("invalid original receipt response")?
        .iter()
        .filter(|entry| {
            entry["requestId"] == expected.operation
                && entry["method"] == expected.method
                && (expected.task.is_some()
                    || expected
                        .digest
                        .as_ref()
                        .is_none_or(|digest| entry["digest"] == *digest))
        })
        .collect::<Vec<_>>();
    ensure!(
        candidates.len() == 1,
        "original receipt unavailable or ambiguous"
    );
    let receipt = receipt(&expected, record, candidates[0], "desktop-owner")?;
    let seed = if expected.control {
        None
    } else {
        let (native, barrier, observation) = host
            .schedules
            .connections
            .remote_observe(host, project, &scope.1, &expected.thread)
            .await?;
        ensure!(observation.current(host), "legacy observation changed");
        Some(push::CompletionSeed {
            native,
            barrier,
            observation,
            scope: scope.clone(),
        })
    };
    ensure!(
        host.schedules.connections.shared_identity(host, project)? == scope
            && source(host, selected, project, alias, record)? == binding,
        "legacy source changed while reading receipt"
    );
    let (revision, mut snapshot) = host.journal.native_snapshot(project)?;
    let current = snapshot["outcomes"]
        .get(&expected.operation)
        .or_else(|| {
            snapshot["pending"]
                .as_array()?
                .iter()
                .find(|entry| entry["operationId"] == expected.operation)
        })
        .context("legacy journal record disappeared")?;
    if current != record {
        ensure!(
            current["operationId"] == record["operationId"]
                && current["method"] == record["method"]
                && current["remote"] == record["remote"],
            "legacy journal association changed"
        );
        return Ok(Some(current.clone()));
    }
    let mut candidate = record.clone();
    if !expected.accepted {
        candidate["accepted"] = json!(true);
        candidate["admissionState"] = json!("accepted");
        if expected.task.is_none() {
            candidate["threadId"] = json!(expected.thread);
        }
        if expected.control {
            ensure!(
                if expected.task.is_some() {
                    session::tasks::apply_result(&mut candidate, &candidates[0]["result"])
                } else {
                    session::controls::apply_result(&mut candidate, &candidates[0]["result"])
                },
                "original control result differs"
            );
        }
        candidate.as_object_mut().unwrap().remove("params");
        if let Some(turn) = &receipt.turn_id {
            candidate["turnId"] = json!(turn);
        }
        if let Some(queue) = &receipt.queue_item_id {
            candidate["receipt"] = json!({"queueItemId":queue});
        }
    }
    let proof = Proof {
        version: 1,
        source: binding,
        record_digest: digest(&candidate)?,
        store: ObservedStore {
            service_id: scope.0.clone(),
            identity: "desktop-owner".into(),
            journal_epoch: store["journalEpoch"].as_str().unwrap().into(),
        },
        receipt,
    };
    candidate[PROOF] = serde_json::to_value(proof)?;
    snapshot["pending"]
        .as_array_mut()
        .unwrap()
        .retain(|entry| entry["operationId"] != expected.operation);
    snapshot["outcomes"][&expected.operation] = candidate.clone();
    host.journal.native_replace(project, revision, snapshot)?;
    if seed.is_some() {
        push::track_seed(host, project, alias, &candidate, true, seed);
    }
    Ok(Some(candidate))
}
