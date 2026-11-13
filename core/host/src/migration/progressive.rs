use super::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Publication {
    version: u32,
    source_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
}

impl Migration {
    pub(super) fn source_digest(&self, r: &Record) -> Result<String> {
        Ok(storage::digest(&serde_json::to_vec(&json!({
            "source":r.source,"sourceId":r.source_id,"manifestDigest":r.manifest_digest,
            "bindings":r.bindings,"originals":r.originals,"secrets":r.secrets,
        }))?))
    }

    pub(super) fn source_ready(&self, r: &Record) -> Result<bool> {
        if self.committed(r)?.is_some() {
            return Ok(true);
        }
        let publication: Option<Publication> =
            storage::read_json(&self.directory(&r.request_id)?.join("source-published.json"))?;
        let Some(publication) = publication else {
            return Ok(false);
        };
        ensure!(
            publication.version == 1
                && publication.source_digest == self.source_digest(r)?
                && publication.project_id.is_none(),
            "source publication identity changed"
        );
        Ok(true)
    }

    pub(super) fn project_ready(&self, r: &Record, binding: &Binding) -> Result<bool> {
        if self.committed(r)?.is_some() {
            return Ok(true);
        }
        if !self.source_ready(r)? {
            return Ok(false);
        }
        let publication: Option<Publication> = storage::read_json(
            &self
                .directory(&r.request_id)?
                .join("projects")
                .join(format!("{}.json", binding.alias.legacy_project_id)),
        )?;
        let Some(publication) = publication else {
            return Ok(false);
        };
        ensure!(
            publication.version == 1
                && publication.source_digest == self.source_digest(r)?
                && publication.project_id.as_deref() == Some(binding.project_id.as_str()),
            "project publication identity changed"
        );
        Ok(true)
    }

    pub(super) fn fence_file(&self, r: &mut Record, name: &str) -> Result<()> {
        let original = r
            .originals
            .iter()
            .find(|f| f.relative_name == name)
            .context("fence absent from manifest")?;
        let path = r.source.core_home.join(name);
        let bytes = storage::read_bytes(&path)?;
        let fence = self.fence_bytes(r, original)?;
        if bytes.as_deref() != Some(fence.as_slice()) {
            let matches = match (&original.original, bytes) {
                (Original::Absent, None) => true,
                (Original::Bytes { sha256, .. }, Some(bytes)) => storage::digest(&bytes) == *sha256,
                _ => false,
            };
            ensure!(
                matches,
                error(
                    "sourceChanged",
                    "project journal changed after migration snapshot"
                )
            );
            storage::write_bytes(&path, &fence)?;
        }
        if !r.fences.iter().any(|v| v == name) {
            r.fences.push(name.to_owned());
            self.save(r)?;
        }
        Ok(())
    }

    // 来源根写者与项目 Store 分别交接；已发布项目不因兄弟项目缺证而退回旧写者。
    pub(super) fn import_progressive(
        &self,
        r: &mut Record,
        connection: &str,
        existing: &[ProjectRegistration],
        journal: &crate::journal::Journal,
    ) -> Result<Value> {
        let directory = self.directory(&r.request_id)?;
        if !self.source_ready(r)? {
            self.validate_bindings(r, existing)?;
            if r.vault_receipts
                .iter()
                .any(|receipt| receipt.slot == vault::Slot::RemoteIdentity)
            {
                self.check_remote_owner(r)?;
            }
            self.verify_sources(r)?;
            ensure!(
                self.guarded(r, connection),
                error(
                    "sourceGuardRequired",
                    "source guard released before publication"
                )
            );
            r.progressive = true;
            r.phase = Phase::Fencing;
            self.save(r)?;
            self.fence_file(r, "provider-credentials.json")?;
            storage::write(
                &directory.join("source-published.json"),
                &Publication {
                    version: 1,
                    source_digest: self.source_digest(r)?,
                    project_id: None,
                },
            )?;
        }
        storage::private_dir(&directory.join("projects"))?;
        r.blockers.clear();
        for binding in r.bindings.clone() {
            if self.project_ready(r, &binding)? {
                continue;
            }
            if let Some(logical) = &binding.logical_alias {
                let parent = r
                    .bindings
                    .iter()
                    .find(|b| b.alias.legacy_project_id == logical.legacy_project_id)
                    .context("logical project missing")?;
                if !self.project_ready(r, parent)? {
                    r.blockers.push(json!({"code":"legacyPending","message":"logical project migration is pending","data":{"projectId":binding.project_id}}));
                    continue;
                }
            }
            let mut selected = r.clone();
            selected.bindings = vec![binding.clone()];
            let (locks, adoptions) = match self.legacy_locks(&selected) {
                Ok(value) => value,
                Err(error) => {
                    r.blockers.push(json!({"code":"legacyPending","message":error.to_string(),"data":{"projectId":binding.project_id}}));
                    continue;
                }
            };
            ensure!(
                self.source_ready(r)?,
                error("sourceGuardRequired", "source publication is unavailable")
            );
            self.validate_bindings(r, existing)?;
            for suffix in ["pending", "outcomes"] {
                self.fence_file(
                    r,
                    &format!("{}-{suffix}.json", binding.alias.legacy_project_id),
                )?;
            }
            let outcomes = self
                .original_json(
                    r,
                    &format!("{}-outcomes.json", binding.alias.legacy_project_id),
                )?
                .unwrap_or_else(|| json!({}));
            journal.import(&binding.project_id, outcomes)?;
            for adoption in &adoptions {
                prior_boot::revalidate(&self.home, r, adoption)?;
            }
            r.prior_boot_adoptions.extend(adoptions);
            self.save(r)?;
            storage::write(
                &directory
                    .join("projects")
                    .join(format!("{}.json", binding.alias.legacy_project_id)),
                &Publication {
                    version: 1,
                    source_digest: self.source_digest(r)?,
                    project_id: Some(binding.project_id.clone()),
                },
            )?;
            drop(locks);
        }
        if r.secrets.iter().any(|secret| {
            !r.vault_receipts.iter().any(|receipt| {
                receipt.slot == secret.slot
                    && receipt.source_digest == secret.source_digest
                    && Self::secret_ready(r, receipt)
            })
        }) {
            r.blockers.push(json!({"code":"credentialsRequired","message":"Some credential slots are still pending; completed slots remain available"}));
        }
        self.save(r)?;
        if !r.blockers.is_empty() {
            return self.result(r);
        }
        let mut receipt = json!({"requestId":r.request_id,"migrationId":r.request_id,"sourceId":r.source_id,"source":r.source,"manifestDigest":r.manifest_digest,"bindings":r.bindings,"vaultReceipts":r.vault_receipts,"fences":r.fences,"state":"completed","retirement":"pending","retainedClientData":["cloud.json"]});
        if !r.prior_boot_adoptions.is_empty() {
            receipt["priorBootAdoptions"] = serde_json::to_value(&r.prior_boot_adoptions)?;
        }
        storage::write(
            &directory.join("committed.json"),
            &Commit {
                bundle_digest: self.bundle_digest(r)?,
                receipt,
            },
        )?;
        r.phase = Phase::Committed;
        self.save(r)?;
        self.result(r)
    }
}
