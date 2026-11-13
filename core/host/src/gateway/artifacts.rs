use super::*;
use crate::server::conversation_media::raster_info;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactRef {
    thread_id: String,
    turn_id: String,
    item_id: String,
    index: usize,
    scope: String,
}
#[derive(Serialize)]
struct Media<'a> {
    item_id: &'a str,
    index: usize,
    uri: &'a str,
    mime: &'a str,
    size: usize,
}
fn media_records<'a>(turn: &'a Value, item_id: Option<&str>) -> Vec<Media<'a>> {
    turn["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)?;
            if item_id.is_some_and(|selected| selected != id) {
                return None;
            }
            let media: Vec<_> = match item["type"].as_str() {
                Some("agentMedia") => vec![&item["media"]],
                Some("dynamicToolCall") => item["contentItems"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|part| part["type"] == "arealMedia")
                    .map(|part| &part["media"])
                    .collect(),
                _ => vec![],
            };
            Some(
                media
                    .into_iter()
                    .enumerate()
                    .filter_map(move |(index, value)| {
                        let uri = value["uri"].as_str()?;
                        let digest = uri.strip_prefix("areal://blob/")?;
                        let mime = value["mimeType"].as_str()?;
                        let size = usize::try_from(value["sizeBytes"].as_u64()?).ok()?;
                        (digest.len() == 64
                            && digest
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                            && matches!(
                                mime,
                                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                            )
                            && (1..=MAX_BYTES).contains(&size))
                        .then_some(Media {
                            item_id: id,
                            index,
                            uri,
                            mime,
                            size,
                        })
                    }),
            )
        })
        .flatten()
        .collect()
}
fn original<'a>(response: &'a Value, turn_id: &str, item_id: &str) -> Result<&'a Value> {
    let turns: Vec<_> = response["thread"]["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|turn| turn["id"] == turn_id)
        .collect();
    ensure!(turns.len() == 1, "RESOURCE_UNAVAILABLE");
    ensure!(
        turns[0]["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["id"] == item_id)
            .count()
            == 1,
        "RESOURCE_UNAVAILABLE"
    );
    Ok(turns[0])
}
impl Session {
    pub(super) fn review_artifacts(
        &self,
        project: &str,
        generation: &str,
        thread: &Value,
        turn: &Value,
        item_id: Option<&str>,
        offset: usize,
    ) -> Result<Vec<Value>> {
        if offset != 0 {
            return Ok(vec![]);
        }
        media_records(turn, item_id).into_iter().take(16).map(|media| {
            let target = json!([thread["id"],turn["id"],media.item_id,media.index]);
            let reference = ArtifactRef { thread_id: text(thread,"id")?.into(), turn_id:text(turn,"id")?.into(),item_id:media.item_id.into(),index:media.index,scope:self.scope(project,generation,&target,&serde_json::to_string(&media)?) };
            let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&reference)?);
            let mut mac = Hmac::<Sha256>::new_from_slice(&self.token_key)?;
            mac.update(body.as_bytes());
            let token = format!("{body}.{}",URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()));
            Ok(json!({"itemId":media.item_id,"mime":media.mime,"size":media.size,"artifactRef":token}))
        }).collect()
    }
    pub(super) async fn artifact(
        &self,
        project: &str,
        generation: &str,
        params: &Value,
    ) -> Result<Value> {
        ensure!(
            exact(params, &["artifactRef", "offset", "length"]),
            "INVALID_PARAMS"
        );
        let offset = params["offset"]
            .as_u64()
            .filter(|offset| *offset <= 9_007_199_254_740_991)
            .context("INVALID_PARAMS")? as usize;
        let length = params["length"].as_u64().context("INVALID_PARAMS")? as usize;
        ensure!((1..=48 * 1024).contains(&length), "INVALID_PARAMS");
        self.authorize(Some(project), "review")?;
        let token = params["artifactRef"]
            .as_str()
            .filter(|token| token.len() <= 2048)
            .context("RESOURCE_UNAVAILABLE")?;
        let (body, signature) = token.split_once('.').context("RESOURCE_UNAVAILABLE")?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.token_key)?;
        mac.update(body.as_bytes());
        mac.verify_slice(
            &URL_SAFE_NO_PAD
                .decode(signature)
                .map_err(|_| fail("RESOURCE_UNAVAILABLE"))?,
        )
        .map_err(|_| fail("RESOURCE_UNAVAILABLE"))?;
        let reference: ArtifactRef = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(body)
                .map_err(|_| fail("RESOURCE_UNAVAILABLE"))?,
        )
        .map_err(|_| fail("RESOURCE_UNAVAILABLE"))?;
        let response = self
            .rpc(
                project,
                generation,
                "thread/read",
                json!({"threadId":reference.thread_id,"includeTurns":true}),
            )
            .await?;
        let target = json!([
            reference.thread_id,
            reference.turn_id,
            reference.item_id,
            reference.index
        ]);
        let media = media_records(
            original(&response, &reference.turn_id, &reference.item_id)?,
            Some(&reference.item_id),
        )
        .into_iter()
        .find(|media| media.index == reference.index)
        .context("RESOURCE_UNAVAILABLE")?;
        ensure!(offset < media.size, "RESOURCE_UNAVAILABLE");
        let serialized = serde_json::to_string(&media)?;
        let guard = || -> Result<()> {
            self.authorize(Some(project), "review")?;
            ensure!(
                self.project(project)?.1 == generation
                    && self.scope(project, generation, &target, &serialized) == reference.scope,
                "RESYNC_REQUIRED"
            );
            Ok(())
        };
        guard()?;
        let (id, _) = self.project(project)?;
        let service = self
            .host
            .slots
            .borrow()
            .get(&id)
            .and_then(|slot| slot.service.clone())
            .context("CORE_UNAVAILABLE")?;
        let auth: Value = areal_local_service::storage::read(&service.auth_file)?;
        let token = auth["principals"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|principal| principal["id"] == "desktop-owner")
            .and_then(|principal| principal["token"].as_str())
            .context("RESOURCE_UNAVAILABLE")?;
        let mut url = url::Url::parse(&service.endpoint)?;
        let scheme = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        url.set_scheme(scheme)
            .map_err(|_| fail("RESOURCE_UNAVAILABLE"))?;
        url.set_path(&format!(
            "/areal/blobs/{}",
            media.uri.strip_prefix("areal://blob/").unwrap()
        ));
        url.set_query(None);
        url.set_fragment(None);
        url.query_pairs_mut()
            .append_pair("threadId", &reference.thread_id);
        let client = reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()?;
        let mut response = client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| fail("RESOURCE_UNAVAILABLE"))?;
        guard()?;
        ensure!(
            response.status().is_success()
                && response
                    .content_length()
                    .is_none_or(|length| length == media.size as u64),
            "RESOURCE_UNAVAILABLE"
        );
        let mut bytes = Vec::with_capacity(media.size);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| fail("RESOURCE_UNAVAILABLE"))?
        {
            guard()?;
            ensure!(
                bytes.len() + chunk.len() <= media.size,
                "RESOURCE_UNAVAILABLE"
            );
            bytes.extend_from_slice(&chunk);
        }
        ensure!(
            bytes.len() == media.size
                && format!("{:x}", Sha256::digest(&bytes))
                    == media.uri.strip_prefix("areal://blob/").unwrap(),
            "RESOURCE_UNAVAILABLE"
        );
        let raster = raster_info(&bytes, media.mime)?;
        let refreshed = self
            .rpc(
                project,
                generation,
                "thread/read",
                json!({"threadId":reference.thread_id,"includeTurns":true}),
            )
            .await?;
        ensure!(
            media_records(
                original(&refreshed, &reference.turn_id, &reference.item_id)?,
                Some(&reference.item_id)
            )
            .into_iter()
            .any(|current| current.index == media.index
                && current.uri == media.uri
                && current.mime == media.mime
                && current.size == media.size),
            "RESOURCE_UNAVAILABLE"
        );
        guard()?;
        let end = (offset + length).min(media.size);
        Ok(
            json!({"projectId":project,"threadId":reference.thread_id,"turnId":reference.turn_id,"itemId":reference.item_id,"connectionId":self.connection,"gatewayGeneration":self.generation,"serviceGeneration":generation,"artifactRef":params["artifactRef"],"offset":offset,"totalBytes":media.size,"nextOffset":(end<media.size).then_some(end),"base64":STANDARD.encode(&bytes[offset..end]),"raster":raster}),
        )
    }
}
