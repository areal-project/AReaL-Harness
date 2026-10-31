use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream},
};
use areal_plugins::Store;
use async_trait::async_trait;
use serde_json::json;
use std::{fs, sync::Arc};

struct Fixture;
#[async_trait]
impl Model for Fixture {
    fn name(&self) -> &str {
        "configuration-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("done"),
        )])))
    }
}

#[tokio::test]
async fn private_configuration_is_bound_only_at_connection_and_retires_old_generation() {
    let root = tempfile::tempdir().unwrap();
    for directory in [".agents/plugins", "pkg/.claude-plugin"] {
        fs::create_dir_all(root.path().join(directory)).unwrap();
    }
    fs::write(
        root.path().join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    fs::write(root.path().join("pkg/.claude-plugin/plugin.json"), json!({"name":"sample","userConfig":{"token":{"type":"string","required":true,"sensitive":true},"label":{"type":"string","default":"first"}}}).to_string()).unwrap();
    let marker = root.path().join("observed.jsonl");
    fs::write(root.path().join("pkg/server.py"), r#"import sys,json,os
with open(os.environ['MARKER'],'a') as f: f.write(json.dumps({'token':os.environ['TOKEN'],'label':os.environ['LABEL']})+'\n')
for line in sys.stdin:
 r=json.loads(line);m=r.get('method');out={}
 if 'id' not in r: continue
 if m=='server/discover':
  print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True);continue
 if m=='initialize': out={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'configured','version':'1'}}
 elif m=='tools/list': out={'tools':[{'name':'echo','inputSchema':{'type':'object'}}]}
 elif m=='tools/call': out={'content':[{'type':'text','text':'ok'}]}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':out}),flush=True)
"#).unwrap();
    fs::write(root.path().join("pkg/.mcp.json"), json!({"mcpServers":{"configured":{"command":"python3","args":["server.py"],"env":{"TOKEN":"${user_config.token}","LABEL":"${user_config.label}","MARKER":marker}}}}).to_string()).unwrap();
    let store =
        Arc::new(Store::open(root.path().join("plugins"), root.path().into(), None).unwrap());
    let detail = store.read("sample@local").unwrap();
    store
        .install(
            &detail.id,
            "user",
            detail.revision,
            &detail.source,
            detail.review_digest(),
        )
        .unwrap();
    let digest = store.read(&detail.id).unwrap().installed_digest.unwrap();
    let engine = Engine::open(
        &root.path().join("engine"),
        Arc::new(Fixture),
        Limits::default(),
    )
    .unwrap();
    engine.install_plugin_store(store.clone()).unwrap();
    engine
        .register_credential("private-ref".into(), "secret-canary-721".into())
        .unwrap();
    let missing = engine.plugin_mcp_list().await.unwrap();
    assert!(missing.to_string().contains("configurationRequired"));
    assert!(!marker.exists());
    let configure = |revision, values| {
        serde_json::from_value(json!({"requestId":format!("config-{revision}"),"id":detail.id,"expectedRevision":revision,"expectedDigest":digest,"values":values})).unwrap()
    };
    let saved = engine
        .plugin_user_configure(configure(
            store.list().unwrap().revision,
            json!({"token":{"kind":"secretRef","value":"private-ref"}}),
        ))
        .await
        .unwrap();
    assert!(!saved.to_string().contains("private-ref"));
    assert!(!saved.to_string().contains("secret-canary-721"));
    assert!(!marker.exists());
    engine
        .plugin_connection(detail.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    let first = fs::read_to_string(&marker).unwrap();
    assert!(first.contains("secret-canary-721"));
    assert!(first.contains("first"));
    let stale = store.list().unwrap().revision;
    engine
        .plugin_user_configure(configure(
            stale,
            json!({"label":{"kind":"string","value":"second"}}),
        ))
        .await
        .unwrap();
    assert!(
        engine
            .plugin_user_configure(configure(
                stale,
                json!({"label":{"kind":"string","value":"third"}})
            ))
            .await
            .is_err()
    );
    let retired = engine.plugin_mcp_list().await.unwrap();
    assert_eq!(retired["data"][0]["servers"][0]["state"], "disconnected");
    assert!(!retired.to_string().contains("private-ref"));
    assert!(!retired.to_string().contains("secret-canary-721"));
    engine
        .plugin_connection(detail.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    let observed = fs::read_to_string(&marker).unwrap();
    assert_eq!(observed.lines().count(), 2);
    assert!(
        observed
            .lines()
            .last()
            .unwrap()
            .contains("secret-canary-721")
    );
    assert!(observed.lines().last().unwrap().contains("second"));
    let serialized = serde_json::to_string(&store.read(&detail.id).unwrap()).unwrap();
    assert!(!serialized.contains("secret-canary-721"));
    assert!(!serialized.contains("private-ref"));
    engine.shutdown().await;
}

struct RetiredModel {
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
    calls: std::sync::atomic::AtomicUsize,
}
#[async_trait]
impl Model for RetiredModel {
    fn name(&self) -> &str {
        "retired-configuration"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        messages: Vec<Message>,
        tools: Vec<serde_json::Value>,
    ) -> anyhow::Result<ModelStream> {
        let round = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if round > 0 {
            let result = messages.iter().rev().find(|m| m.role == "tool").unwrap();
            assert!(
                result
                    .text_content()
                    .contains("plugin configuration generation retired"),
                "old generation did not stay retired: {}",
                result.text_content()
            );
        }
        if round == 2 {
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::text("retired twice"),
            )])));
        }
        self.entered.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        let name = tools
            .iter()
            .find_map(|t| {
                t["function"]["name"]
                    .as_str()
                    .filter(|n| n.ends_with("__app"))
            })
            .unwrap();
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: format!("retired-{round}"),
                name: name.into(),
                arguments: "{}".into(),
            }),
        )])))
    }
}

#[tokio::test]
async fn configuration_retirement_survives_package_upgrade_for_active_turn_and_app() {
    let root = tempfile::tempdir().unwrap();
    for path in [".agents/plugins", "pkg/.claude-plugin"] {
        fs::create_dir_all(root.path().join(path)).unwrap();
    }
    fs::write(
        root.path().join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    fs::write(
        root.path().join("pkg/.claude-plugin/plugin.json"),
        r#"{"name":"sample","userConfig":{"label":{"type":"string"}}}"#,
    )
    .unwrap();
    let script =
        include_str!("../../mcp/tests/substrate.py").replace("[\"app\"]", "[\"app\",\"model\"]");
    fs::write(root.path().join("pkg/server.py"), script).unwrap();
    fs::write(root.path().join("pkg/.mcp.json"), r#"{"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"LITERAL":"${user_config.label}"}}}}"#).unwrap();
    let store =
        Arc::new(Store::open(root.path().join("plugins"), root.path().into(), None).unwrap());
    let detail = store.read("sample@local").unwrap();
    store
        .install(
            &detail.id,
            "user",
            detail.revision,
            &detail.source,
            detail.review_digest(),
        )
        .unwrap();
    let digest = store.read(&detail.id).unwrap().installed_digest.unwrap();
    let model = Arc::new(RetiredModel {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        calls: Default::default(),
    });
    let engine = Engine::open(
        &root.path().join("engine"),
        model.clone(),
        Limits::default(),
    )
    .unwrap();
    engine.install_plugin_store(store.clone()).unwrap();
    let configure = |value: &str| {
        serde_json::from_value(json!({"requestId":value,"id":detail.id,"expectedRevision":store.list().unwrap().revision,"expectedDigest":digest,"values":{"label":{"kind":"string","value":value}}})).unwrap()
    };
    engine.plugin_user_configure(configure("R1")).await.unwrap();
    engine
        .plugin_connection(detail.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    let apps = engine.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let app = engine
        .mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server,
            generation,
            "app".into(),
            None,
            "open".into(),
            None,
            None,
        )
        .await
        .unwrap();
    let request = || {
        engine.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            app["instanceId"].as_str().unwrap().into(),
            generation,
            json!({"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://app"}}),
            None,
        )
    };
    engine
        .start(
            &thread.id,
            vec![areal_protocol::Input::text("use old generation twice")],
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    engine.plugin_user_configure(configure("R2")).await.unwrap();
    assert!(
        request().await.is_err(),
        "App retained a revoked configuration"
    );
    model.release.add_permits(1);
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    fs::write(root.path().join("pkg/version.txt"), "D2").unwrap();
    let detail = store.read(&detail.id).unwrap();
    engine
        .plugin_install(
            detail.id,
            "user".into(),
            detail.revision,
            detail.source,
            detail.source_digest,
        )
        .await
        .unwrap();
    assert!(
        request().await.is_err(),
        "package update revived the retired App generation"
    );
    model.release.add_permits(1);
    let finished = tokio::time::timeout(std::time::Duration::from_secs(5), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert!(
        serde_json::to_string(&finished)
            .unwrap()
            .contains("retired twice")
    );
    assert_eq!(model.calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    engine.shutdown().await;
}
