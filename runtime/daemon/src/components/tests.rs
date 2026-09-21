use super::*;
use areal_runtime_protocol::{LimitRequest, ScopeState, StartProcess};
use areal_runtime_supervisor::backend::{Event, Execution};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Semaphore, mpsc},
};
use tokio_util::sync::CancellationToken;

struct Executor {
    routes: Mutex<HashMap<String, mpsc::Sender<Event>>>,
    terminated: Semaphore,
    termination_gate: Semaphore,
    shutdown_entered: Semaphore,
    shutdown_gate: Semaphore,
    shutdowns: AtomicUsize,
    fail_shutdown: AtomicBool,
}
impl Executor {
    fn new(hold_termination: bool, hold_shutdown: bool) -> Arc<Self> {
        Arc::new(Self {
            routes: Mutex::new(HashMap::new()),
            terminated: Semaphore::new(0),
            termination_gate: Semaphore::new(if hold_termination { 0 } else { 100 }),
            shutdown_entered: Semaphore::new(0),
            shutdown_gate: Semaphore::new(if hold_shutdown { 0 } else { 100 }),
            shutdowns: AtomicUsize::new(0),
            fail_shutdown: AtomicBool::new(false),
        })
    }
}
#[async_trait]
impl Backend for Executor {
    async fn start(&self, execution: Execution) -> Result<mpsc::Receiver<Event>> {
        let (tx, rx) = mpsc::channel(8);
        self.routes.lock().unwrap().insert(execution.process_id, tx);
        Ok(rx)
    }
    async fn terminate(&self, id: &str) -> Result<()> {
        self.terminated.add_permits(1);
        self.termination_gate.acquire().await.unwrap().forget();
        let sender = self.routes.lock().unwrap().remove(id).unwrap();
        sender
            .send(Event::Exited {
                exit_code: Some(137),
                signal: None,
                sandbox_denied: false,
            })
            .await
            .unwrap();
        sender.send(Event::Closed).await.unwrap();
        Ok(())
    }
    async fn shutdown(&self) -> Result<()> {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
        self.shutdown_entered.add_permits(1);
        self.shutdown_gate.acquire().await.unwrap().forget();
        assert!(
            self.routes.lock().unwrap().is_empty(),
            "executor stopped before process drain"
        );
        if self.fail_shutdown.load(Ordering::SeqCst) {
            Err(Error::new(
                ErrorCode::Unavailable,
                "fixture executor cleanup failed",
            ))
        } else {
            Ok(())
        }
    }
}
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(3), future)
        .await
        .expect("component lifecycle did not settle")
}
fn request(runtime: &Supervisor) -> StartProcess {
    let connection = runtime.connection_info();
    StartProcess {
        operation_id: format!("{}:op:{}", connection.runtime_epoch, uuid::Uuid::new_v4()),
        scope_id: connection.root_scope_id,
        argv: vec!["fixture".into()],
        cwd: "workspace://repo".into(),
        env: BTreeMap::new(),
        tty: false,
        pipe_stdin: false,
        limits: LimitRequest::default(),
    }
}
fn assert_unloaded(context: &Context) {
    assert!(context.try_service::<ExecutorService>().is_err());
    assert!(context.try_service::<SupervisorService>().is_err());
    assert!(
        !context
            .runtime_snapshot()
            .fibers()
            .iter()
            .any(|fiber| fiber.name().starts_with("areal/"))
    );
}

#[tokio::test]
async fn services_are_active_and_shutdown_drains_processes_before_executor() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(true, false);
    let host = RuntimeHost::with_backend(Config::read_only(dir.path().into()), executor.clone())
        .await
        .unwrap();
    assert_eq!(host.bundle.state(), FiberState::Active);
    assert_eq!(host._context.runtime_snapshot().services().len(), 2);
    let runtime = host.supervisor();
    let root = runtime.connection_info().root_scope_id;
    runtime.start(request(&runtime)).await.unwrap();
    let closing = tokio::spawn({
        let host = host.clone();
        async move { host.shutdown().await }
    });
    bounded(executor.terminated.acquire())
        .await
        .unwrap()
        .forget();
    assert_eq!(executor.shutdowns.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.scope(&root).unwrap().state, ScopeState::Revoking);
    assert_eq!(
        runtime.start(request(&runtime)).await.unwrap_err().code,
        ErrorCode::ScopeClosed
    );
    executor.termination_gate.add_permits(1);
    bounded(closing).await.unwrap().unwrap();
    assert_eq!(runtime.scope(&root).unwrap().state, ScopeState::Closed);
    assert_eq!(executor.shutdowns.load(Ordering::SeqCst), 1);
    assert_unloaded(&host._context);
    bounded(host.shutdown()).await.unwrap();
    assert_eq!(executor.shutdowns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_supervisor_start_rolls_back_the_executor_plugin() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false, false);
    let mut config = Config::read_only(dir.path().into());
    config.max_scopes = 0;
    let result = bounded(RuntimeHost::with_backend(config, executor.clone())).await;
    assert!(result.is_err());
    assert_eq!(executor.shutdowns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_shutdown_waiter_does_not_abandon_component_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false, true);
    let host = RuntimeHost::with_backend(Config::read_only(dir.path().into()), executor.clone())
        .await
        .unwrap();
    let closing = tokio::spawn({
        let host = host.clone();
        async move { host.shutdown().await }
    });
    bounded(executor.shutdown_entered.acquire())
        .await
        .unwrap()
        .forget();
    closing.abort();
    assert!(closing.await.unwrap_err().is_cancelled());
    executor.shutdown_gate.add_permits(1);
    bounded(host.shutdown()).await.unwrap();
    assert_eq!(executor.shutdowns.load(Ordering::SeqCst), 1);
    assert_unloaded(&host._context);
}

#[tokio::test]
async fn cleanup_failure_reaches_connection_close_and_is_retained() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false, false);
    executor.fail_shutdown.store(true, Ordering::SeqCst);
    let host = RuntimeHost::with_backend(Config::read_only(dir.path().into()), executor.clone())
        .await
        .unwrap();
    let (client, server) = tokio::io::duplex(8192);
    let (read, write) = tokio::io::split(server);
    let service = tokio::spawn(crate::serve(
        read,
        write,
        host.clone(),
        CancellationToken::new(),
    ));
    let (read, mut write) = tokio::io::split(client);
    let mut lines = BufReader::new(read).lines();
    for request in [
        json!({"id":1,"method":"connection.open","params":{"protocolVersion":areal_runtime_protocol::VERSION}}),
        json!({"id":2,"method":"connection.close","params":{}}),
    ] {
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let response: Value =
            serde_json::from_str(&bounded(lines.next_line()).await.unwrap().unwrap()).unwrap();
        if request["id"] == 1 {
            assert!(response.get("result").is_some());
        } else {
            assert_eq!(response["error"]["code"], "CLEANUP_FAILED");
        }
    }
    assert_eq!(
        bounded(service).await.unwrap().unwrap_err().code,
        ErrorCode::CleanupFailed
    );
    assert_eq!(
        host.shutdown().await.unwrap_err().code,
        ErrorCode::CleanupFailed
    );
    assert_eq!(executor.shutdowns.load(Ordering::SeqCst), 1);
    assert_unloaded(&host._context);
}

struct BlockedPlugin {
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Plugin for BlockedPlugin {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = Error;
    fn name(&self) -> Cow<'_, str> {
        Cow::Borrowed("areal/blocked")
    }
    fn prepare(&self, (): ()) -> std::result::Result<(), Infallible> {
        Ok(())
    }
    async fn apply(&self, _: Context, _: &()) -> Result<()> {
        self.entered.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        Ok(())
    }
}
struct BlockedBundle {
    executor: Arc<Executor>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Plugin for BlockedBundle {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = Error;
    fn name(&self) -> Cow<'_, str> {
        Cow::Borrowed("areal/blocked-bundle")
    }
    fn prepare(&self, (): ()) -> std::result::Result<(), Infallible> {
        Ok(())
    }
    async fn apply(&self, ctx: Context, _: &()) -> Result<()> {
        install(
            &ctx,
            ExecutorPlugin {
                source: BackendSource::Attached(self.executor.clone()),
                cleanup: Arc::new(CleanupReport::default()),
            },
            (),
        )
        .await?;
        install(
            &ctx,
            BlockedPlugin {
                entered: self.entered.clone(),
                release: self.release.clone(),
            },
            (),
        )
        .await
    }
}

#[tokio::test]
async fn cancelled_bundle_start_disposes_already_installed_children() {
    let context = Context::new();
    let executor = Executor::new(false, false);
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let plugin = BlockedBundle {
        executor: executor.clone(),
        entered: entered.clone(),
        release: release.clone(),
    };
    let starting = tokio::spawn({
        let ctx = context.clone();
        async move { ctx.spawn(PreparedPlugin::from_input(plugin, ())).await }
    });
    bounded(entered.acquire()).await.unwrap().forget();
    assert!(context.try_service::<ExecutorService>().is_ok());
    starting.abort();
    assert!(starting.await.unwrap_err().is_cancelled());
    release.add_permits(1);
    bounded(executor.shutdown_entered.acquire())
        .await
        .unwrap()
        .forget();
    bounded(async {
        while context
            .runtime_snapshot()
            .fibers()
            .iter()
            .any(|fiber| fiber.name().starts_with("areal/"))
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_unloaded(&context);
    assert_eq!(executor.shutdowns.load(Ordering::SeqCst), 1);
}
