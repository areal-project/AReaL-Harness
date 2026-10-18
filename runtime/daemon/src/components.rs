//! Cordis 只负责服务装配和组件生命周期；执行权限及资源事实仍由 Supervisor 持有。
use areal_runtime_exec_native::{NativeBackend, SandboxProfile};
use areal_runtime_protocol::{Error, ErrorCode, Result};
use areal_runtime_supervisor::{Config, Supervisor, backend::Backend};
use cordis::{Context, FiberHandle, FiberState, InjectSpec, Plugin, PreparedPlugin, Service};
use futures_util::FutureExt;
use std::{
    borrow::Cow,
    collections::BTreeMap,
    convert::Infallible,
    future::Future,
    sync::{Arc, Mutex},
};

struct ExecutorService(Arc<dyn Backend>);
impl Service for ExecutorService {
    const NAME: &'static str = "areal/executor";
}
struct SupervisorService(Arc<Supervisor>);
impl Service for SupervisorService {
    const NAME: &'static str = "areal/supervisor";
}

#[derive(Clone)]
enum BackendSource {
    Native { sandbox_profile: SandboxProfile },
    Attached(Arc<dyn Backend>),
}
impl BackendSource {
    async fn open(&self) -> Result<Arc<dyn Backend>> {
        match self {
            Self::Native { sandbox_profile } => Ok(Arc::new(
                NativeBackend::launch_with_profile(*sandbox_profile).await?,
            )),
            Self::Attached(backend) => Ok(backend.clone()),
        }
    }
}

// FiberHandle::dispose 的成功只表示生命周期屏障完成。Cordis 会记录并容纳
// cleanup 错误，因此必须另行保留业务清理结果，避免向 RPC 返回虚假的成功。
#[derive(Default)]
struct CleanupReport(Mutex<BTreeMap<&'static str, Result<()>>>);
impl CleanupReport {
    async fn record(
        &self,
        component: &'static str,
        cleanup: impl Future<Output = Result<()>>,
    ) -> Result<()> {
        let result = std::panic::AssertUnwindSafe(cleanup)
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(Error::new(
                    ErrorCode::CleanupFailed,
                    "component cleanup panicked",
                ))
            });
        self.0.lock().unwrap().insert(component, result.clone());
        result
    }
    fn check(&self, require_complete: bool) -> Result<()> {
        let results = self.0.lock().unwrap();
        let mut failures = Vec::new();
        for component in ["supervisor", "executor"] {
            match results.get(component) {
                Some(Ok(())) => {}
                Some(Err(error)) => failures.push(format!("{component}: {error}")),
                None if require_complete => {
                    failures.push(format!("{component}: cleanup was not confirmed"))
                }
                None => {}
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(Error::new(ErrorCode::CleanupFailed, failures.join("; ")))
        }
    }
}

/// 拥有一次 attached Runtime 的 Cordis 装配，调用方必须显式等待 shutdown。
/// 不向请求或插件调用方暴露 Cordis Context、FiberHandle 和原始执行后端。
#[must_use = "RuntimeHost must be shut down explicitly"]
pub struct RuntimeHost {
    _context: Context,
    bundle: FiberHandle,
    supervisor: Arc<Supervisor>,
    cleanup: Arc<CleanupReport>,
}
impl RuntimeHost {
    pub async fn launch(config: Config) -> Result<Arc<Self>> {
        Self::launch_with_profile(config, SandboxProfile::Native).await
    }

    pub async fn launch_with_profile(
        config: Config,
        sandbox_profile: SandboxProfile,
    ) -> Result<Arc<Self>> {
        let source = BackendSource::Native { sandbox_profile };
        Self::assemble(config, source).await
    }

    /// 嵌入式宿主交付一个后端；开始装配后由本宿主负责关闭，包括启动回滚。
    pub async fn with_backend(config: Config, backend: Arc<dyn Backend>) -> Result<Arc<Self>> {
        Self::assemble(config, BackendSource::Attached(backend)).await
    }

    async fn assemble(config: Config, source: BackendSource) -> Result<Arc<Self>> {
        let context = Context::new();
        let cleanup = Arc::new(CleanupReport::default());
        let plugin = RuntimeBundle {
            source,
            cleanup: cleanup.clone(),
        };
        let input = plugin.prepare(config).expect("infallible preparation");
        let bundle = match context
            .spawn(PreparedPlugin::from_input(plugin, input))
            .await
        {
            Ok(bundle) => bundle,
            Err(error) => {
                // 初次 apply 失败时 Cordis 已完成 bundle 回滚，仍须保留清理错误。
                cleanup.check(false)?;
                return Err(component_error(error));
            }
        };
        let service = context.try_service::<SupervisorService>();
        match service {
            Ok(service) if bundle.state() == FiberState::Active => Ok(Arc::new(Self {
                _context: context,
                bundle,
                supervisor: service.0.clone(),
                cleanup,
            })),
            _ => {
                bundle.dispose().await.map_err(component_error)?;
                cleanup.check(false)?;
                Err(component_error("Runtime components did not become active"))
            }
        }
    }

    pub fn supervisor(&self) -> Arc<Supervisor> {
        self.supervisor.clone()
    }

    pub async fn shutdown(&self) -> Result<()> {
        // 先封闭旧 Arc<Supervisor> 的准入，不能以 Service 的撤回代替权限撤销。
        self.supervisor
            .revoke(&self.supervisor.connection_info().root_scope_id)?;
        self.bundle.dispose().await.map_err(component_error)?;
        self.cleanup.check(true)
    }
}

struct RuntimeBundle {
    source: BackendSource,
    cleanup: Arc<CleanupReport>,
}
impl Plugin for RuntimeBundle {
    type Config = Config;
    type Input = Config;
    type PrepareError = Infallible;
    type ApplyError = Error;
    fn name(&self) -> Cow<'_, str> {
        Cow::Borrowed("areal/runtime")
    }
    fn prepare(&self, config: Config) -> std::result::Result<Config, Infallible> {
        Ok(config)
    }
    async fn apply(&self, ctx: Context, input: &Config) -> Result<()> {
        install(
            &ctx,
            ExecutorPlugin {
                source: self.source.clone(),
                cleanup: self.cleanup.clone(),
            },
            (),
        )
        .await?;
        install(
            &ctx,
            SupervisorPlugin {
                cleanup: self.cleanup.clone(),
            },
            input.clone(),
        )
        .await
    }
}

// Cordis 的普通 spawn 不建立清理父子关系。每次成功装配后立即登记 dispose，
// bundle 按 LIFO 先清理 Supervisor，再关闭 executor；取消启动也会走同一回滚。
async fn install<P: Plugin>(ctx: &Context, plugin: P, config: P::Config) -> Result<()> {
    let input = plugin.prepare(config).map_err(component_error)?;
    let fiber = ctx
        .spawn(PreparedPlugin::from_input(plugin, input))
        .await
        .map_err(component_error)?;
    let owned = fiber.clone();
    if let Err(error) = ctx.effect(move || async move { owned.dispose().await }) {
        fiber.dispose().await.map_err(component_error)?;
        return Err(component_error(error));
    }
    if fiber.state() != FiberState::Active {
        return Err(component_error(format!("{} is not active", fiber.name())));
    }
    Ok(())
}

struct ExecutorPlugin {
    source: BackendSource,
    cleanup: Arc<CleanupReport>,
}
impl Plugin for ExecutorPlugin {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = Error;
    fn name(&self) -> Cow<'_, str> {
        Cow::Borrowed("areal/executor")
    }
    fn prepare(&self, (): ()) -> std::result::Result<(), Infallible> {
        Ok(())
    }
    async fn apply(&self, ctx: Context, _: &()) -> Result<()> {
        let backend = self.source.open().await?;
        let owned = backend.clone();
        let report = self.cleanup.clone();
        if let Err(error) =
            ctx.effect(move || async move { report.record("executor", owned.shutdown()).await })
        {
            self.cleanup.record("executor", backend.shutdown()).await?;
            return Err(component_error(error));
        }
        let _publication = ctx
            .provide(Arc::new(ExecutorService(backend)))
            .map_err(component_error)?;
        Ok(())
    }
}

struct SupervisorPlugin {
    cleanup: Arc<CleanupReport>,
}
impl Plugin for SupervisorPlugin {
    type Config = Config;
    type Input = Config;
    type PrepareError = Infallible;
    type ApplyError = Error;
    fn name(&self) -> Cow<'_, str> {
        Cow::Borrowed("areal/supervisor")
    }
    fn inject(&self) -> InjectSpec {
        InjectSpec::none().require(ExecutorService::NAME)
    }
    fn prepare(&self, config: Config) -> std::result::Result<Config, Infallible> {
        Ok(config)
    }
    async fn apply(&self, ctx: Context, input: &Config) -> Result<()> {
        let backend = ctx
            .try_service::<ExecutorService>()
            .map_err(component_error)?;
        let supervisor = Supervisor::new(input.clone(), backend.0.clone())?;
        let owned = supervisor.clone();
        let report = self.cleanup.clone();
        if let Err(error) =
            ctx.effect(move || async move { report.record("supervisor", owned.drain()).await })
        {
            self.cleanup
                .record("supervisor", supervisor.drain())
                .await?;
            return Err(component_error(error));
        }
        let _publication = ctx
            .provide(Arc::new(SupervisorService(supervisor)))
            .map_err(component_error)?;
        Ok(())
    }
}

fn component_error(error: impl std::fmt::Display) -> Error {
    Error::new(
        ErrorCode::Unavailable,
        format!("Runtime component: {error}"),
    )
}

#[cfg(test)]
mod tests;
