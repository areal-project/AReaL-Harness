use super::*;

fn source(host: &Host, source_id: &str) -> Result<Value> {
    let snapshot = host.remote.snapshot(&host.migration)?;
    ensure!(
        snapshot["sourceId"] == source_id,
        error("sourceNotFound", "Remote source does not match")
    );
    Ok(snapshot)
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn grant_projects(request: &Value) -> Result<Vec<String>> {
    let values = request["projects"]
        .as_array()
        .filter(|projects| !projects.is_empty())
        .context("Remote projects are missing")?;
    let mut projects = Vec::new();
    for value in values {
        let project = value.as_str().context("invalid Remote project")?.to_owned();
        if !projects.contains(&project) {
            projects.push(project);
        }
    }
    Ok(projects)
}
fn pair_payload(host: &Host, config: &Value, invite: &Invite) -> Result<Value> {
    let identity = wire::Identity::from_base64(
        config["identity"]
            .as_str()
            .context("Remote identity is missing")?,
    )?;
    let mut fragment = url::form_urlencoded::Serializer::new(String::new());
    fragment
        .append_pair("host", &identity.peer().to_string())
        .append_pair("invite", &invite.secret);
    let origin = if invite.transport == "relay" {
        fragment.append_pair(
            "room",
            config["room"].as_str().context("Relay room is missing")?,
        );
        config["relay"]
            .as_str()
            .context("Relay origin is missing")?
            .to_owned()
    } else {
        host.gateway
            .direct
            .borrow()
            .as_ref()
            .map(|handle| handle.origin().to_owned())
            .context("Direct is unavailable")?
    };
    Ok(json!({"payload":format!("{origin}/#{}", fragment.finish()),"expiresAt":invite.expires_at}))
}
impl Host {
    pub(in crate::server) fn gateway_state(&self, source_id: &str) -> Result<Value> {
        let snapshot = source(self, source_id)?;
        let config = &snapshot["config"];
        let identity = config["identity"]
            .as_str()
            .map(wire::Identity::from_base64)
            .transpose()?;
        let host_peer = identity
            .as_ref()
            .map(|identity| identity.peer().to_string())
            .unwrap_or_default();
        let status = self.gateway.status();
        let grants = config["deviceGrants"]
            .as_array()
            .map(|grants| {
                grants
                    .iter()
                    .map(|grant| {
                        let mut grant = grant.clone();
                        let push = grant.as_object_mut().unwrap().remove("push");
                        grant["pushRegistered"] = json!(push.is_some());
                        grant["online"] =
                            json!(
                                grant["status"] == "active"
                                    && self.gateway.active.borrow().values().any(|active| active
                                        .peer
                                        == grant["devicePeerId"]
                                        && active.revision == grant["revision"]
                                        && active.transport == transport_key(config, active.kind))
                            );
                        grant["lastSeenAt"] = self
                            .gateway
                            .last_seen
                            .borrow()
                            .get(grant["devicePeerId"].as_str().unwrap_or_default())
                            .map_or(Value::Null, |seen| json!(seen));
                        grant
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let relay = config["relay"].as_str().unwrap_or_default();
        let relay_url =
            if config["enabled"] == true && !host_peer.is_empty() && config["room"].is_string() {
                let mut fragment = url::form_urlencoded::Serializer::new(String::new());
                fragment
                    .append_pair("host", &host_peer)
                    .append_pair("room", config["room"].as_str().unwrap());
                format!("{relay}/#{}", fragment.finish())
            } else {
                String::new()
            };
        Ok(
            json!({"enabled":config["enabled"]==true,"connected":config["enabled"]==true && status["connected"]==true,"relay":relay,"relayError":if config["enabled"]==true && status["state"]=="unavailable"{"远程入口暂不可用"}else{""},"relayUrl":relay_url,"directEnabled":config["directEnabled"]==true,"directUrl":self.gateway.direct.borrow().as_ref().map(|handle|handle.origin().to_owned()).unwrap_or_default(),"directHostId":if config["directEnabled"]==true{host_peer.as_str()}else{""},"directError":self.gateway.direct_error.borrow().as_str(),"migrationError":"","pushSupported":status["pushSupported"]==true,"deviceGrants":grants,"devices":[],"pending":self.gateway.pairs.borrow().iter().filter(|(_,pair)|pair.expires_at>now() && pair.rejected.get().is_none()).map(|(peer,pair)|{let mut value=json!({"id":peer,"name":pair.name,"fingerprint":peer,"expiresAt":pair.expires_at});if let Some(kind)=&pair.client_kind{value["clientKind"]=json!(kind);}value}).collect::<Vec<_>>(),"network":{"kind":config["network"].get("kind").cloned().unwrap_or(Value::Null),"scope":config["network"].get("visibility").cloned().unwrap_or(Value::Null),"reconciliation":null,"publicOrigin":"","diagnostic":"","policy":"unknown","phoneAccess":"unknown","inspection":null}}),
        )
    }
    pub(in crate::server) async fn gateway_control(
        self: &Rc<Self>,
        params: Value,
    ) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Control {
            request_id: String,
            expected_generation: String,
            source_id: String,
            request: Value,
            #[serde(default)]
            asset_root: Option<PathBuf>,
        }
        let input: Control = serde_json::from_value(params)?;
        self.admission()?;
        crate::wire::request_id(&input.request_id)?;
        ensure!(
            input.expected_generation == self.identity.generation,
            error("generationMismatch", "Host generation changed")
        );
        ensure!(
            self.remote.native_owner()?.is_some(),
            error("nativeGatewayRequired", "Gateway handoff is required")
        );
        ensure!(
            self.receipt(&input.request_id)?.is_none(),
            error(
                "requestConflict",
                "requestId belongs to a Host lifecycle operation"
            )
        );
        if self.client_operation(&input.request_id)?.is_some()
            && self
                .remote
                .operation(&input.request_id, &self.migration)?
                .is_none()
        {
            return Err(error(
                "requestConflict",
                "requestId belongs to another domain operation",
            ));
        }
        let snapshot = source(self, &input.source_id)?;
        let digest = self.intent_digest(
            "remote.gateway.control",
            &input.source_id,
            &input.request_id,
            &input.request,
        )?;
        if let Some(receipt) = self.remote.operation(&input.request_id, &self.migration)? {
            ensure!(
                (receipt["method"] == "remote.replace"
                    || (receipt["method"] == "remote.gateway.control"
                        && receipt["ephemeral"] == true))
                    && receipt["sourceId"] == input.source_id
                    && receipt["controlDigest"] == digest,
                error("requestConflict", "Remote control parameters differ")
            );
            ensure!(
                receipt["state"] == "completed",
                error("operationPending", "Remote control is unresolved")
            );
            if input.request["operation"] == "pair" {
                let invite = self.gateway.invite.borrow();
                let invite = invite
                    .as_ref()
                    .filter(|invite| {
                        invite.request_id == input.request_id
                            && invite.digest == digest
                            && invite.expires_at > now()
                    })
                    .ok_or_else(|| {
                        error(
                            "operationExpired",
                            "Original pairing invitation is no longer available",
                        )
                    })?;
                return pair_payload(self, &snapshot["config"], invite);
            }
            return self.gateway_state(&input.source_id);
        }
        let mut prepared = None;
        let mut enrolled = false;
        let mut config = snapshot["config"].clone();
        let operation = input.request["operation"]
            .as_str()
            .context("invalid Remote operation")?;
        let fields: &[&str] = match operation {
            "status" | "disable" | "enableDirect" | "disableDirect" | "forgetRevoked"
            | "cancelPair" => &["operation"],
            "pair" => &["operation", "transport"],
            "enable" => &["operation", "relay", "code", "confirmed"],
            "revoke" | "reject" => &["operation", "id"],
            "renameDevice" => &["operation", "id", "name"],
            "updateGrant" | "approve" => &["operation", "id", "projects", "preset"],
            _ => {
                return Err(error(
                    "unsupportedCapability",
                    "Remote operation is unavailable",
                ));
            }
        };
        ensure!(
            input
                .request
                .as_object()
                .is_some_and(|request| request.keys().all(|key| fields.contains(&key.as_str()))),
            error("invalidRequest", "Remote operation fields are invalid")
        );
        match operation {
            "pair" => {
                let transport = input
                    .request
                    .get("transport")
                    .map(|transport| transport.as_str().context("invalid pairing transport"))
                    .transpose()?
                    .unwrap_or("direct");
                ensure!(
                    matches!(transport, "relay" | "direct"),
                    error("invalidRequest", "invalid pairing transport")
                );
                ensure!(
                    if transport == "relay" {
                        config["enabled"] == true && self.gateway.status()["connected"] == true
                    } else {
                        config["directEnabled"] == true && self.gateway.direct.borrow().is_some()
                    },
                    error("invalidRequest", "Connect transport before pairing")
                );
                self.gateway.cancel_pair();
                let mut random = [0; 32];
                std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut random)?;
                let invite = Invite {
                    request_id: input.request_id.clone(),
                    digest: digest.clone(),
                    secret: storage::digest(&random),
                    expires_at: now() + 120_000,
                    transport: transport.into(),
                };
                let result = pair_payload(self, &config, &invite)?;
                self.remote.save_control_receipt(
                    &input.request_id,
                    &input.source_id,
                    &self.identity,
                    &digest,
                )?;
                *self.gateway.invite.borrow_mut() = Some(invite);
                self.changed();
                return Ok(result);
            }
            "cancelPair" | "reject" => {
                if operation == "cancelPair" {
                    self.gateway.cancel_pair();
                } else if let Some(pair) = input.request["id"]
                    .as_str()
                    .and_then(|id| self.gateway.pairs.borrow().get(id).cloned())
                {
                    pair.rejected.set(Some("PAIRING_CANCELLED"));
                    pair.signal.notify_one();
                }
                self.remote.save_control_receipt(
                    &input.request_id,
                    &input.source_id,
                    &self.identity,
                    &digest,
                )?;
                self.changed();
                return self.gateway_state(&input.source_id);
            }
            "approve" => {
                let id = input.request["id"]
                    .as_str()
                    .context("Remote device is missing")?;
                let pair = self
                    .gateway
                    .pairs
                    .borrow()
                    .get(id)
                    .filter(|pair| pair.expires_at > now() && pair.rejected.get().is_none())
                    .cloned()
                    .ok_or_else(|| error("invalidRequest", "Pairing request has expired"))?;
                let projects = grant_projects(&input.request)?;
                let capabilities = match input.request["preset"].as_str() {
                    Some("Observer") => json!(["observe", "review"]),
                    Some("Operator") => json!([
                        "observe",
                        "review",
                        "submit",
                        "interrupt",
                        "answer",
                        "pauseTask"
                    ]),
                    _ => return Err(error("invalidRequest", "invalid Remote grant preset")),
                };
                let grants = config["deviceGrants"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let previous = grants.iter().find(|grant| grant["devicePeerId"] == id);
                let revision = previous
                    .and_then(|grant| grant["revision"].as_u64())
                    .unwrap_or(0)
                    .checked_add(1)
                    .filter(|revision| *revision <= 9_007_199_254_740_991)
                    .context("invalid grant revision")?;
                let taken = grants
                    .iter()
                    .filter(|grant| grant["devicePeerId"] != id && grant["status"] != "revoked")
                    .filter_map(|grant| grant["displayName"].as_str())
                    .collect::<Vec<_>>();
                let mut name = pair.name.clone();
                if taken.contains(&name.as_str()) {
                    let base = pair.name.chars().take(74).collect::<String>();
                    for index in 2..=taken.len() + 2 {
                        let candidate = format!("{base} ({index})");
                        if !taken.contains(&candidate.as_str()) {
                            name = candidate;
                            break;
                        }
                    }
                }
                let mut grant = json!({"devicePeerId":id,"displayName":name,"projectIds":projects,"capabilities":capabilities,"revision":revision,"status":"active","pairedAt":now()});
                if let Some(kind) = pair.client_kind {
                    grant["clientKind"] = json!(kind);
                }
                let mut next = grants
                    .into_iter()
                    .filter(|grant| grant["devicePeerId"] != id)
                    .collect::<Vec<_>>();
                next.push(grant);
                config["deviceGrants"] = json!(next);
            }
            "status" => return self.gateway_state(&input.source_id),
            "disable" => config["enabled"] = json!(false),
            "disableDirect" => config["directEnabled"] = json!(false),
            "enableDirect" => {
                config["directEnabled"] = json!(true);
                if self.gateway.direct.borrow().is_none() {
                    let root = input
                        .asset_root
                        .map(Ok)
                        .unwrap_or_else(|| asset_root(self))?;
                    let mut next =
                        prepare_direct(self.clone(), &config, &root)
                            .await
                            .map_err(|_| {
                                error(
                                    "invalidRequest",
                                    "Direct assets or listener are unavailable",
                                )
                            })?;
                    config["directPort"] = json!(next.handle.port());
                    next.transport = transport_key(&config, TransportKind::Direct);
                    prepared = Some(next);
                }
            }
            "enable" => {
                ensure!(
                    input.request["confirmed"] == true,
                    error("invalidRequest", "Relay confirmation is required")
                );
                let relay = enrollment::origin(&input.request["relay"])?;
                if let Some(value) = input.request.get("code") {
                    let code = enrollment::code(value)?;
                    self.remote.begin_enrollment(
                        &input.request_id,
                        &input.source_id,
                        &self.identity,
                        &digest,
                        snapshot["revision"]
                            .as_u64()
                            .context("missing Remote revision")?,
                    )?;
                    match enrollment::register(relay, code).await {
                        Ok(enrollment::Outcome::Registered(registration)) => {
                            config["room"] = registration["room"].clone();
                            config["capability"] = registration["capability"].clone();
                        }
                        Ok(enrollment::Outcome::Rejected) => {
                            self.remote.reject_enrollment(&input.request_id)?;
                            return Err(error(
                                "enrollment-failed",
                                "Relay 登记失败，请检查 HTTPS 和登记码",
                            ));
                        }
                        Ok(enrollment::Outcome::CertificateRejected(code)) => {
                            self.remote.reject_enrollment(&input.request_id)?;
                            return Err(error(
                                "enrollment-failed",
                                &format!(
                                    "Relay HTTPS 证书验证失败（{code}）。请检查证书域名、有效期和桌面进程信任的 CA。"
                                ),
                            ));
                        }
                        Err(_) => {
                            return Err(error(
                                "enrollment-failed",
                                "Relay 登记结果未知，请核查原请求；不会重复消费登记码",
                            ));
                        }
                    }
                    let mut profiles = config["relayProfiles"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    profiles.retain(|profile| profile["origin"] != relay);
                    profiles.push(json!({"origin":relay,"kind":"external","room":config["room"],"capability":config["capability"]}));
                    config["relayProfiles"] = json!(profiles);
                    config["relay"] = json!(relay);
                    config["relayProtocol"] = json!("areal.remote.v2");
                    enrolled = true;
                } else {
                    ensure!(
                        input.request["relay"] == config["relay"]
                            && config["relayProtocol"] == "areal.remote.v2"
                            && config["room"].is_string()
                            && config["capability"].is_string(),
                        error("enrollment-required", "请使用管理员登记码登记此 Relay")
                    );
                }
                config["enabled"] = json!(true);
            }
            "revoke" | "renameDevice" | "updateGrant" => {
                let id = input.request["id"]
                    .as_str()
                    .context("Remote device is missing")?;
                let grant = config["deviceGrants"]
                    .as_array_mut()
                    .and_then(|grants| grants.iter_mut().find(|grant| grant["devicePeerId"] == id))
                    .context("Remote device is unavailable")?;
                if operation == "revoke" {
                    grant.as_object_mut().unwrap().remove("push");
                    grant["status"] = json!("revoked");
                    grant["revision"] = json!(
                        grant["revision"]
                            .as_u64()
                            .and_then(|revision| revision.checked_add(1))
                            .filter(|revision| *revision <= 9_007_199_254_740_991)
                            .context("invalid grant revision")?
                    );
                    grant["revokedAt"] = json!(now());
                } else {
                    ensure!(
                        grant["status"] != "revoked",
                        error("invalidRequest", "Remote device is revoked")
                    );
                    if operation == "renameDevice" {
                        let name = input.request["name"]
                            .as_str()
                            .context("Remote device name is missing")?
                            .trim();
                        ensure!(
                            !name.is_empty() && name.chars().count() <= 80,
                            error("invalidRequest", "Remote device name is invalid")
                        );
                        grant["displayName"] = json!(name);
                    } else {
                        let projects = grant_projects(&input.request)?;
                        let caps = match input.request["preset"].as_str() {
                            Some("Observer") => json!(["observe", "review"]),
                            Some("Operator") => json!([
                                "observe",
                                "review",
                                "submit",
                                "interrupt",
                                "answer",
                                "pauseTask"
                            ]),
                            _ => {
                                return Err(error("invalidRequest", "invalid Remote grant preset"));
                            }
                        };
                        grant["projectIds"] = json!(projects);
                        grant["capabilities"] = caps;
                        grant["revision"] = json!(
                            grant["revision"]
                                .as_u64()
                                .and_then(|revision| revision.checked_add(1))
                                .filter(|revision| *revision <= 9_007_199_254_740_991)
                                .context("invalid grant revision")?
                        );
                        grant["status"] = json!("active");
                    }
                }
            }
            "forgetRevoked" => {
                let forgotten = config["deviceGrants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|grant| grant["status"] == "revoked")
                    .filter_map(|grant| grant["devicePeerId"].as_str())
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if let Some(grants) = config.get_mut("deviceGrants").and_then(Value::as_array_mut) {
                    grants.retain(|grant| !forgotten.iter().any(|id| grant["devicePeerId"] == *id));
                }
                if let Some(commands) = config.get_mut("pushCommands").and_then(Value::as_array_mut)
                {
                    commands.retain(|command| {
                        !forgotten.iter().any(|id| command["devicePeerId"] == *id)
                    });
                }
            }
            _ => {
                return Err(error(
                    "unsupportedCapability",
                    "Remote operation is unavailable",
                ));
            }
        }
        self.admission()?;
        let current = self
            .slots
            .borrow()
            .values()
            .map(|slot| slot.registration.clone())
            .collect::<Vec<_>>();
        let projects = self.migration.remote_projects(&input.source_id, &current)?;
        let replacement = json!({"requestId":input.request_id,"expectedGeneration":input.expected_generation,"expectedRevision":snapshot["revision"],"sourceId":input.source_id,"config":config,"controlDigest":digest});
        if enrolled {
            self.remote.commit_enrollment(
                replacement,
                &self.identity.generation,
                &self.migration,
                &projects,
            )?;
        } else {
            self.remote.dispatch(
                "remote.gateway.replace",
                replacement,
                "native-gateway-control",
                &self.identity.generation,
                &self.migration,
                &projects,
            )?;
        }

        if operation == "forgetRevoked" {
            for grant in snapshot["config"]["deviceGrants"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|grant| grant["status"] == "revoked")
            {
                if let Some(peer) = grant["devicePeerId"].as_str() {
                    self.gateway.last_seen.borrow_mut().remove(peer);
                }
            }
        }

        if let Some(next) = prepared {
            *self.gateway.direct.borrow_mut() = Some(next.handle.clone());
            *self.gateway.prepared_direct.borrow_mut() = Some(next);
        }
        if operation == "disableDirect" {
            self.gateway.direct_error.borrow_mut().clear();
            if let Some(handle) = self.gateway.direct.borrow_mut().take() {
                handle.stop();
            }
        }
        self.changed();
        if operation == "approve" {
            if let Some(id) = input.request["id"].as_str() {
                if let Some(pair) = self.gateway.pairs.borrow_mut().remove(id) {
                    pair.signal.notify_one();
                }
            }
        }
        if operation == "disable" || operation == "disableDirect" {
            self.gateway.cancel_pair();
        }
        self.gateway.refresh_config(&config);
        self.gateway_state(&input.source_id)
    }
}
