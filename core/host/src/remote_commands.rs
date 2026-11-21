//! 远程设置复用Host Gateway权威；旧调用者的未决引用只核对原回执，不重放。
use super::{Host, library_store, loopback};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Value, json};
use std::rc::Rc;
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct RemoteCommands {
    gate: Mutex<()>,
}

// 过渡：到 0.2.0 删；旧调用方只留下引用，原回执仍由Host持有。
async fn settled(host: &Host, source: &str) -> Result<()> {
    let home = library_store::source_home(host, source)?;
    for path in [
        home.join("host-remote-operation.json"),
        home.join("host-remote-gateway-operation.json"),
        host.home.join("host/remote-command-reference.json"),
    ] {
        let Some(saved): Option<Value> = storage::read_json(&path)? else {
            continue;
        };
        ensure!(saved["version"] == 1, "INVALID_PARAMS");
        let Some(reference) = saved.get("pending").filter(|pending| !pending.is_null()) else {
            continue;
        };
        ensure!(reference["sourceId"] == source, "FORBIDDEN");
        ensure!(
            reference["expectedRevision"]
                .as_u64()
                .is_some_and(|revision| revision <= 9_007_199_254_740_991),
            "INVALID_PARAMS"
        );
        if reference.get("method").is_some() {
            ensure!(
                ["hostId", "generation"]
                    .into_iter()
                    .all(|key| reference[key]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())),
                "INVALID_PARAMS"
            );
        }
        if reference["method"] == "remote.gateway.control" {
            ensure!(
                reference["controlDigest"]
                    .as_str()
                    .is_some_and(|digest| digest.len() == 64
                        && digest.bytes().all(|byte| byte.is_ascii_hexdigit())),
                "INVALID_PARAMS"
            );
        }
        let id = reference["requestId"].as_str().context("INVALID_PARAMS")?;
        let receipt = host
            .remote
            .operation_async(id, &host.migration)
            .await?
            .context("SUBMISSION_UNKNOWN")?;
        let valid = receipt["requestId"] == id
            && receipt["sourceId"] == source
            && match reference["method"].as_str() {
                Some("remote.gateway.handoff") => {
                    receipt["method"] == "remote.gateway.handoff"
                        && receipt["hostId"] == reference["hostId"]
                        && receipt["generation"] == reference["generation"]
                        && receipt["revision"] == reference["expectedRevision"]
                }
                Some("remote.gateway.control") => {
                    receipt["controlDigest"] == reference["controlDigest"]
                        && (receipt["method"] == "remote.replace"
                            || (receipt["method"] == "remote.gateway.control"
                                && receipt["ephemeral"] == true
                                && receipt["hostId"] == reference["hostId"]
                                && receipt["generation"] == reference["generation"]))
                }
                None => {
                    receipt["method"] == "remote.replace"
                        && receipt["previousRevision"] == reference["expectedRevision"]
                }
                _ => false,
            };
        ensure!(
            valid && matches!(receipt["state"].as_str(), Some("completed" | "blocked")),
            "SUBMISSION_UNKNOWN"
        );
    }
    Ok(())
}
pub(super) async fn unresolved(host: &Host, source: &str) -> bool {
    settled(host, source).await.is_err()
}

impl RemoteCommands {
    pub(super) async fn command(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        host.migration.source_profile(source)?;
        let mut control = request.clone();
        control
            .as_object_mut()
            .context("INVALID_PARAMS")?
            .remove("requestId");
        let _: areal_protocol::host::GatewayControl =
            serde_json::from_value(control).context("INVALID_PARAMS")?;
        if let Some(id) = request.get("requestId") {
            crate::wire::request_id(id.as_str().context("INVALID_PARAMS")?)?;
        }
        let snapshot = host.remote.snapshot_async(&host.migration).await?;
        ensure!(
            snapshot["sourceId"].is_null() || snapshot["sourceId"] == source,
            "FORBIDDEN"
        );
        // 未启用的设置页读取不创建身份、不触发系统凭据写入。
        if request["operation"] == "status" {
            ensure!(
                request.as_object().is_some_and(|object| object.len() == 1),
                "INVALID_PARAMS"
            );
            return host.gateway_state_snapshot(source, snapshot);
        }
        let _guard = self.gate.lock().await;
        settled(host, source).await?;
        let snapshot = host.remote.snapshot_async(&host.migration).await?;
        ensure!(
            snapshot["sourceId"].is_null() || snapshot["sourceId"] == source,
            "FORBIDDEN"
        );
        if host.remote.native_owner()?.is_none() {
            let mut config = if snapshot["config"].is_null() {
                json!({"enabled":false,"directEnabled":false})
            } else {
                snapshot["config"].clone()
            };
            if config["schemaVersion"] != 2
                && config["devices"]
                    .as_array()
                    .is_some_and(|devices| !devices.is_empty())
            {
                let mut grants = config["deviceGrants"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for device in config["devices"].as_array().unwrap() {
                    if !grants
                        .iter()
                        .any(|grant| grant["devicePeerId"] == device["id"])
                    {
                        grants.push(json!({"devicePeerId":device["id"],"displayName":device["name"],"projectIds":device.get("projects").cloned().unwrap_or(json!([])),"capabilities":[],"revision":1,"status":"reviewRequired"}));
                    }
                }
                config["deviceGrants"] = json!(grants);
                config["enabled"] = json!(false);
                config["directEnabled"] = json!(false);
            }
            if config["enabled"] == true && config["relayProtocol"] != "areal.remote.v2" {
                config["enabled"] = json!(false);
            }
            if config.get("identity").is_none() {
                let mut seed = [0u8; 32];
                SystemRandom::new()
                    .fill(&mut seed)
                    .map_err(|_| anyhow::anyhow!("Remote identity entropy unavailable"))?;
                let identity = libp2p_identity::Keypair::ed25519_from_bytes(seed)?;
                config["identity"] = json!(STANDARD.encode(identity.to_protobuf_encoding()?));
            }
            config["schemaVersion"] = json!(2);
            let projects = host
                .migration
                .remote_projects(source, &host.registrations())?;
            if config != snapshot["config"] {
                let receipt = host.remote.dispatch_async("remote.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"sourceId":source,"expectedRevision":snapshot["revision"],"config":config}), "native-gateway", &host.identity.generation, &host.migration, &projects).await?;
                ensure!(receipt["state"] == "completed", "SUBMISSION_UNKNOWN");
            }
            let current = host.remote.snapshot_async(&host.migration).await?;
            let mut params = json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"sourceId":source,"expectedRevision":current["revision"]});
            if let Some(root) = loopback::ui_root(&host.bin) {
                params["assetRoot"] = json!(root);
            }
            host.remote
                .handoff_async(params, &host.identity, &host.migration)
                .await?;
        }
        let mut request = request.clone();
        let request_id = request
            .as_object_mut()
            .context("INVALID_PARAMS")?
            .remove("requestId")
            .unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string()));
        let id = request_id.as_str().context("INVALID_PARAMS")?;
        crate::wire::request_id(id)?;
        let path = host.home.join("host/remote-command-reference.json");
        let digest = host.intent_digest("remote.gateway.control", source, id, &request)?;
        let revision = host.remote.snapshot_async(&host.migration).await?["revision"].clone();
        storage::write(
            &path,
            &json!({"version":1,"pending":{"requestId":id,"sourceId":source,"hostId":host.identity.host_id,"generation":host.identity.generation,"method":"remote.gateway.control","expectedRevision":revision,"controlDigest":digest}}),
        )?;
        let result = host.gateway_control(json!({"requestId":request_id,"expectedGeneration":host.identity.generation,"sourceId":source,"request":request})).await;
        let not_admitted = result
            .as_ref()
            .err()
            .and_then(|error| error.downcast_ref::<crate::wire::Error>())
            .is_some_and(|error| {
                matches!(
                    error.code,
                    "unsupportedCapability"
                        | "invalidRequest"
                        | "generationMismatch"
                        | "revisionConflict"
                        | "sourceNotFound"
                        | "remoteBusy"
                        | "invalid-origin"
                        | "invalid-code"
                        | "enrollment-required"
                )
            });
        let known = if result.is_err() && !not_admitted {
            host.remote
                .operation_async(id, &host.migration)
                .await?
                .is_some_and(|receipt| {
                    matches!(receipt["state"].as_str(), Some("completed" | "blocked"))
                })
        } else {
            false
        };
        if result.is_ok() || not_admitted || known {
            storage::write(&path, &json!({"version":1,"pending":null}))?;
        }
        host.changed();
        result
    }
}
