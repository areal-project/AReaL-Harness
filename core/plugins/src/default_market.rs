//! 内置默认市场：产品指定一个 Git 市场，没登记过就登记一次，之后最多每小时拉新一次。
//! 拉取失败时登记不变，继续用上次的本地快照；用户移除后留标记，不再自动加回。
use crate::{PluginList, Store};
use anyhow::{Context, Result};
use std::{fs, time::Duration};

/// 记录默认市场的规范 URL 与上次同步时间（文件修改时间）。
const SYNCED: &str = ".default-marketplace";
/// 用户移除过默认市场。
const REMOVED: &str = ".default-marketplace-removed";
const INTERVAL: Duration = Duration::from_secs(3600);

impl Store {
    pub fn sync_default_marketplace(
        &self,
        url: &str,
        reference: &str,
        expected_revision: u64,
    ) -> Result<PluginList> {
        let url = crate::remote::normalize_git_url(url, &self.workspace)?;
        let state = self.state()?;
        let stamp = self.root.join(SYNCED);
        let Some(root) = state
            .git_marketplaces
            .iter()
            .find(|(_, pin)| pin.url == url)
            .map(|(root, _)| root.clone())
        else {
            if self.root.join(REMOVED).exists() {
                return self.list();
            }
            let list = self.add_git_marketplace(&url, Some(reference), expected_revision)?;
            fs::write(&stamp, &url)?;
            return Ok(list);
        };
        let fresh = fs::metadata(&stamp)
            .and_then(|meta| meta.modified())
            .is_ok_and(|time| time.elapsed().is_ok_and(|age| age < INTERVAL));
        if fresh {
            return self.list();
        }
        let (markets, _, _) = self.catalogs(&state);
        let name = markets
            .iter()
            .find(|market| market.root == root)
            .map(|market| market.name.clone())
            .context("default marketplace catalog unavailable")?;
        let list = self.update_selected_marketplaces(Some(&name), expected_revision)?;
        fs::write(&stamp, &url)?;
        Ok(list)
    }

    /// 用户移除的是默认市场时记下，之后同步不再加回。
    pub(crate) fn remember_default_removed(&self, url: &str) -> Result<()> {
        if fs::read_to_string(self.root.join(SYNCED)).is_ok_and(|synced| synced == url) {
            fs::write(self.root.join(REMOVED), url)?;
        }
        Ok(())
    }
}
