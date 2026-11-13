use super::*;

#[tokio::test]
async fn scratch_children_keep_distinct_authors_and_original_receipts() {
    let base = tempfile::tempdir().unwrap();
    let (project, mut rpc) = fixture(base.path());
    let root = &project.registration.workspace;
    let first = root.join("first");
    let second = root.join("second");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    storage::write(&project.metadata_home.join("projects.json"), &json!([{"id":project.legacy_project_id,"root":root,"projectless":true,"projectlessRequestId":SCRATCH_ID}])).unwrap();
    storage::write(
        &project.metadata_home.join("projectless-drafts.json"),
        &json!({(SCRATCH_ID):{"root":root,"existing":true}}),
    )
    .unwrap();
    let mut mismatched = project.clone();
    mismatched.registration.workspace = first.clone();
    assert!(scratch_root(&mismatched).is_err());
    rpc.threads.get_mut("anchor").unwrap()["cwd"] = json!(first);
    rpc.threads.get_mut("coordinator").unwrap()["cwd"] = json!(second);
    rpc.empty_catalog = true;
    let first_request = json!({"intent":"create","requestId":"first","requestDigest":"a".repeat(64),"threadId":"anchor"});
    prepare(&project, &[], &first_request, &rpc).await.unwrap();
    prepare(&project, &[], &first_request, &rpc).await.unwrap();
    let mut conflict = first_request.clone();
    conflict["requestId"] = json!("other");
    assert!(prepare(&project, &[], &conflict, &rpc).await.is_err());
    rpc.threads.get_mut("source").unwrap()["cwd"] = json!(first);
    conflict["threadId"] = json!("source");
    assert!(prepare(&project, &[], &conflict, &rpc).await.is_err());
    rpc.threads.get_mut("source").unwrap()["cwd"] = json!(root);
    let mut digest_conflict = first_request.clone();
    digest_conflict["requestDigest"] = json!("b".repeat(64));
    assert!(
        prepare(&project, &[], &digest_conflict, &rpc)
            .await
            .is_err()
    );
    rpc.task["sourceThreadId"] = Value::Null;
    rpc.empty_catalog = false;
    rpc.status = Some(
        json!({"acceptingWork":true,"activeTurns":[],"resources":[],"unresolvedTools":[],"activeGoals":[],"compactions":[],"workgroups":[],"activeTasks":1,"pendingQueueItems":0}),
    );
    rpc.overview = Some(
        json!({"complete":true,"nextCursor":null,"data":[{"kind":"taskRun","taskId":"task","threadId":"anchor","execution":{"state":"running"},"queue":{"pendingCount":0}}]}),
    );
    rpc.overview.as_mut().unwrap()["complete"] = json!(false);
    assert!(prepare(&project, &[], &json!({"intent":"create","requestId":"second","requestDigest":"b".repeat(64),"threadId":"coordinator"}), &rpc).await.is_err());
    rpc.overview.as_mut().unwrap()["complete"] = json!(true);
    prepare(&project, &[], &json!({"intent":"create","requestId":"second","requestDigest":"b".repeat(64),"threadId":"coordinator"}), &rpc).await.unwrap();
    assert!(prepare(&project, &[], &json!({"intent":"create","requestId":"root","requestDigest":"c".repeat(64),"threadId":"source"}), &rpc).await.is_err());
    #[cfg(unix)]
    {
        let link = root.join("link");
        std::os::unix::fs::symlink(&first, &link).unwrap();
        rpc.threads.get_mut("source").unwrap()["cwd"] = json!(link);
        assert!(prepare(&project, &[], &json!({"intent":"create","requestId":"link","requestDigest":"c".repeat(64),"threadId":"source"}), &rpc).await.is_err());
    }
    rpc.status = None;
    let task: Task = serde_json::from_value(rpc.task.clone()).unwrap();
    assert!(task_workspace(&rpc, &project, &[], &task).await.is_err());
    let good = json!({"method":"areal/task/create","requestId":"first","digest":"a".repeat(64),"status":"completed","result":{"id":"task","threadId":"anchor"}});
    rpc.receipt = json!({"data":[good.clone(),good.clone()]});
    assert!(task_workspace(&rpc, &project, &[], &task).await.is_err());
    rpc.receipt = json!({"data":[good]});
    assert_eq!(
        task_workspace(&rpc, &project, &[], &task)
            .await
            .unwrap()
            .cwd(),
        first
    );
    rpc.threads.insert("side".into(), json!({"id":"side","sessionId":"side-session","cwd":first,"conversation":{"version":2,"kind":"side","origin":{"sourceThreadId":"anchor"},"policy":{"kind":"sideExecutableV2"}}}));
    command(&project, &[], "send", &json!({"threadId":"side"}), &rpc)
        .await
        .unwrap();
    rpc.threads.get_mut("side").unwrap()["conversation"]["policy"]["kind"] =
        json!("sideReadOnlyV1");
    command(&project, &[], "send", &json!({"threadId":"side"}), &rpc)
        .await
        .unwrap();
    assert!(
        command(
            &project,
            &[],
            "send",
            &json!({"threadId":"side","sourceThreadId":"side"}),
            &rpc
        )
        .await
        .is_err()
    );
    assert!(
        command(
            &project,
            &[],
            "manage",
            &json!({"operation":"processStart","threadId":"side"}),
            &rpc
        )
        .await
        .is_err()
    );
    command(
        &project,
        &[],
        "manage",
        &json!({"operation":"archive","threadId":"side"}),
        &rpc,
    )
    .await
    .unwrap();
    rpc.run["threadId"] = json!("run-thread");
    rpc.run["goalId"] = json!("goal");
    rpc.run["status"] = json!("running");
    rpc.task["runs"][0] = rpc.run.clone();
    rpc.threads.insert("run-thread".into(), json!({"id":"run-thread","sessionId":"run-session","cwd":first,"goals":{"goal":{"id":"goal","threadId":"run-thread","status":"active","activeTurnId":"original-turn"}}}));
    command(
        &project,
        &[],
        "continue",
        &json!({"threadId":"run-thread","expectedTurnId":"original-turn"}),
        &rpc,
    )
    .await
    .unwrap();
    assert!(
        command(
            &project,
            &[],
            "continue",
            &json!({"threadId":"run-thread","expectedTurnId":"stale-turn"}),
            &rpc
        )
        .await
        .is_err()
    );
    rpc.task["cancelled"] = json!(true);
    command(&project, &[], "send", &json!({"threadId":"anchor"}), &rpc)
        .await
        .unwrap();
    rpc.threads.insert(
        "stranger".into(),
        json!({"id":"stranger","sessionId":"stranger","cwd":first}),
    );
    assert!(
        command(&project, &[], "send", &json!({"threadId":"stranger"}), &rpc)
            .await
            .is_err()
    );
    assert!(
        command(
            &project,
            &[],
            "manage",
            &json!({"operation":"taskRunNow","taskId":"task"}),
            &rpc
        )
        .await
        .is_err()
    );
    rpc.receipt["data"][0]["digest"] = json!("b".repeat(64));
    assert!(
        command(&project, &[], "send", &json!({"threadId":"anchor"}), &rpc)
            .await
            .is_err()
    );
}
