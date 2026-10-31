use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::{ToolExtensions, ToolPolicy},
};
use areal_protocol::Input;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

struct SearchModel {
    round: AtomicUsize,
    lazy: bool,
}
#[async_trait]
impl Model for SearchModel {
    fn name(&self) -> &str {
        "search-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        let round = self.round.fetch_add(1, Ordering::SeqCst) % 3;
        let names: Vec<_> = tools
            .iter()
            .filter_map(|d| d["function"]["name"].as_str())
            .collect();
        let mcp: Vec<_> = names.iter().filter(|n| n.starts_with("mcp__")).collect();
        let calls =
            if !self.lazy {
                assert_eq!(mcp.len(), 20);
                assert!(!names.contains(&"mcp_tool_search"));
                vec![ModelEvent::text("eager")]
            } else if round == 0 {
                assert!(mcp.is_empty(), "new Turn must not inherit schemas");
                assert!(names.contains(&"mcp_tool_search"));
                vec![
                    ModelEvent::ToolCall(ToolCall {
                        id: "search".into(),
                        name: "mcp_tool_search".into(),
                        arguments: json!({"query":"mcp__fixture__tool7","limit":1}).to_string(),
                    }),
                    ModelEvent::ToolCall(ToolCall {
                        id: "same-batch".into(),
                        name: "mcp__fixture__tool7".into(),
                        arguments: "{}".into(),
                    }),
                ]
            } else if round == 1 {
                assert_eq!(mcp, vec![&"mcp__fixture__tool7"]);
                assert!(messages.iter().any(
                    |m| m.role == "tool" && m.text_content().contains("MCP_SCHEMA_NOT_OFFERED")
                ));
                vec![ModelEvent::ToolCall(ToolCall {
                    id: "loaded".into(),
                    name: "mcp__fixture__tool7".into(),
                    arguments: "{}".into(),
                })]
            } else {
                assert!(
                    messages
                        .iter()
                        .any(|m| m.role == "tool" && m.text_content().contains("called-tool7"))
                );
                vec![ModelEvent::text("done")]
            };
        Ok(Box::pin(futures_util::stream::iter(
            calls.into_iter().map(Ok),
        )))
    }
}

#[tokio::test]
async fn schemas_load_next_request_and_reset_each_turn() {
    for lazy in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("calls.log");
        let script = root.path().join("server.py");
        std::fs::write(&script, r#"import sys,json
for line in sys.stdin:
 r=json.loads(line); m=r.get('method'); p=r.get('params',{}); out={}
 if m=='server/discover':
  print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True); continue
 if m=='initialize': out={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif m=='tools/list': out={'tools':[{'name':'tool'+str(i),'description':'Fixture action '+str(i),'inputSchema':{'type':'object','properties':{},'additionalProperties':False}} for i in range(20)]}
 elif m=='tools/call':
  with open(sys.argv[1],'a') as f: f.write(p['name']+'\n')
  out={'content':[{'type':'text','text':'called-'+p['name']}]}
 if 'id' in r: print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':out}),flush=True)
"#).unwrap();
        let servers = BTreeMap::from([(
            "fixture".into(),
            serde_json::from_value(
                json!({"transport":{"type":"stdio","command":"python3","args":[script, log]}}),
            )
            .unwrap(),
        )]);
        let env = std::env::vars_os().collect();
        let cancel = CancellationToken::new();
        let connection =
            areal_mcp::Connections::connect(&servers, &env, root.path(), cancel.clone())
                .await
                .unwrap();
        let model = Arc::new(SearchModel {
            round: AtomicUsize::new(0),
            lazy,
        });
        let engine = Engine::open_with_mcp(
            &root.path().join("state"),
            model,
            Limits::default(),
            None,
            ToolExtensions {
                policy: ToolPolicy {
                    lazy_mcp_schemas: lazy,
                    ..Default::default()
                },
                ..Default::default()
            },
            connection.tools(),
        )
        .unwrap();
        engine
            .install_plugin_store(Arc::new(
                areal_plugins::Store::open(root.path().join("plugins"), root.path().into(), None)
                    .unwrap(),
            ))
            .unwrap();
        let thread = engine
            .create(root.path().to_string_lossy().into_owned())
            .await
            .unwrap();
        for _ in 0..2 {
            engine
                .start(&thread.id, vec![Input::text("search fixture")])
                .await
                .unwrap();
            let finished =
                tokio::time::timeout(std::time::Duration::from_secs(15), engine.wait(&thread.id))
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(
                finished.turns.last().unwrap().status,
                areal_protocol::TurnStatus::Completed
            );
        }
        if lazy {
            assert_eq!(std::fs::read_to_string(&log).unwrap(), "tool7\ntool7\n");
        }
        engine.shutdown().await;
        cancel.cancel();
        drop(connection);
    }
}
