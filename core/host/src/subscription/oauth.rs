use super::{
    account::AccountRecord,
    network::{Failure, Network, Result, now_ms},
};
use jsonwebtoken::{
    Algorithm, DecodingKey, Validation, decode, decode_header,
    jwk::{AlgorithmParameters, EllipticCurve, JwkSet, KeyAlgorithm, KeyOperations, PublicKeyUse},
};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};
use url::Url;

const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
pub(super) struct OAuth {
    network: Network,
    metadata: RefCell<Option<Value>>,
    keys: RefCell<Option<JwkSet>>,
}
impl OAuth {
    pub(super) fn new(network: Network) -> Self {
        Self {
            network,
            metadata: RefCell::new(None),
            keys: RefCell::new(None),
        }
    }
    async fn metadata(&self) -> Result<Value> {
        if let Some(value) = self.metadata.borrow().clone() {
            return Ok(value);
        }
        let value = self
            .network
            .json(
                "https://auth.openai.com/.well-known/openid-configuration",
                reqwest::Method::GET,
                None,
                "authentication",
            )
            .await?;
        if value["issuer"] != ISSUER {
            return Err(Failure::new("invalid_response", "authentication"));
        }
        for field in [
            "authorization_endpoint",
            "token_endpoint",
            "jwks_uri",
            "revocation_endpoint",
        ] {
            let url = Url::parse(
                value[field]
                    .as_str()
                    .ok_or_else(|| Failure::new("invalid_response", "authentication"))?,
            )
            .map_err(|_| Failure::new("invalid_response", "authentication"))?;
            if url.origin().ascii_serialization() != ISSUER
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(Failure::new("invalid_response", "authentication"));
            }
        }
        *self.metadata.borrow_mut() = Some(value.clone());
        Ok(value)
    }
    async fn load_keys(&self, uri: &str) -> Result<()> {
        let value = self
            .network
            .json(uri, reqwest::Method::GET, None, "authentication")
            .await?;
        *self.keys.borrow_mut() = Some(
            serde_json::from_value(value)
                .map_err(|_| Failure::new("invalid_response", "authentication"))?,
        );
        Ok(())
    }
    async fn identity(&self, token: &str, client_id: &str) -> Result<Value> {
        let config = self.metadata().await?;
        let uri = config["jwks_uri"].as_str().unwrap();
        let header =
            decode_header(token).map_err(|_| Failure::new("invalid_response", "refresh"))?;
        use base64::Engine;
        let protected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(token.split('.').next().unwrap_or(""))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or_else(|| Failure::new("invalid_response", "refresh"))?;
        if protected.get("crit").is_some() || protected["b64"] == false {
            return Err(Failure::new("invalid_response", "refresh"));
        }

        if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
            return Err(Failure::new("invalid_response", "refresh"));
        }
        let empty = self.keys.borrow().is_none();
        if empty {
            self.load_keys(uri).await?;
        }
        for attempt in 0..2 {
            let matches =
                self.keys
                    .borrow()
                    .as_ref()
                    .unwrap()
                    .keys
                    .iter()
                    .filter(|key| {
                        header
                            .kid
                            .as_ref()
                            .is_none_or(|kid| key.common.key_id.as_ref() == Some(kid))
                            && key
                                .common
                                .public_key_use
                                .as_ref()
                                .is_none_or(|usage| *usage == PublicKeyUse::Signature)
                            && key.common.key_operations.as_ref().is_none_or(|operations| {
                                operations.contains(&KeyOperations::Verify)
                            })
                            && match (header.alg, key.common.key_algorithm, &key.algorithm) {
                                (
                                    Algorithm::RS256,
                                    None | Some(KeyAlgorithm::RS256),
                                    AlgorithmParameters::RSA(_),
                                ) => true,
                                (
                                    Algorithm::ES256,
                                    None | Some(KeyAlgorithm::ES256),
                                    AlgorithmParameters::EllipticCurve(curve),
                                ) if curve.curve == EllipticCurve::P256 => true,
                                _ => false,
                            }
                            && DecodingKey::from_jwk(key).is_ok()
                    })
                    .cloned()
                    .collect::<Vec<_>>();
            if matches.is_empty() && attempt == 0 {
                self.load_keys(uri).await?;
                continue;
            }
            if matches.len() != 1 {
                return Err(Failure::new("invalid_response", "refresh"));
            }
            let mut validation = Validation::new(header.alg);
            validation.set_issuer(&[ISSUER]);
            validation.set_audience(&[client_id]);
            validation.set_required_spec_claims(&["iss", "aud", "sub", "exp", "iat"]);
            validation.validate_nbf = true;
            validation.leeway = 5;
            for key in matches {
                let key = DecodingKey::from_jwk(&key)
                    .map_err(|_| Failure::new("invalid_response", "refresh"))?;
                if let Ok(decoded) = decode::<Value>(token, &key, &validation) {
                    let claims = decoded.claims;
                    if claims["iss"] != ISSUER
                        || claims["sub"].as_str().is_none_or(|sub| sub.is_empty())
                        || claims.get("nbf").is_some_and(|nbf| {
                            !nbf.as_f64().is_some_and(|nbf| {
                                nbf.is_finite() && nbf <= now_ms() as f64 / 1000.0 + 5.0
                            })
                        })
                        || !claims["iat"].as_f64().is_some_and(|iat| {
                            iat.is_finite() && iat <= now_ms() as f64 / 1000.0 + 5.0
                        })
                    {
                        return Err(Failure::new("invalid_response", "refresh"));
                    }
                    return Ok(claims);
                }
            }
            return Err(Failure::new("invalid_response", "refresh"));
        }
        Err(Failure::new("invalid_response", "refresh"))
    }
    pub(super) async fn refresh(&self, current: &AccountRecord) -> Result<AccountRecord> {
        let grant = current.grant().map_err(Failure::storage)?;
        let config = self.metadata().await?;
        let form = vec![
            ("grant_type".into(), "refresh_token".into()),
            ("client_id".into(), grant.client_id.into()),
            ("refresh_token".into(), grant.refresh.into()),
            ("resource".into(), RESOURCE.into()),
        ];
        let tokens = self
            .network
            .json(
                config["token_endpoint"].as_str().unwrap(),
                reqwest::Method::POST,
                Some(&form),
                "refresh",
            )
            .await?;
        if !tokens["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
            || tokens["access_token"].as_str().is_none_or(|s| s.is_empty())
            || tokens["refresh_token"]
                .as_str()
                .is_none_or(|s| s.is_empty())
            || !tokens["expires_in"]
                .as_f64()
                .is_some_and(|v| v.is_finite() && v > 0.0)
        {
            return Err(Failure::new("invalid_response", "refresh"));
        }
        if let Some(token) = tokens["id_token"].as_str().filter(|s| !s.is_empty()) {
            let claims = self.identity(token, grant.client_id).await?;
            if claims["sub"] != grant.subject {
                return Err(Failure::new("account_changed", "refresh"));
            }
        } else if tokens
            .get("id_token")
            .is_some_and(|v| !v.is_null() && v != &Value::String(String::new()))
        {
            return Err(Failure::new("invalid_response", "refresh"));
        }
        current.rotated(&tokens, now_ms()).map_err(Failure::storage)
    }
}

pub(super) struct LoginExchange {
    pub(super) url: String,
    pub(super) complete: futures_util::future::LocalBoxFuture<'static, Result<AccountRecord>>,
}
fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    use std::io::Read;
    let mut bytes = [0; N];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| Failure::new("network_error", "sign_in"))?;
    Ok(bytes)
}
impl OAuth {
    pub(super) async fn begin(
        self: &Rc<Self>,
        record: AccountRecord,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<LoginExchange> {
        use base64::Engine;
        use futures_util::FutureExt;
        use sha2::Digest;
        let config = self.metadata().await?;
        let saved = record.encode();
        let payload = &saved["payload"];
        let host = payload["hostId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Failure::new("credential_invalid", "sign_in"))?;
        let registered = payload["clientId"]
            .as_str()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 256
                    && *id != "dynamic_agent_client"
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            })
            .zip(payload["subject"].as_str().filter(|s| !s.is_empty()));
        let state = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<24>()?);
        let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<24>()?);
        let verifier =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<48>()?);
        let listener =
            match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 1455)).await {
                Ok(listener) => listener,
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                        .await
                        .map_err(|_| Failure::new("network_error", "sign_in"))?
                }
                Err(_) => return Err(Failure::new("network_error", "sign_in")),
            };
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener.local_addr().unwrap().port()
        );
        let mut url = Url::parse(config["authorization_endpoint"].as_str().unwrap()).unwrap();
        {
            let mut query = url.query_pairs_mut();
            query.append_pair(
                "client_id",
                registered
                    .map(|(client, _)| client)
                    .unwrap_or("dynamic_agent_client"),
            );
            if registered.is_none() {
                query.append_pair("agent_name_hint", "AReaL Harness");
            }
            for (key, value) in [
                ("ext_agent_host_id", host),
                ("response_type", "code"),
                ("redirect_uri", &redirect),
                ("resource", RESOURCE),
                (
                    "scope",
                    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                ),
                ("state", &state),
                ("nonce", &nonce),
                ("code_challenge_method", "S256"),
            ] {
                query.append_pair(key, value);
            }
            query.append_pair(
                "code_challenge",
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(sha2::Sha256::digest(verifier.as_bytes())),
            );
            if let Some(hint) = payload["idToken"].as_str().filter(|s| !s.is_empty()) {
                query.append_pair("id_token_hint", hint);
            }
            if let Some(hint) = payload["email"].as_str().filter(|s| !s.is_empty()) {
                query.append_pair("login_hint", hint);
            }
        }
        let registered =
            registered.map(|(client, subject)| (client.to_owned(), subject.to_owned()));
        let host = host.to_owned();
        let oauth = self.clone();
        let complete=async move {
            use http_body_util::Full;
            use hyper::{Response,body::Incoming,service::service_fn};
            use hyper_util::rt::TokioIo;
            let (sender,mut receiver)=tokio::sync::mpsc::channel(1);
            let claimed=Rc::new(std::cell::Cell::new(false));
            let callback=async {
                loop {
                    tokio::select! {
                        response=receiver.recv()=>return response.ok_or_else(||Failure::new("cancelled","sign_in"))?,
                        accepted=listener.accept()=>{
                            let (socket,_)=accepted.map_err(|_|Failure::new("network_error","sign_in"))?;
                            let state=state.clone();let registered=registered.clone();let sender=sender.clone();let claimed=claimed.clone();
                            let service=service_fn(move |request:hyper::Request<Incoming>| {
                                let mut status=400;let mut outcome=None;
                                if request.method()==hyper::Method::GET && !claimed.get()
                                    && let Ok(url)=Url::parse(&format!("http://127.0.0.1{}",request.uri())) {
                                        let query=url.query_pairs().into_owned().collect::<std::collections::BTreeMap<_,_>>();
                                        if url.path()=="/auth/callback" && query.get("state")==Some(&state) {
                                            claimed.set(true);
                                            let code=query.get("code").filter(|s|!s.is_empty()).cloned();let client=query.get("client_id").cloned().or_else(||registered.as_ref().map(|(client,_)|client.clone()));
                                            let valid=client.as_ref().is_some_and(|id|!id.is_empty() && id.len()<=256 && id!="dynamic_agent_client" && id.bytes().all(|b|b.is_ascii_alphanumeric() || b"._:-".contains(&b)) && registered.as_ref().is_none_or(|(saved,_)|saved==id));
                                            outcome = Some(match (code, client) { (Some(code), Some(client)) if !query.contains_key("error") && valid => {status = 200; Ok((code, client))}, _ => Err(Failure::new("invalid_response", "sign_in")) });
                                        }
                                    }
                                if let Some(outcome)=outcome {let _=sender.try_send(outcome);}
                                async move {Ok::<_,std::convert::Infallible>(Response::builder().status(status).header("connection","close").header("content-type","text/plain; charset=utf-8").body(Full::new(bytes::Bytes::from_static(if status==200 {"浏览器授权已返回，请回到 AReaL Harness 查看登录结果。".as_bytes()}else{b"Invalid authorization callback"}))).unwrap())}
                            });
                            tokio::select! {_=cancel.cancelled()=>return Err(Failure::new("cancelled","sign_in")),_=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket),service)=>{}}
                        }
                    }
                }
            };
            let (code,client)=tokio::select! {_=cancel.cancelled()=>return Err(Failure::new("cancelled","sign_in")), result=callback=>result?};
            let form=vec![("grant_type".into(),"authorization_code".into()),("client_id".into(),client.clone()),("code".into(),code),("code_verifier".into(),verifier),("redirect_uri".into(),redirect),("resource".into(),RESOURCE.into())];
            let tokens=tokio::select! {_=cancel.cancelled()=>return Err(Failure::new("cancelled","sign_in")), result=oauth.network.json(config["token_endpoint"].as_str().unwrap(),reqwest::Method::POST,Some(&form),"sign_in")=>result?};
            if !tokens["token_type"].as_str().is_some_and(|s|s.eq_ignore_ascii_case("bearer")) || tokens["access_token"].as_str().is_none_or(|s| s.is_empty()) || tokens["refresh_token"].as_str().is_none_or(|s| s.is_empty()) || !tokens["expires_in"].as_f64().is_some_and(|n|n.is_finite() && n>0.0) {return Err(Failure::new("invalid_response","sign_in"));}
            let identity=oauth.identity(tokens["id_token"].as_str().ok_or_else(||Failure::new("invalid_response","sign_in"))?,&client).await?;
            if identity["nonce"]!=nonce || registered.as_ref().is_some_and(|(_,subject)|identity["sub"]!=*subject) {return Err(Failure::new("account_changed","sign_in"));}
            AccountRecord::decode(serde_json::json!({"kind":"grant","payload":{"type":"oauth","hostId":host,"clientId":client,"subject":identity["sub"],"accountId":identity["sub"],"issuer":ISSUER,"email":identity["email"].as_str(),"idToken":tokens["id_token"],"access":tokens["access_token"],"refresh":tokens["refresh_token"],"expires":now_ms() as f64+tokens["expires_in"].as_f64().unwrap()*1000.0,"scopes":tokens["scope"].as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>()}})).map_err(Failure::storage)
        }.boxed_local();
        Ok(LoginExchange {
            url: url.to_string(),
            complete,
        })
    }
}

impl OAuth {
    pub(super) async fn revoke(
        &self,
        record: &AccountRecord,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<()> {
        let grant = record.grant().map_err(Failure::storage)?;
        let metadata = self.metadata().await?;
        let form = [
            ("token", grant.refresh),
            ("token_type_hint", "refresh_token"),
            ("client_id", grant.client_id),
        ];
        for attempt in 0..2 {
            let request = self
                .network
                .request(
                    reqwest::Method::POST,
                    metadata["revocation_endpoint"].as_str().unwrap(),
                    "logout",
                )?
                .timeout(std::time::Duration::from_secs(10))
                .form(&form);
            let response = tokio::select! {_=cancel.cancelled()=>return Err(Failure::new("cancelled","logout")),result=request.send()=>result};
            match response {
                Ok(response) if response.status() == 200 => return Ok(()),
                Ok(response) if response.status().as_u16() < 500 => break,
                _ => {}
            }
            if attempt == 0 {
                tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(std::time::Duration::from_millis(200))=>{}}
            }
        }
        Err(Failure::new("network_error", "logout"))
    }
}
