//! 桌面通知只投影当前 Core 的推送，不读取历史或重新提交操作。
use areal_protocol::tasks::{OwnerAttentionKind, OwnerInvalidation, OwnerNoticeKind};
use serde_json::{Value, json};

pub(super) fn from_event(project: &str, event: &Value, now: i64) -> Vec<Value> {
    if event["method"] != "areal/owner/invalidated" {
        return Vec::new();
    }
    let Ok(event) = serde_json::from_value::<OwnerInvalidation>(event["params"].clone()) else {
        return Vec::new();
    };
    event
        .facts
        .into_iter()
        .filter(|fact| fact.expires_at.is_none_or(|expiry| expiry > now))
        .filter_map(|fact| {
            let body: String = fact.objective_preview.chars().take(200).collect();
            match fact.kind {
                OwnerNoticeKind::TurnCompleted => Some(thread_notice(
                    project,
                    "completion",
                    fact.thread_id.as_deref()?,
                    fact.turn_id.as_deref()?,
                    &body,
                )),
                OwnerNoticeKind::TaskCompleted => {
                    let task = fact.task_id?;
                    let run = fact.run_id?;
                    Some(json!({
                        "id":json!([project,"task-completion",task,run]).to_string(),
                        "projectId":project,"kind":"completion","taskId":task,"runId":run,"body":body,
                    }))
                }
                OwnerNoticeKind::QuestionPending => {
                    let task = fact.task_id?;
                    let question = fact.question_id?;
                    Some(json!({
                        "id":json!([project,"task-question",task,question]).to_string(),
                        "projectId":project,"kind":"question","taskId":task,"questionId":question,"body":body,
                    }))
                }
                OwnerNoticeKind::InteractionPending => {
                    let kind = match fact.interaction_kind? {
                        OwnerAttentionKind::Approval => "approval",
                        OwnerAttentionKind::SyncQuestion | OwnerAttentionKind::AsyncQuestion => {
                            "question"
                        }
                    };
                    Some(thread_notice(
                        project,
                        kind,
                        fact.thread_id.as_deref()?,
                        fact.interaction_id.as_deref()?,
                        &body,
                    ))
                }
            }
        })
        .collect()
}

fn thread_notice(project: &str, kind: &str, thread: &str, operation: &str, body: &str) -> Value {
    json!({
        "id":json!([project,kind,thread,operation]).to_string(),
        "projectId":project,"kind":kind,"threadId":thread,"body":body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_use_live_owner_facts_and_preserve_original_targets() {
        let invalidation = json!({"method":"areal/owner/invalidated","params":{
            "generation":"current","sequence":2,"changedTasks":[],"changedThreads":[],
            "facts":[
                {"kind":"interactionPending","threadId":"thread","interactionId":"original",
                 "interactionKind":"approval","objectivePreview":"Review the action","expiresAt":12},
                {"kind":"questionPending","taskId":"task","questionId":"expired",
                 "objectivePreview":"Expired","expiresAt":10},
                {"kind":"taskCompleted","taskId":"task","runId":"run",
                 "objectivePreview":"Completed task"},
                {"kind":"turnCompleted","threadId":"thread","turnId":"turn",
                 "objectivePreview":"Completed turn"}
            ]
        }});
        let live = from_event("project", &invalidation, 10);
        assert_eq!(live.len(), 3);
        assert_eq!(live[0]["kind"], "approval");
        assert_eq!(live[0]["threadId"], "thread");
        assert_eq!(live[1]["taskId"], "task");
        assert_eq!(live[1]["runId"], "run");
        assert_eq!(
            live[2]["id"],
            "[\"project\",\"completion\",\"thread\",\"turn\"]"
        );
        assert!(
            from_event(
                "project",
                &json!({"method":"areal/owner/watch","params":invalidation["params"]}),
                10
            )
            .is_empty()
        );
    }
}
