use super::*;

#[derive(Default)]
pub(super) struct Catalog {
    value: RefCell<Option<(u64, Value)>>,
    pub(super) published: Cell<u64>,
    pub(super) requested: Notify,
    pub(super) loading: Cell<bool>,
}

impl Catalog {
    pub(super) fn request(&self, revision: u64) {
        if self
            .value
            .borrow()
            .as_ref()
            .is_some_and(|(current, _)| *current == revision)
            || self.loading.get()
        {
            return;
        }
        self.requested.notify_one();
    }

    pub(super) fn snapshot(&self, revision: u64) -> Option<Value> {
        self.value
            .borrow()
            .as_ref()
            .filter(|(current, _)| *current == revision)
            .map(|(_, value)| value.clone())
    }

    pub(super) fn latest_capabilities(&self) -> Option<Value> {
        self.value
            .borrow()
            .as_ref()
            .map(|(_, value)| value["capabilities"].clone())
            .filter(|caps| caps["methods"].is_array() && caps["features"].is_object())
    }
}

pub(super) async fn hydrate(host: &Rc<Host>, session: &Rc<CoreSession>) {
    let revision = session.model_revision.get();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        let models = session.request("areal/model/list", json!({})).await?;
        ensure!(models["data"].is_array(), unavailable());
        let capabilities = session.request("areal/capabilities", json!({})).await?;
        ensure!(
            capabilities["methods"].is_array() && capabilities["features"].is_object(),
            unavailable()
        );
        let profiles = session.request("areal/profile/list", json!({})).await?;
        ensure!(profiles["data"].is_array(), unavailable());
        let value = json!({"models":models,"capabilities":capabilities,"profiles":profiles});
        ensure!(
            serde_json::to_vec(&value)?.len() <= 2 * 1024 * 1024,
            unavailable()
        );
        Ok::<_, anyhow::Error>(value)
    })
    .await;
    session.catalog.loading.set(false);
    if !session.shared_current(host) {
        return;
    }
    if session.model_revision.get() != revision {
        // 等待期间有新目录事件，只读取最新版本；不重发任何执行请求。
        session.catalog.request(session.model_revision.get());
        return;
    }
    if let Ok(Ok(value)) = result {
        *session.catalog.value.borrow_mut() = Some((revision, value));
        session
            .catalog
            .published
            .set(session.catalog.published.get() + 1);
        host.changed();
    } else {
        // 失败仅重试公开元数据读取；延迟属于原连接 driver，关闭连接即取消。
        session.catalog.loading.set(true);
        tokio::time::sleep(Duration::from_secs(5)).await;
        session.catalog.loading.set(false);
        if session.shared_current(host) {
            session.catalog.request(session.model_revision.get());
        }
    }
}
