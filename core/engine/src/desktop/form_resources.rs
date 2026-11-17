//! Explicit picker grants belong to one pending form field and the caller's lifetime.
use super::*;
use std::path::PathBuf;
#[derive(Default)]
pub(super) struct Uploads {
    selections: BTreeMap<String, Selection>,
    grants: BTreeMap<String, Grant>,
}
#[derive(Clone)]
struct Selection {
    form: String,
    field: String,
    owner: CallOwner,
    server: String,
    generation: u64,
    user_options: Value,
    multiple: bool,
}
struct Grant {
    selection: Selection,
    path: PathBuf,
    root: PathBuf,
    bytes: u64,
    files: usize,
}
pub(super) fn supported_user_options(input: &Value) -> bool {
    input.get("userOptions").is_none_or(|o| {
        o.as_object()
            .is_some_and(|m| m.keys().all(|k| matches!(k.as_str(), "kind" | "accept")))
            && o.get("kind")
                .is_none_or(|v| matches!(v.as_str(), Some("file" | "directory")))
            && o.get("accept").is_none_or(|v| {
                v.as_array().is_some_and(|a| {
                    a.len() <= 64
                        && a.iter()
                            .all(|s| s.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128))
                })
            })
    })
}
impl Engine {
    pub async fn mcp_form_resource_prepare(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        request_id: String,
        field_name: String,
    ) -> Result<Value> {
        let forms = self.desktop.mcp_interactions.forms.lock().await;
        let form = forms.get(&request_id).ok_or(Error::NotFound)?;
        if form.owner.identity != identity
            || form.owner.thread != thread_id
            || form.request.cancellation.is_cancelled()
        {
            return Err(invalid("form owner mismatch or expired"));
        }
        self.validate_mcp_owner(&form.owner).await?;
        let (_, server) = self
            .plugin_server(&form.request.server, form.request.generation)
            .await?;
        if !server.is_local_stdio() {
            return Err(invalid(
                "RESOURCE_UPLOAD_UNSUPPORTED: resource upload transport is unavailable for this server",
            ));
        }
        let field = &form.request.params["requestedSchema"]["properties"][&field_name];
        let input = &field["x-openai-input"];
        if !matches!(input["type"].as_str(), Some("resource" | "file"))
            || !supported_user_options(input)
        {
            return Err(invalid("field does not support user resources"));
        }
        let options = if let Some(options) = input.get("userOptions") {
            options.clone()
        } else if field["type"] == "array" && input["selection"] == "implicit" {
            json!({"kind":"file"})
        } else {
            return Err(invalid("field does not permit user resources"));
        };
        let selection = Selection {
            form: request_id,
            field: field_name,
            owner: form.owner.clone(),
            server: form.request.server.clone(),
            generation: form.request.generation,
            user_options: options.clone(),
            multiple: field["type"] == "array",
        };
        let multiple = selection.multiple;
        let token = id();
        {
            let mut uploads = self.desktop.mcp_interactions.uploads.lock().await;
            if let Some((token, _)) = uploads.selections.iter().find(|(_, s)| {
                s.form == selection.form
                    && s.field == selection.field
                    && s.owner.token == selection.owner.token
            }) {
                return Ok(
                    json!({"selectionToken":token,"userOptions":options,"multiple":multiple,"serverLabel":server.name()}),
                );
            }
            if uploads.selections.len() >= 256 {
                return Err(invalid("resource selection capacity reached"));
            }
            uploads.selections.insert(token.clone(), selection.clone());
        }
        let engine = Arc::downgrade(self);
        let cancellation = selection.owner.cancellation.clone();
        let owner_token = selection.owner.token.clone();
        self.tasks.spawn(async move {
            cancellation.cancelled().await;
            if let Some(engine) = engine.upgrade() {
                engine.cleanup_form_uploads(&owner_token).await;
            }
        });
        Ok(
            json!({"selectionToken":token,"userOptions":options,"multiple":multiple,"serverLabel":server.name()}),
        )
    }
    /// Called only by trusted Main; the app-server wraps this in its durable management submission.
    pub async fn mcp_form_resource_stage(
        self: &Arc<Self>,
        identity: String,
        selection_token: String,
        paths: Vec<PathBuf>,
    ) -> Result<Value> {
        let selection = self
            .desktop
            .mcp_interactions
            .uploads
            .lock()
            .await
            .selections
            .get(&selection_token)
            .cloned()
            .ok_or(Error::NotFound)?;
        if selection.owner.identity != identity || (!selection.multiple && paths.len() != 1) {
            return Err(invalid("picker selection owner or cardinality mismatch"));
        }
        self.check_pending_selection(&selection).await?;
        let staging = self.store.root().join("desktop/mcp-form-uploads");
        // Only Core's own private directory is canonicalized; selected paths are descriptor-opened unchanged.
        std::fs::create_dir_all(&staging).map_err(invalid)?;
        let root = staging
            .canonicalize()
            .map_err(invalid)?
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).map_err(invalid)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(invalid)?;
        }
        let kind = if selection.user_options["kind"] == "directory" {
            areal_runtime_fs::ImportKind::Directory
        } else {
            areal_runtime_fs::ImportKind::File
        };
        let accept = selection.user_options["accept"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let destination = root.clone();
        let imported = tokio::task::spawn_blocking(move || {
            areal_runtime_fs::import_selection(&paths, &destination, kind, &accept)
        })
        .await
        .map_err(invalid);
        let imported = match imported.and_then(|r| r.map_err(invalid)) {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&root);
                return Err(e);
            }
        };
        if let Err(e) = self.check_pending_selection(&selection).await {
            let _ = std::fs::remove_dir_all(&root);
            return Err(e);
        }
        let pending = self.desktop.mcp_interactions.forms.lock().await;
        if pending.get(&selection.form).is_none_or(|f| {
            f.owner.token != selection.owner.token || f.request.cancellation.is_cancelled()
        }) {
            drop(pending);
            let _ = std::fs::remove_dir_all(&root);
            return Err(invalid("picker form ended"));
        }
        let mut uploads = self.desktop.mcp_interactions.uploads.lock().await;
        if selection.owner.cancellation.is_cancelled() {
            drop(uploads);
            let _ = std::fs::remove_dir_all(&root);
            return Err(invalid("picker caller ended"));
        }
        let retained = uploads
            .grants
            .values()
            .filter(|g| g.selection.owner.token == selection.owner.token)
            .fold((0u64, 0usize), |(bytes, files), g| {
                (bytes + g.bytes, files + g.files)
            });
        if uploads.grants.len() + imported.entries.len() > 256
            || retained.0 + imported.total_bytes > 64 * 1024 * 1024
            || retained.1 + imported.file_count > 256
        {
            drop(uploads);
            let _ = std::fs::remove_dir_all(&root);
            return Err(invalid("operation upload budget exceeded"));
        }
        let mut resources = Vec::new();
        for entry in imported.entries {
            let uri = format!("areal-mcp-resource://{}", id());
            resources.push(
                json!({"uri":uri,"name":entry.name,"mimeType":entry.mime_type,"size":entry.size}),
            );
            uploads.grants.insert(
                uri,
                Grant {
                    selection: selection.clone(),
                    path: entry.path,
                    root: root.clone(),
                    bytes: entry.size,
                    files: entry.file_count,
                },
            );
        }
        Ok(
            json!({"resources":resources,"summary":{"fileCount":imported.file_count,"totalBytes":imported.total_bytes}}),
        )
    }
    async fn check_pending_selection(&self, selection: &Selection) -> Result<()> {
        self.validate_mcp_owner(&selection.owner).await?;
        self.plugin_server(&selection.server, selection.generation)
            .await?;
        let forms = self.desktop.mcp_interactions.forms.lock().await;
        let form = forms.get(&selection.form).ok_or(Error::NotFound)?;
        if form.owner.token != selection.owner.token || form.request.cancellation.is_cancelled() {
            return Err(invalid("picker form ended"));
        }
        Ok(())
    }
    pub async fn mcp_form_resource_release(
        &self,
        identity: String,
        thread_id: String,
        request_id: String,
        field_name: String,
        uri: String,
    ) -> Result<Value> {
        let selection = {
            let uploads = self.desktop.mcp_interactions.uploads.lock().await;
            let Some(grant) = uploads.grants.get(&uri) else {
                return Ok(json!({"released":true}));
            };
            grant.selection.clone()
        };
        if selection.owner.identity != identity
            || selection.owner.thread != thread_id
            || selection.form != request_id
            || selection.field != field_name
        {
            return Err(invalid("resource grant owner mismatch"));
        }
        self.check_pending_selection(&selection).await?;
        let pending = self.desktop.mcp_interactions.forms.lock().await;
        if pending.get(&request_id).is_none_or(|f| {
            f.owner.token != selection.owner.token || f.request.cancellation.is_cancelled()
        }) {
            return Err(invalid("form ended"));
        }
        let mut uploads = self.desktop.mcp_interactions.uploads.lock().await;
        let Some(grant) = uploads.grants.remove(&uri) else {
            return Ok(json!({"released":true}));
        };
        let root_unused = !uploads.grants.values().any(|g| g.root == grant.root);
        drop(uploads);
        if root_unused {
            std::fs::remove_dir_all(&grant.root).map_err(invalid)?;
        } else {
            std::fs::remove_dir_all(
                grant
                    .path
                    .parent()
                    .ok_or_else(|| invalid("invalid staging slot"))?,
            )
            .map_err(invalid)?;
        }

        Ok(json!({"released":true}))
    }
    async fn cleanup_form_uploads(&self, owner: &str) {
        let mut uploads = self.desktop.mcp_interactions.uploads.lock().await;
        let roots = uploads
            .grants
            .values()
            .filter(|g| g.selection.owner.token == owner)
            .map(|g| g.root.clone())
            .collect::<std::collections::BTreeSet<_>>();
        uploads
            .grants
            .retain(|_, g| g.selection.owner.token != owner);
        uploads.selections.retain(|_, s| s.owner.token != owner);
        drop(uploads);
        for root in roots {
            let _ = std::fs::remove_dir_all(root);
        }
    }
    pub(super) async fn resolve_form_resources(
        &self,
        request_id: &str,
        form: &Form,
        response: &mut Value,
    ) -> Result<Value> {
        let mut schema = form.request.params["requestedSchema"].clone();
        let uploads = self.desktop.mcp_interactions.uploads.lock().await;
        if let Some(properties) = schema["properties"].as_object_mut() {
            for (field, definition) in properties {
                let Some(selected) = response["content"].get_mut(field) else {
                    continue;
                };
                let values = if let Some(a) = selected.as_array_mut() {
                    a.iter_mut().collect::<Vec<_>>()
                } else {
                    vec![selected]
                };
                for value in values {
                    let Some(uri) = value.as_str() else {
                        continue;
                    };
                    let Some(grant) = uploads.grants.get(uri) else {
                        continue;
                    };
                    if grant.selection.form != request_id
                        || grant.selection.field != *field
                        || grant.selection.owner.token != form.owner.token
                        || grant.selection.owner.cancellation.is_cancelled()
                    {
                        return Err(invalid("resource selection belongs to another form"));
                    }
                    let target = reqwest::Url::from_file_path(&grant.path)
                        .map_err(|_| invalid("invalid staged file URI"))?
                        .to_string();
                    *value = Value::String(target.clone());
                    definition["x-openai-input"]["options"]
                        .as_array_mut()
                        .ok_or_else(|| invalid("invalid resource options"))?
                        .push(json!({"uri":target,"name":"user selection"}));
                }
            }
        }
        Ok(schema)
    }
}
