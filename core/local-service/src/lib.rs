//! TUI、CLI 与可信 Desktop Main 共用的本地服务入口。
mod client;
mod spec;
pub mod storage;

pub use client::{
    bind, browser_login_url, ensure, list, probe, reconnect, restart, rpc, select, status, stop,
};
pub use spec::{LaunchSpec, LocalArgs, parse_agent_profile};

pub fn home() -> anyhow::Result<std::path::PathBuf> {
    // 服务登记可单独隔离；配置位置继续由 core/config 的 home 规则决定。
    let service_home = std::env::var_os("AREAL_HARNESS_SERVICE_HOME");
    if let Some(path) = &service_home {
        anyhow::ensure!(
            std::path::Path::new(path).is_absolute(),
            "AREAL_HARNESS_SERVICE_HOME must be absolute"
        );
    }
    let path = match service_home.or_else(|| std::env::var_os("AREAL_HARNESS_HOME")) {
        Some(path) => path.into(),
        None => std::env::home_dir()
            .ok_or_else(|| anyhow::anyhow!("home unavailable"))?
            .join(".areal"),
    };
    storage::canonical_pending(&path)
}

/// 发行包将隔离执行组件放在 libexec；源码构建仍使用同目录的 Cargo 产物。
pub fn runtime_bin_dir(bin_dir: &std::path::Path) -> std::path::PathBuf {
    let internal = bin_dir.join("../libexec/areal");
    if internal.is_dir() {
        internal
    } else {
        bin_dir.to_owned()
    }
}
