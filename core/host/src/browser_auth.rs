use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const PAIRING_TTL: Duration = Duration::from_secs(120);
const CHALLENGE_TTL: Duration = Duration::from_secs(30);
const MAX_PENDING: usize = 8;
const MAX_CHALLENGES: usize = 32;
const MAX_DEVICES: usize = 64;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Device {
    device_id: String,
    public_key: String,
    scopes: Vec<Scope>,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Scope {
    Observe,
    Submit,
    Approve,
    Manage,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grants {
    version: u32,
    devices: Vec<Device>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChallengeParams {
    public_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TicketParams {
    public_key: String,
    nonce: String,
    signature: String,
}
struct Pending {
    public_key: String,
    origin: String,
    deadline: Instant,
    expires_at: u64,
}
struct Challenge {
    public_key: String,
    origin: String,
    deadline: Instant,
}

pub(crate) struct BrowserAuth {
    path: PathBuf,
    host_id: String,
    grants: Grants,
    pending: BTreeMap<String, Pending>,
    challenges: BTreeMap<String, Challenge>,
}
impl BrowserAuth {
    pub(crate) fn new(home: &Path, host_id: &str) -> Result<Self> {
        storage::private_dir(&home.join("host"))?;
        let path = home.join("host/browser-grants.json");
        let grants: Grants = storage::read_optional(&path)?.unwrap_or(Grants {
            version: 1,
            devices: Vec::new(),
        });
        ensure!(
            grants.version == 1 && grants.devices.len() <= MAX_DEVICES,
            "invalid browser grants"
        );
        let mut keys = std::collections::BTreeSet::new();
        let mut ids = std::collections::BTreeSet::new();
        for device in &grants.devices {
            public_key(&device.public_key)?;
            uuid::Uuid::parse_str(&device.device_id).context("invalid browser device identity")?;
            ensure!(
                valid_scopes(&device.scopes)
                    && keys.insert(&device.public_key)
                    && ids.insert(&device.device_id),
                "invalid browser grant"
            );
        }
        Ok(Self {
            path,
            host_id: host_id.into(),
            grants,
            pending: BTreeMap::new(),
            challenges: BTreeMap::new(),
        })
    }

    pub(crate) fn challenge(&mut self, origin: &str, params: &Value) -> Result<Value> {
        let input: ChallengeParams = serde_json::from_value(params.clone())?;
        let key = public_key(&input.public_key)?;
        self.expire();
        if self
            .grants
            .devices
            .iter()
            .any(|device| device.public_key == input.public_key)
        {
            ensure!(
                self.challenges.len() < MAX_CHALLENGES,
                crate::wire::error("resourceLimit", "too many browser challenges")
            );
            let mut bytes = [0; 32];
            SystemRandom::new()
                .fill(&mut bytes)
                .map_err(|_| anyhow::anyhow!("browser challenge generation failed"))?;
            let nonce = URL_SAFE_NO_PAD.encode(bytes);
            self.challenges.insert(
                storage::digest(nonce.as_bytes()),
                Challenge {
                    public_key: input.public_key,
                    origin: origin.into(),
                    deadline: Instant::now() + CHALLENGE_TTL,
                },
            );
            return Ok(
                json!({"state":"challenge", "nonce":nonce, "hostId":self.host_id, "expiresAt":expires_at(CHALLENGE_TTL)?}),
            );
        }
        if let Some((id, pending)) = self
            .pending
            .iter()
            .find(|(_, pending)| pending.public_key == input.public_key && pending.origin == origin)
        {
            return Ok(
                json!({"state":"pending", "requestId":id, "fingerprint":storage::digest(&key), "expiresAt":pending.expires_at}),
            );
        }
        ensure!(
            self.pending.len() < MAX_PENDING,
            crate::wire::error("resourceLimit", "too many browser pairing requests")
        );
        let request_id = uuid::Uuid::new_v4().to_string();
        let expires_at = expires_at(PAIRING_TTL)?;
        self.pending.insert(
            request_id.clone(),
            Pending {
                public_key: input.public_key,
                origin: origin.into(),
                deadline: Instant::now() + PAIRING_TTL,
                expires_at,
            },
        );
        Ok(
            json!({"state":"pending", "requestId":request_id, "fingerprint":storage::digest(&key), "expiresAt":expires_at}),
        )
    }

    pub(crate) fn approve(&mut self, request_id: &str, scopes: &Value) -> Result<Value> {
        let scopes: Vec<Scope> = if scopes.is_null() {
            vec![Scope::Observe]
        } else {
            serde_json::from_value(scopes.clone())?
        };
        ensure!(
            valid_scopes(&scopes),
            crate::wire::error(
                "invalidParams",
                "browser scopes require observe and unique supported permissions"
            )
        );
        self.expire();
        let pending = self.pending.get(request_id).ok_or_else(|| {
            crate::wire::error("notFound", "browser pairing request expired or missing")
        })?;
        if let Some(device) = self
            .grants
            .devices
            .iter()
            .find(|device| device.public_key == pending.public_key)
        {
            return Ok(json!({"deviceId":device.device_id,"scopes":device.scopes}));
        }
        ensure!(
            self.grants.devices.len() < MAX_DEVICES,
            crate::wire::error("resourceLimit", "too many approved browsers")
        );
        let device = Device {
            device_id: uuid::Uuid::new_v4().to_string(),
            public_key: pending.public_key.clone(),
            scopes,
        };
        let mut devices = self.grants.devices.clone();
        devices.push(device.clone());
        let grants = Grants {
            version: 1,
            devices,
        };
        storage::private_dir(self.path.parent().unwrap())?;
        // 既有记录的所有权和权限必须先验证，不能用原子替换掩盖异常文件。
        let _: Option<Grants> = storage::read_optional(&self.path)?;
        storage::write(&self.path, &grants)?;
        self.grants = grants;
        self.pending
            .retain(|_, pending| pending.public_key != device.public_key);
        Ok(json!({"deviceId":device.device_id,"scopes":device.scopes}))
    }

    pub(crate) fn devices(&self) -> Value {
        json!({"devices": self.grants.devices.iter().map(|device| json!({
            "deviceId": device.device_id,
            "scopes": device.scopes,
            "fingerprint": storage::digest(&public_key(&device.public_key).expect("validated browser key")),
        })).collect::<Vec<_>>()})
    }

    pub(crate) fn scopes(&self, device_id: &str) -> Option<Value> {
        self.grants
            .devices
            .iter()
            .find(|device| device.device_id == device_id)
            .map(|device| json!(device.scopes))
    }

    pub(crate) fn permits(&self, device_id: &str, capability: &str) -> bool {
        let scope = match capability {
            "observe" => Scope::Observe,
            "submit" | "interrupt" => Scope::Submit,
            "review" | "answer" => Scope::Approve,
            "manage" | "pauseTask" => Scope::Manage,
            _ => return false,
        };
        self.grants
            .devices
            .iter()
            .any(|device| device.device_id == device_id && device.scopes.contains(&scope))
    }

    pub(crate) fn current(&self, device_id: &str) -> bool {
        self.grants
            .devices
            .iter()
            .any(|device| device.device_id == device_id)
    }

    pub(crate) fn revoke(&mut self, device_id: &str) -> Result<Value> {
        uuid::Uuid::parse_str(device_id).context("invalid browser device identity")?;
        if let Some(device) = self
            .grants
            .devices
            .iter()
            .find(|device| device.device_id == device_id)
        {
            let public_key = device.public_key.clone();
            let grants = Grants {
                version: 1,
                devices: self
                    .grants
                    .devices
                    .iter()
                    .filter(|device| device.device_id != device_id)
                    .cloned()
                    .collect(),
            };
            storage::private_dir(self.path.parent().unwrap())?;
            let _: Option<Grants> = storage::read_optional(&self.path)?;
            storage::write(&self.path, &grants)?;
            self.grants = grants;
            self.pending
                .retain(|_, pending| pending.public_key != public_key);
            self.challenges
                .retain(|_, challenge| challenge.public_key != public_key);
        }
        Ok(json!({"deviceId":device_id,"revoked":true}))
    }

    pub(crate) fn authenticate(&mut self, origin: &str, params: &Value) -> Result<String> {
        let input: TicketParams = serde_json::from_value(params.clone())?;
        decode::<32>(&input.nonce)?;
        self.expire();
        // 尝试即消费，错误签名和跨源重放也不能复用这次挑战。
        let challenge = self
            .challenges
            .remove(&storage::digest(input.nonce.as_bytes()))
            .context("browser authentication failed")?;
        let key = public_key(&input.public_key)?;
        let signature = decode::<64>(&input.signature)?;
        ensure!(
            challenge.public_key == input.public_key
                && challenge.origin == origin
                && self
                    .grants
                    .devices
                    .iter()
                    .any(|device| device.public_key == input.public_key),
            "browser authentication failed"
        );
        let message = format!("{}\n{}\n{}", self.host_id, input.nonce, origin);
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, key)
            .verify(message.as_bytes(), &signature)
            .map_err(|_| anyhow::anyhow!("browser authentication failed"))?;
        Ok(self
            .grants
            .devices
            .iter()
            .find(|device| device.public_key == input.public_key)
            .context("browser authentication failed")?
            .device_id
            .clone())
    }

    fn expire(&mut self) {
        let now = Instant::now();
        self.pending.retain(|_, pending| pending.deadline > now);
        self.challenges
            .retain(|_, challenge| challenge.deadline > now);
    }
}
fn valid_scopes(scopes: &[Scope]) -> bool {
    scopes.contains(&Scope::Observe)
        && scopes.len() <= 4
        && scopes
            .iter()
            .enumerate()
            .all(|(index, scope)| !scopes[..index].contains(scope))
}

fn decode<const N: usize>(encoded: &str) -> Result<[u8; N]> {
    ensure!(
        encoded.len() == (N * 8).div_ceil(6),
        "invalid browser authentication encoding"
    );
    URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| anyhow::anyhow!("invalid browser authentication encoding"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid browser authentication length"))
}
fn public_key(encoded: &str) -> Result<[u8; 65]> {
    let bytes = decode::<65>(encoded)?;
    ensure!(bytes[0] == 4, "invalid browser public key");
    Ok(bytes)
}
fn expires_at(ttl: Duration) -> Result<u64> {
    Ok((SystemTime::now().duration_since(UNIX_EPOCH)? + ttl).as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;
    const ORIGIN: &str = "http://127.0.0.1:12345";
    fn key() -> signature::EcdsaKeyPair {
        let random = SystemRandom::new();
        let pkcs8 = signature::EcdsaKeyPair::generate_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &random,
        )
        .unwrap();
        signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8.as_ref(),
            &random,
        )
        .unwrap()
    }
    fn params(key: &signature::EcdsaKeyPair) -> Value {
        json!({"publicKey":URL_SAFE_NO_PAD.encode(key.public_key().as_ref())})
    }
    fn proof(key: &signature::EcdsaKeyPair, challenge: &Value, origin: &str) -> Value {
        let message = format!(
            "{}\n{}\n{}",
            challenge["hostId"].as_str().unwrap(),
            challenge["nonce"].as_str().unwrap(),
            origin
        );
        let signed = key.sign(&SystemRandom::new(), message.as_bytes()).unwrap();
        json!({"publicKey":params(key)["publicKey"],"nonce":challenge["nonce"],"signature":URL_SAFE_NO_PAD.encode(signed.as_ref())})
    }
    fn approved(home: &Path, key: &signature::EcdsaKeyPair) -> BrowserAuth {
        let mut auth = BrowserAuth::new(home, "host-one").unwrap();
        let pending = auth.challenge(ORIGIN, &params(key)).unwrap();
        assert_eq!(pending["state"], "pending");
        let receipt = auth
            .approve(pending["requestId"].as_str().unwrap(), &Value::Null)
            .unwrap();
        assert_eq!(receipt["scopes"], json!(["observe"]));
        auth
    }
    #[test]
    fn explicit_scopes_persist_without_promoting_existing_or_other_devices() {
        let home = tempfile::tempdir().unwrap();
        let read_key = key();
        let mut auth = approved(home.path(), &read_key);
        let reader = auth.devices()["devices"][0]["deviceId"]
            .as_str()
            .unwrap()
            .to_owned();
        let write_key = key();
        let pending = auth.challenge(ORIGIN, &params(&write_key)).unwrap();
        let request = pending["requestId"].as_str().unwrap();
        for scopes in [
            json!([]),
            json!(["manage"]),
            json!(["observe", "observe"]),
            json!(["observe", "admin"]),
        ] {
            assert!(auth.approve(request, &scopes).is_err());
        }
        let writer = auth
            .approve(request, &json!(["observe", "manage"]))
            .unwrap();
        let writer = writer["deviceId"].as_str().unwrap();
        let mut auth = BrowserAuth::new(home.path(), "host-one").unwrap();
        assert!(!auth.permits(&reader, "manage"));
        assert!(auth.permits(writer, "manage"));
        assert!(auth.permits(writer, "pauseTask"));
        assert!(!auth.permits(writer, "submit"));
        assert!(!auth.permits(writer, "answer"));
        auth.revoke(writer).unwrap();
        assert!(!auth.permits(writer, "manage"));
        assert!(auth.permits(&reader, "observe"));
    }

    #[test]
    fn approval_persists_but_challenges_do_not_and_proof_is_one_use() {
        let home = tempfile::tempdir().unwrap();
        let key = key();
        let mut auth = approved(home.path(), &key);
        let old = auth.challenge(ORIGIN, &params(&key)).unwrap();
        let old_proof = proof(&key, &old, ORIGIN);
        let mut auth = BrowserAuth::new(home.path(), "host-one").unwrap();
        assert!(auth.authenticate(ORIGIN, &old_proof).is_err());
        let challenge = auth.challenge(ORIGIN, &params(&key)).unwrap();
        let signed = proof(&key, &challenge, ORIGIN);
        auth.authenticate(ORIGIN, &signed).unwrap();
        assert!(auth.authenticate(ORIGIN, &signed).is_err());
        let stored: Value = storage::read(&home.path().join("host/browser-grants.json")).unwrap();
        assert_eq!(stored["devices"][0]["publicKey"], params(&key)["publicKey"]);
        assert!(!stored.to_string().contains(old["nonce"].as_str().unwrap()));
    }
    #[test]
    fn revoke_persists_and_invalidates_outstanding_proof_without_affecting_other_devices() {
        let home = tempfile::tempdir().unwrap();
        let key = key();
        let other = self::key();
        let mut auth = approved(home.path(), &key);
        let device_id = auth.devices()["devices"][0]["deviceId"]
            .as_str()
            .unwrap()
            .to_owned();
        let pending = auth.challenge(ORIGIN, &params(&other)).unwrap();
        let other_id = auth
            .approve(pending["requestId"].as_str().unwrap(), &Value::Null)
            .unwrap()["deviceId"]
            .as_str()
            .unwrap()
            .to_owned();
        let challenge = auth.challenge(ORIGIN, &params(&key)).unwrap();
        let proof = proof(&key, &challenge, ORIGIN);
        auth.revoke(&device_id).unwrap();
        assert!(!auth.current(&device_id));
        assert!(auth.current(&other_id));
        assert!(auth.authenticate(ORIGIN, &proof).is_err());
        auth.revoke(&device_id).unwrap();
        let mut restarted = BrowserAuth::new(home.path(), "host-one").unwrap();
        assert_eq!(restarted.devices()["devices"].as_array().unwrap().len(), 1);
        assert_eq!(restarted.devices()["devices"][0]["deviceId"], other_id);
        assert_eq!(
            restarted.challenge(ORIGIN, &params(&key)).unwrap()["state"],
            "pending"
        );
        let challenge = restarted.challenge(ORIGIN, &params(&other)).unwrap();
        assert_eq!(
            restarted
                .authenticate(ORIGIN, &self::proof(&other, &challenge, ORIGIN))
                .unwrap(),
            other_id
        );
    }

    #[test]
    fn signatures_are_bound_to_key_origin_and_host_and_failures_consume_challenge() {
        let home = tempfile::tempdir().unwrap();
        let key = key();
        let other = self::key();
        let mut auth = approved(home.path(), &key);
        for failure in ["origin", "host", "key", "signature"] {
            let challenge = auth.challenge(ORIGIN, &params(&key)).unwrap();
            let mut signed = proof(&key, &challenge, ORIGIN);
            match failure {
                "host" => {
                    let mut wrong = challenge.clone();
                    wrong["hostId"] = json!("other-host");
                    signed = proof(&key, &wrong, ORIGIN);
                }
                "key" => signed = proof(&other, &challenge, ORIGIN),
                "signature" => signed["signature"] = json!(URL_SAFE_NO_PAD.encode([0; 64])),
                _ => {}
            }
            assert!(
                auth.authenticate(
                    if failure == "origin" {
                        "http://127.0.0.1:54321"
                    } else {
                        ORIGIN
                    },
                    &signed
                )
                .is_err()
            );
            assert!(
                auth.authenticate(ORIGIN, &proof(&key, &challenge, ORIGIN))
                    .is_err()
            );
        }
    }
    #[test]
    fn pairing_and_challenges_expire_and_are_bounded() {
        let home = tempfile::tempdir().unwrap();
        let key = key();
        let mut auth = BrowserAuth::new(home.path(), "host-one").unwrap();
        let pending = auth.challenge(ORIGIN, &params(&key)).unwrap();
        assert_eq!(pending, auth.challenge(ORIGIN, &params(&key)).unwrap());
        for _ in 1..MAX_PENDING {
            auth.challenge(ORIGIN, &params(&self::key())).unwrap();
        }
        assert!(auth.challenge(ORIGIN, &params(&self::key())).is_err());
        auth.pending
            .get_mut(pending["requestId"].as_str().unwrap())
            .unwrap()
            .deadline = Instant::now();
        assert!(
            auth.approve(pending["requestId"].as_str().unwrap(), &Value::Null)
                .is_err()
        );
        let pending = auth.challenge(ORIGIN, &params(&key)).unwrap();
        auth.approve(pending["requestId"].as_str().unwrap(), &Value::Null)
            .unwrap();
        let challenge = auth.challenge(ORIGIN, &params(&key)).unwrap();
        for _ in 1..MAX_CHALLENGES {
            auth.challenge(ORIGIN, &params(&key)).unwrap();
        }
        assert!(auth.challenge(ORIGIN, &params(&key)).is_err());
        auth.challenges
            .values_mut()
            .for_each(|value| value.deadline = Instant::now());
        assert!(
            auth.authenticate(ORIGIN, &proof(&key, &challenge, ORIGIN))
                .is_err()
        );
        auth.challenge(ORIGIN, &params(&key)).unwrap();
    }
    #[test]
    fn unapproved_and_malformed_requests_cannot_authenticate_or_request_scopes() {
        let home = tempfile::tempdir().unwrap();
        let key = key();
        let mut auth = BrowserAuth::new(home.path(), "host-one").unwrap();
        let pending = auth.challenge(ORIGIN, &params(&key)).unwrap();
        assert!(pending.get("nonce").is_none());
        let challenge = json!({"hostId":"host-one","nonce":URL_SAFE_NO_PAD.encode([1;32])});
        assert!(
            auth.authenticate(ORIGIN, &proof(&key, &challenge, ORIGIN))
                .is_err()
        );
        let mut extra = params(&key);
        extra["scopes"] = json!(["admin"]);
        assert!(auth.challenge(ORIGIN, &extra).is_err());
        for bad in ["x".repeat(4096), URL_SAFE_NO_PAD.encode([0; 65]), "".into()] {
            assert!(auth.challenge(ORIGIN, &json!({"publicKey":bad})).is_err());
        }
    }
    #[test]
    fn grants_reject_symlinks_public_permissions_and_unknown_versions() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let home = tempfile::tempdir().unwrap();
        let key = key();
        let _ = approved(home.path(), &key);
        let path = home.path().join("host/browser-grants.json");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(BrowserAuth::new(home.path(), "host-one").is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        storage::write(&path, &json!({"version":2,"devices":[]})).unwrap();
        assert!(BrowserAuth::new(home.path(), "host-one").is_err());
        let target = home.path().join("grant-target");
        std::fs::rename(&path, &target).unwrap();
        symlink(target, path).unwrap();
        assert!(BrowserAuth::new(home.path(), "host-one").is_err());
    }
}
