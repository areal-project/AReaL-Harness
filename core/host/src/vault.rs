use crate::wire::error;
use anyhow::{Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Slot {
    ProviderCredential {
        #[serde(rename = "sourceId")]
        source_id: String,
        reference: String,
    },
    SubscriptionAccount {
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
    },
    SubscriptionTransport {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    RemoteIdentity,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub request_id: String,
    pub slot: Slot,
    pub revision: u64,
    pub entry_id: String,
    pub source_digest: String,
    pub state: String,
}

pub(crate) struct Vault {
    home: PathBuf,
    #[cfg(test)]
    isolated_files: bool,
}
impl Vault {
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.to_owned(),
            #[cfg(test)]
            isolated_files: false,
        }
    }
    #[cfg(test)]
    pub fn isolated_files(home: &Path) -> Self {
        Self {
            home: home.to_owned(),
            isolated_files: true,
        }
    }
    pub fn write(&self, entry: &str, value: &Value) -> Result<()> {
        crate::wire::request_id(entry)?;
        if let Some(current) = self.read(entry)? {
            if current != *value {
                return Err(error(
                    "requestConflict",
                    "vault entry already contains a different value",
                ));
            }
            return Ok(());
        }
        let bytes = serde_json::to_vec(value)?;
        #[cfg(test)]
        if self.isolated_files {
            return self.write_file(entry, value);
        }
        #[cfg(target_os = "macos")]
        security_framework::passwords::set_generic_password(&self.service(), entry, &bytes)
            .map_err(|_| error("storageLocked", "Host Keychain write failed"))?;
        #[cfg(not(target_os = "macos"))]
        {
            let _ = bytes;
            self.write_file(entry, value)?;
        }
        ensure!(
            self.read(entry)?.as_ref() == Some(value),
            "vault read-back verification failed"
        );
        Ok(())
    }
    pub fn read(&self, entry: &str) -> Result<Option<Value>> {
        crate::wire::request_id(entry)?;
        #[cfg(test)]
        if self.isolated_files {
            return crate::migration::read_optional(&self.path(entry));
        }
        #[cfg(target_os = "macos")]
        {
            match security_framework::passwords::get_generic_password(&self.service(), entry) {
                Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
                Err(e) if e.code() == -25300 => Ok(None),
                Err(_) => Err(error("storageLocked", "Host Keychain read failed")),
            }
        }
        #[cfg(not(target_os = "macos"))]
        crate::migration::read_optional(&self.path(entry))
    }
    #[cfg(target_os = "macos")]
    fn service(&self) -> String {
        format!(
            "org.areal.host.v1.{}",
            storage::digest(self.home.as_os_str().as_encoded_bytes())
        )
    }
    #[cfg(any(test, not(target_os = "macos")))]
    fn path(&self, entry: &str) -> PathBuf {
        self.home.join("host/vault").join(format!("{entry}.json"))
    }
    #[cfg(any(test, not(target_os = "macos")))]
    fn write_file(&self, entry: &str, value: &Value) -> Result<()> {
        storage::private_dir(&self.home.join("host/vault"))?;
        std::fs::File::open(self.home.join("host"))?.sync_all()?;
        storage::write(&self.path(entry), value)?;
        ensure!(
            crate::migration::read_optional::<Value>(&self.path(entry))?.as_ref() == Some(value),
            "vault read-back verification failed"
        );
        Ok(())
    }
}
