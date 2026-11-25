use super::*;
use tokio::net::TcpListener;

struct Call {
    request: Value,
    answers: mpsc::UnboundedSender<Value>,
}
impl Call {
    fn reply(self, result: Value) {
        self.answers
            .send(json!({"id":self.request["id"],"result":result}))
            .unwrap();
    }
    fn unknown(self) {
        self.answers.send(json!({"id":self.request["id"],"error":{"code":-32010,"message":"unknown","data":{"reason":"MODEL_CONFIGURATION_UNKNOWN"}}})).unwrap();
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    host: Rc<Host>,
    session: Rc<CoreSession>,
    calls: mpsc::UnboundedReceiver<Call>,
    server: AbortHandle,
    runner: AbortHandle,
    path: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.runner.abort();
        self.session.close();
        self.server.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().canonicalize().unwrap();
        let mut base = crate::server::schedules::tests::fixture(&directory);
        Rc::get_mut(&mut base.migration).unwrap().vault =
            crate::vault::Vault::isolated_files(&base.home);
        let source = crate::migration::Source {
            profile: directory.join("profile"),
            core_home: directory.join("data"),
            legacy_service_home: directory.join("legacy"),
        };
        storage::private_dir(&source.profile).unwrap();
        storage::private_dir(&source.core_home).unwrap();
        storage::write(&source.core_home.join("projects.json"), &json!([])).unwrap();
        base.migration
            .attach(source.clone(), "fixture", None)
            .unwrap();
        base.migration.import(serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":base.identity.generation,"source":source})).unwrap(),"fixture",&[],&base.journal).unwrap();
        base.slots
            .borrow_mut()
            .get_mut("project")
            .unwrap()
            .registration
            .source = crate::ProjectSource::Gui {
            profile: source.profile,
            legacy_project_id: "logical".into(),
        };
        let registration = base.slots.borrow()["project"].registration.clone();
        let launch = LaunchInputs {
            workspace: registration.workspace.clone(),
            cwd: registration.workspace.clone(),
            config_home: directory.join(".areal"),
            homedir: Some(directory.clone()),
            config_path: None,
            deployment_path: None,
            schedule_preparation: None,
            environment: Default::default(),
            credential_names: vec![],
            options: Default::default(),
        };
        let launch_path = base
            .home
            .join("host/launch")
            .join(storage::digest(b"project"))
            .join("inputs.json");
        storage::private_dir(launch_path.parent().unwrap()).unwrap();
        storage::write(&launch_path, &launch).unwrap();
        let path = directory.join(".areal/config.toml");
        storage::private_dir(path.parent().unwrap()).unwrap();
        std::fs::write(&path,"schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='https://example.invalid/v1/responses'\nprotocol='responses'\nmodels=[{id='fixture'}]\n").unwrap();
        let host = Rc::new(base);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = Service {
            identity: areal_protocol::service::Identity {
                protocol_version: 1,
                service_id: "service".into(),
                generation: "generation".into(),
                workspace: registration.workspace,
                data_dir: registration.data_dir,
                config_fingerprint: "fixture".into(),
            },
            owner: Some(host.owner()),
            endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
            web_url: String::new(),
            auth_file: host.home.join("auth-core.json"),
            log_file: host.home.join("core.log"),
            host_pid: 1,
            core_pid: 2,
            state: areal_protocol::service::State::Ready,
        };
        storage::write(
            &service.auth_file,
            &json!({"principals":[{"id":"desktop-owner","token":"fixture"}]}),
        )
        .unwrap();
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            slot.state = "ready".into();
            slot.service = Some(service.clone());
            let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
            slot.writer = Some(writer);
            slot.lifetime = Some(Rc::new(lifetime));
        }
        let (sender, calls) = mpsc::unbounded_channel();
        let server = tokio::task::spawn_local(async move {
            let (stream,_) = listener.accept().await.unwrap();
            let socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let (mut writer,mut reader) = socket.split();
            let (answers,mut replies) = mpsc::unbounded_channel::<Value>();
            loop {
                tokio::select! {
                    Some(value) = replies.recv() => {if writer.send(Message::Text(value.to_string().into())).await.is_err(){break;}},
                    message = reader.next() => {
                        let Some(Ok(Message::Text(text))) = message else {break;};
                        let request:Value=serde_json::from_str(&text).unwrap();
                        if request["method"] == "initialize" {
                            writer.send(Message::Text(json!({"id":request["id"],"result":{}}).to_string().into())).await.unwrap();
                        } else if request.get("id").is_some()
                            && sender.send(Call{request,answers:answers.clone()}).is_err() { break; }
                    }
                }
            }
        }).abort_handle();
        let session = connect(host.clone(), "project", service).await.unwrap();
        session.ready.set(true);
        host.schedules
            .connections
            .sessions
            .borrow_mut()
            .insert("project".into(), session.clone());
        assert!(
            session.current(&host),
            "fixture must install a current execution connection"
        );
        assert!(
            desired(&host, &session).unwrap().is_some(),
            "fixture must have a committed credential source"
        );
        let runner = tokio::task::spawn_local(run(host.clone(), session.clone())).abort_handle();
        Self {
            _root: root,
            host,
            session,
            calls,
            server,
            runner,
            path,
        }
    }
    async fn call(&mut self, method: &str) -> Call {
        let call = tokio::time::timeout(Duration::from_secs(5), self.calls.recv())
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "Core did not receive {method}: {error}; application={}",
                    self.session.model_application.read()
                )
            })
            .unwrap();
        assert_eq!(call.request["method"], method);
        call
    }
    fn proof(&self, revision: &str, sequence: u64) -> Value {
        json!({"serviceId":"service","generation":"generation","applied":{"revision":revision,"sequence":sequence},"credentialStates":{},"modelRevision":"model"})
    }
    fn change(&self, name: &str) -> String {
        let launch = inputs(&self.host, "project").unwrap();
        let inputs = crate::launch::config_inputs(&self.host.home, &launch, &BTreeMap::new());
        let mut current = areal_config::models::read(&inputs, &[]).unwrap();
        current.data[0].name = name.into();
        let result = areal_config::models::write(
            &inputs,
            areal_config::models::ModelConfigurationUpdate {
                expected_revision: current.revision,
                data: current.data,
                default_model: current.default_model,
            },
            &[],
        )
        .unwrap();
        self.host.changed();
        result.revision
    }
}

#[tokio::test(flavor = "current_thread")]
async fn unknown_original_apply_is_not_replayed_and_new_desired_configuration_can_advance() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let before = f.call("areal/server/modelConfiguration/read").await;
            let first = f.change("First desired");
            before.reply(f.proof("old", 0));
            // 第一轮捕获了旧文件版本，下一轮才允许对新意图准入。
            let next = f.call("areal/server/modelConfiguration/read").await;
            next.reply(f.proof("old", 0));
            f.call("areal/server/status")
                .await
                .reply(json!({"restartSafe":true}));
            let apply = f.call("areal/server/modelConfiguration/apply").await;
            assert_eq!(apply.request["params"]["targetRevision"], first);
            let original = apply.request["params"]["requestId"]
                .as_str()
                .unwrap()
                .to_owned();
            apply.unknown();
            let read = f.call("areal/server/modelConfiguration/read").await;
            assert_eq!(read.request["params"]["requestId"], original);
            let mut unknown = f.proof("old", 0);
            unknown["operation"] = json!({"requestId":original,"state":"unknown"});
            read.reply(unknown.clone());
            let read = f.call("areal/server/modelConfiguration/read").await;
            assert_eq!(read.request["params"]["requestId"], original);
            read.reply(unknown.clone());
            f.call("areal/server/modelConfiguration/read")
                .await
                .reply(f.proof("old", 0));
            let second = f.change("Second desired");
            let read = f.call("areal/server/modelConfiguration/read").await;
            assert_eq!(read.request["params"]["requestId"], original);
            read.reply(unknown);
            f.call("areal/server/modelConfiguration/read")
                .await
                .reply(f.proof("old", 0));
            f.call("areal/server/status")
                .await
                .reply(json!({"restartSafe":true}));
            let apply = f.call("areal/server/modelConfiguration/apply").await;
            assert_eq!(apply.request["params"]["targetRevision"], second);
            let next = apply.request["params"]["requestId"]
                .as_str()
                .unwrap()
                .to_owned();
            assert_ne!(next, original);
            apply.reply(f.proof(&second, 1));
            let read = f.call("areal/server/modelConfiguration/read").await;
            assert_eq!(read.request["params"]["requestId"], next);
            let mut applied = f.proof(&second, 1);
            applied["operation"] =
                json!({"requestId":next,"state":"applied","result":f.proof(&second,1)});
            let mut changes = f.host.changes.subscribe();
            read.reply(applied);
            tokio::time::timeout(Duration::from_secs(5), async {
                while f.session.model_application.read()["kind"] != "applied" {
                    changes.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
            let (_, journal) = f.host.journal.native_snapshot(&scope("project")).unwrap();
            assert_eq!(journal["pending"].as_array().unwrap().len(), 1);
            assert_eq!(journal["pending"][0]["params"]["requestId"], original);
            assert!(journal["pending"][0]["params"].get("credentials").is_none());
            assert_eq!(
                journal["outcomes"][&next]["response"]["result"]["applied"]["revision"],
                second
            );
            assert!(
                std::fs::read_to_string(&f.path)
                    .unwrap()
                    .contains("Second desired")
            );
        })
        .await;
}

impl Fixture {
    async fn applied(&mut self, apply: Call, revision: &str, sequence: u64) -> String {
        let id = apply.request["params"]["requestId"]
            .as_str()
            .unwrap()
            .to_owned();
        apply.reply(self.proof(revision, sequence));
        let read = self.call("areal/server/modelConfiguration/read").await;
        assert_eq!(read.request["params"]["requestId"], id);
        let mut proof = self.proof(revision, sequence);
        proof["operation"] =
            json!({"requestId":id,"state":"applied","result":self.proof(revision,sequence)});
        let mut changes = self.host.changes.subscribe();
        read.reply(proof);
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.session.model_application.read()["kind"] != "applied" {
                changes.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        id
    }
}

#[tokio::test(flavor = "current_thread")]
async fn busy_project_defers_without_admission_then_applies_when_idle() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let initial = f.call("areal/server/modelConfiguration/read").await;
            let revision = desired(&f.host, &f.session)
                .unwrap()
                .unwrap()
                .document
                .revision;
            initial.reply(f.proof("old", 0));
            f.call("areal/server/status")
                .await
                .reply(json!({"restartSafe":false}));
            let read = f.call("areal/server/modelConfiguration/read").await;
            assert_eq!(f.session.model_application.read()["kind"], "deferred");
            assert!(
                f.host.journal.native_snapshot(&scope("project")).unwrap().1["pending"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            read.reply(f.proof("old", 0));
            f.call("areal/server/status")
                .await
                .reply(json!({"restartSafe":true}));
            let apply = f.call("areal/server/modelConfiguration/apply").await;
            assert_eq!(apply.request["params"]["targetRevision"], revision);
            f.applied(apply, &revision, 1).await;
            assert!(
                f.host.journal.native_snapshot(&scope("project")).unwrap().1["pending"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn known_rejection_waits_for_explicit_intent_before_new_application() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let revision = desired(&f.host,&f.session).unwrap().unwrap().document.revision;
        f.call("areal/server/modelConfiguration/read").await.reply(f.proof("old",0));
        f.call("areal/server/status").await.reply(json!({"restartSafe":true}));
        let apply = f.call("areal/server/modelConfiguration/apply").await;
        let original = apply.request["params"]["requestId"].as_str().unwrap().to_owned();
        apply.unknown();
        let read = f.call("areal/server/modelConfiguration/read").await;
        let mut rejected = f.proof("old",0);
        rejected["operation"] = json!({"requestId":original,"state":"rejected","error":{"code":-32010,"message":"rejected","data":{"reason":"INVALID_CONFIGURATION"}}});
        read.reply(rejected);
        let read = f.call("areal/server/modelConfiguration/read").await;
        assert_eq!(f.session.model_application.read()["kind"],"failed");
        // 第二轮仍只读；明确重试意图才允许新准入，配置文件不需要改写。
        let command = uuid::Uuid::new_v4().to_string();
        let source = desired(&f.host,&f.session).unwrap().unwrap().source;
        intent(&f.host,"project",&source,&command,&revision).unwrap();
        intent(&f.host,"project",&source,&command,&revision).unwrap();
        read.reply(f.proof("old",0));
        f.call("areal/server/modelConfiguration/read").await.reply(f.proof("old",0));
        f.call("areal/server/status").await.reply(json!({"restartSafe":true}));
        let apply = f.call("areal/server/modelConfiguration/apply").await;
        assert_ne!(apply.request["params"]["requestId"],original);
        let next = f.applied(apply,&revision,1).await;
        let journal = f.host.journal.native_snapshot(&scope("project")).unwrap().1;
        assert_eq!(journal["outcomes"][original]["response"]["error"]["data"]["reason"],"INVALID_CONFIGURATION");
        assert_eq!(journal["outcomes"][next]["response"]["result"]["applied"]["revision"],revision);
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn replaced_generation_cannot_publish_late_configuration_proof() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let read = f.call("areal/server/modelConfiguration/read").await;
            let revision = desired(&f.host, &f.session)
                .unwrap()
                .unwrap()
                .document
                .revision;
            f.host
                .slots
                .borrow_mut()
                .get_mut("project")
                .unwrap()
                .service
                .as_mut()
                .unwrap()
                .identity
                .generation = "replacement".into();
            read.reply(f.proof(&revision, 1));
            tokio::task::yield_now().await;
            assert_ne!(f.session.model_application.read()["kind"], "applied");
            assert!(
                f.host.journal.native_snapshot(&scope("project")).unwrap().1["pending"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn stored_credentials_only_enter_private_core_apply_and_never_application_journal() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let read = f.call("areal/server/modelConfiguration/read").await;
        let source = desired(&f.host,&f.session).unwrap().unwrap().source;
        let reference = "AREAL_CREDENTIAL_fixture";
        f.host.migration.vault.dispatch_async("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),
            "expectedGeneration":f.host.identity.generation,"expectedRevision":0,
            "slot":{"kind":"providerCredential","sourceId":source,"reference":reference},"value":"synthetic-model-application-key"}),
            &f.host.identity.generation,&f.host.migration).await.unwrap();
        let launch = inputs(&f.host,"project").unwrap();
        let config = crate::launch::config_inputs(&f.host.home,&launch,&BTreeMap::new());
        let mut current = areal_config::models::read(&config,&[reference.into()]).unwrap();
        current.data[0].api_key_env = Some(reference.into());
        let written = areal_config::models::write(&config,areal_config::models::ModelConfigurationUpdate {
            expected_revision:current.revision,data:current.data,default_model:current.default_model,
        },&[reference.into()]).unwrap();
        f.host.changed();
        read.reply(f.proof("old",0));
        f.call("areal/server/modelConfiguration/read").await.reply(f.proof("old",0));
        f.call("areal/server/status").await.reply(json!({"restartSafe":true}));
        let apply = f.call("areal/server/modelConfiguration/apply").await;
        assert_eq!(apply.request["params"]["credentials"][reference],"synthetic-model-application-key");
        let id = apply.request["params"]["requestId"].as_str().unwrap().to_owned();
        let mut result = f.proof(&written.revision,1);
        result["credentialStates"]["fixture"] = json!("available");
        apply.reply(result.clone());
        let read = f.call("areal/server/modelConfiguration/read").await;
        let mut proof = result.clone();
        proof["operation"] = json!({"requestId":id,"state":"applied","result":result});
        let mut changes = f.host.changes.subscribe();
        read.reply(proof);
        tokio::time::timeout(Duration::from_secs(5),async {
            while f.session.model_application.read()["kind"] != "applied" { changes.changed().await.unwrap(); }
        }).await.unwrap();
        let journal = f.host.journal.native_snapshot(&scope("project")).unwrap().1;
        assert!(journal["outcomes"][id]["response"]["result"].is_object());
        assert!(!journal.to_string().contains("synthetic-model-application-key"));
        assert!(!std::fs::read_to_string(&f.path).unwrap().contains("synthetic-model-application-key"));
    }).await;
}
