use anyhow::{Context, Result, ensure};
use areal_protocol::service::Service;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MediaParams {
    pub view: String,
    pub thread_id: String,
    pub subscription_id: String,
    pub service_generation: String,
    pub source_thread_id: Option<String>,
    pub turn_id: String,
    pub item_id: String,
    pub uri: String,
    pub offset: Option<usize>,
    pub length: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MediaReference {
    pub source_thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub uri: String,
    mime: Option<String>,
    size: Option<usize>,
}

impl MediaReference {
    pub fn requested(params: &MediaParams) -> Result<Self> {
        digest(&params.uri)?;
        let source = params
            .source_thread_id
            .as_deref()
            .unwrap_or(&params.thread_id);
        ensure!(
            [source, params.turn_id.as_str(), params.item_id.as_str()]
                .iter()
                .all(|id| !id.is_empty() && id.len() <= 256),
            "INVALID_PARAMS"
        );
        Ok(Self {
            source_thread_id: source.into(),
            turn_id: params.turn_id.clone(),
            item_id: params.item_id.clone(),
            uri: params.uri.clone(),
            mime: None,
            size: None,
        })
    }
    pub fn matches(&self, params: &MediaParams) -> bool {
        self.source_thread_id
            == params
                .source_thread_id
                .as_deref()
                .unwrap_or(&params.thread_id)
            && self.turn_id == params.turn_id
            && self.item_id == params.item_id
            && self.uri == params.uri
    }
}

fn digest(uri: &str) -> Result<&str> {
    let digest = uri
        .strip_prefix("areal://blob/")
        .context("RESOURCE_UNAVAILABLE")?;
    ensure!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "RESOURCE_UNAVAILABLE"
    );
    Ok(digest)
}

fn supported_mime(mime: &str) -> bool {
    mime.len() <= 128
        && mime.split_once('/').is_some_and(|(kind, subtype)| {
            !kind.is_empty()
                && !subtype.is_empty()
                && kind.bytes().chain(subtype.bytes()).all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-' | b'_')
                })
        })
}

pub(super) fn item_references(
    source_thread_id: &str,
    turn_id: &str,
    item: &Value,
) -> Vec<MediaReference> {
    let Some(item_id) = item["id"].as_str() else {
        return vec![];
    };
    if [source_thread_id, turn_id, item_id]
        .iter()
        .any(|id| id.is_empty() || id.len() > 256)
    {
        return vec![];
    }
    let reference = |uri: &str, mime: Option<&str>, size: Option<usize>| {
        if digest(uri).is_err() {
            return None;
        }
        Some(MediaReference {
            source_thread_id: source_thread_id.into(),
            turn_id: turn_id.into(),
            item_id: item_id.into(),
            uri: uri.into(),
            mime: mime.map(str::to_owned),
            size,
        })
    };
    let media = |value: &Value| {
        reference(
            value["uri"].as_str()?,
            Some(value["mimeType"].as_str()?),
            Some(usize::try_from(value["sizeBytes"].as_u64()?).ok()?),
        )
    };
    match item["type"].as_str() {
        Some("agentMedia") => media(&item["media"]).into_iter().collect(),
        Some("dynamicToolCall") => item["contentItems"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| part["type"] == "arealMedia")
            .filter_map(|part| media(&part["media"]))
            .collect(),
        Some("userMessage") => item["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| matches!(part["type"].as_str(), Some("image" | "audio" | "file")))
            .filter_map(|part| reference(part["url"].as_str()?, None, None))
            .collect(),
        _ => vec![],
    }
}

pub(super) fn snapshot_references(snapshot: &Value) -> Vec<MediaReference> {
    let Some(thread_id) = snapshot["thread"]["id"].as_str() else {
        return vec![];
    };
    snapshot["thread"]["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|item| {
                    item_references(thread_id, turn["id"].as_str().unwrap_or(""), item)
                })
        })
        .collect()
}

pub(super) fn page_references(page: &Value) -> Vec<MediaReference> {
    page["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            if entry["sourceItemId"] != entry["item"]["id"] {
                return vec![];
            }
            item_references(
                entry["sourceThreadId"].as_str().unwrap_or(""),
                entry["sourceTurnId"].as_str().unwrap_or(""),
                &entry["item"],
            )
        })
        .collect()
}

pub(super) struct MediaCache {
    pub reference: MediaReference,
    bytes: Vec<u8>,
    mime: String,
    raster: Option<Value>,
}
impl MediaCache {
    pub fn chunk(&self, offset: usize, length: usize) -> Result<Value> {
        ensure!(
            offset < self.bytes.len() || (offset == 0 && self.bytes.is_empty()),
            "RESOURCE_UNAVAILABLE"
        );
        ensure!((1..=64 * 1024).contains(&length), "INVALID_PARAMS");
        let end = offset.saturating_add(length).min(self.bytes.len());
        let mut result = json!({"sourceThreadId":self.reference.source_thread_id,"turnId":self.reference.turn_id,"itemId":self.reference.item_id,"uri":self.reference.uri,"mimeType":self.mime,"offset":offset,"totalBytes":self.bytes.len(),"nextOffset":(end < self.bytes.len()).then_some(end),"base64":STANDARD.encode(&self.bytes[offset..end])});
        if let Some(raster) = &self.raster {
            result["raster"] = raster.clone();
        }
        Ok(result)
    }
}

/// Core 的 blob HTTP 入口只认本机主人令牌；地址由 Core 服务登记给出，不写进构建产物。
fn core_blob_url(service: &Service, path: &str, thread_id: &str) -> Result<(url::Url, String)> {
    let auth: Value = areal_local_service::storage::read(&service.auth_file)
        .map_err(|_| anyhow::anyhow!("RESOURCE_UNAVAILABLE"))?;
    let token = auth["principals"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|principal| principal["id"] == "desktop-owner")
        .and_then(|principal| principal["token"].as_str())
        .filter(|token| !token.is_empty())
        .context("RESOURCE_UNAVAILABLE")?
        .to_owned();
    let mut url =
        url::Url::parse(&service.endpoint).map_err(|_| anyhow::anyhow!("RESOURCE_UNAVAILABLE"))?;
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "RESOURCE_UNAVAILABLE"
    );
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        _ => anyhow::bail!("RESOURCE_UNAVAILABLE"),
    };
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("RESOURCE_UNAVAILABLE"))?;
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut().append_pair("threadId", thread_id);
    Ok((url, token))
}

fn core_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?)
}

/// 桌面附件上传：Core 按内容寻址去重，同一份字节重发只会得到同一个 URI。
pub(crate) async fn upload(
    service: &Service,
    thread_id: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> Result<Value> {
    upload_owned(service, thread_id, mime, bytes, None, None).await
}
pub(crate) async fn upload_owned(
    service: &Service,
    thread_id: &str,
    mime: &str,
    bytes: Vec<u8>,
    call: Option<&str>,
    generation: Option<&str>,
) -> Result<Value> {
    ensure!(call.is_some() == generation.is_some(), "INVALID_PARAMS");
    let (mut url, token) = core_blob_url(service, "/areal/blobs", thread_id)?;
    if let (Some(call), Some(generation)) = (call, generation) {
        url.query_pairs_mut()
            .append_pair("callId", call)
            .append_pair("hostGeneration", generation);
    }
    upload_to(url, token, mime, bytes).await
}
async fn upload_to(url: url::Url, token: String, mime: &str, bytes: Vec<u8>) -> Result<Value> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BYTES,
        "LIMIT_EXCEEDED"
    );
    let expected = format!("areal://blob/{:x}", Sha256::digest(&bytes));
    let size = bytes.len() as u64;
    let response = core_client()?
        .post(url)
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, mime)
        .body(bytes)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("SUBMISSION_UNKNOWN"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| anyhow::anyhow!("SUBMISSION_UNKNOWN"))?;
    match status.as_u16() {
        200 | 201 => {}
        400 => match body["error"]["code"].as_i64() {
            Some(-32001) => anyhow::bail!("LIMIT_EXCEEDED"),
            Some(-32004 | -32009) => anyhow::bail!("RESOURCE_UNAVAILABLE"),
            Some(-32000) => anyhow::bail!("CORE_UNAVAILABLE"),
            // 请求形状已由 Host 校验；Core 的其余 400 都是拒收这份内容（类型、签名或编码）。
            _ => anyhow::bail!("ATTACHMENT_UNSUPPORTED"),
        },
        401 | 403 | 404 => anyhow::bail!("RESOURCE_UNAVAILABLE"),
        _ => anyhow::bail!("CORE_UNAVAILABLE"),
    }
    ensure!(
        body["uri"] == expected.as_str()
            && body["sizeBytes"] == size
            && body["mimeType"].as_str().is_some_and(|m| !m.is_empty()),
        "CORE_UNAVAILABLE"
    );
    Ok(json!({"uri":body["uri"],"mimeType":body["mimeType"],"sizeBytes":size}))
}

pub(super) async fn fetch(
    service: &Service,
    thread_id: &str,
    reference: MediaReference,
    guard: impl Fn() -> Result<()>,
) -> Result<MediaCache> {
    guard()?;
    ensure!(
        reference.mime.as_deref().is_none_or(supported_mime)
            && reference.size.is_none_or(|size| size <= MAX_BYTES),
        "RESOURCE_UNAVAILABLE"
    );
    let (url, token) = core_blob_url(
        service,
        &format!("/areal/blobs/{}", digest(&reference.uri)?),
        thread_id,
    )?;
    let response = core_client()?.get(url).bearer_auth(token).send().await;
    guard()?;
    let mut response = response.map_err(|_| anyhow::anyhow!("RESOURCE_UNAVAILABLE"))?;
    ensure!(response.status().is_success(), "RESOURCE_UNAVAILABLE");
    if let Some(size) = response.content_length() {
        ensure!(
            size <= MAX_BYTES as u64
                && reference
                    .size
                    .is_none_or(|expected| expected as u64 == size),
            "RESOURCE_UNAVAILABLE"
        );
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = response.chunk().await;
        guard()?;
        let Some(chunk) = chunk.map_err(|_| anyhow::anyhow!("RESOURCE_UNAVAILABLE"))? else {
            break;
        };
        ensure!(
            bytes.len() + chunk.len() <= reference.size.unwrap_or(MAX_BYTES),
            "RESOURCE_UNAVAILABLE"
        );
        bytes.extend_from_slice(&chunk);
    }
    ensure!(
        reference.size.is_none_or(|size| size == bytes.len())
            && format!("{:x}", Sha256::digest(&bytes)) == digest(&reference.uri)?,
        "RESOURCE_UNAVAILABLE"
    );
    guard()?;
    from_bytes(reference, bytes)
}

pub(super) fn from_bytes(reference: MediaReference, bytes: Vec<u8>) -> Result<MediaCache> {
    ensure!(
        bytes.len() <= MAX_BYTES
            && reference.mime.as_deref().is_none_or(supported_mime)
            && reference.size.is_none_or(|size| size == bytes.len())
            && format!("{:x}", Sha256::digest(&bytes)) == digest(&reference.uri)?,
        "RESOURCE_UNAVAILABLE"
    );
    let detected = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    };
    if let Some(expected @ ("image/png" | "image/jpeg" | "image/gif" | "image/webp")) =
        reference.mime.as_deref()
    {
        ensure!(detected == Some(expected), "RESOURCE_UNAVAILABLE");
    }
    let mime = reference
        .mime
        .as_deref()
        .or(detected)
        .unwrap_or("application/octet-stream")
        .to_owned();
    let raster = raster_info(&bytes, &mime).ok();
    Ok(MediaCache {
        reference,
        bytes,
        mime,
        raster,
    })
}

fn fail(code: &str) -> anyhow::Error {
    anyhow::anyhow!("{code}")
}

pub(crate) fn raster_info(bytes: &[u8], mime: &str) -> Result<Value> {
    ensure!(
        (12..=MAX_BYTES).contains(&bytes.len()),
        "RESOURCE_UNAVAILABLE"
    );
    let be16 = |at: usize| -> Result<usize> {
        Ok(u16::from_be_bytes(
            bytes
                .get(at..at + 2)
                .context("RESOURCE_UNAVAILABLE")?
                .try_into()?,
        ) as usize)
    };
    let be32 = |at: usize| -> Result<usize> {
        Ok(u32::from_be_bytes(
            bytes
                .get(at..at + 4)
                .context("RESOURCE_UNAVAILABLE")?
                .try_into()?,
        ) as usize)
    };
    let le16 = |at: usize| -> Result<usize> {
        Ok(u16::from_le_bytes(
            bytes
                .get(at..at + 2)
                .context("RESOURCE_UNAVAILABLE")?
                .try_into()?,
        ) as usize)
    };
    let le32 = |at: usize| -> Result<usize> {
        Ok(u32::from_le_bytes(
            bytes
                .get(at..at + 4)
                .context("RESOURCE_UNAVAILABLE")?
                .try_into()?,
        ) as usize)
    };
    let (width, height) = match mime {
        "image/png" => {
            ensure!(
                bytes.len() >= 45
                    && &bytes[..8] == b"\x89PNG\r\n\x1a\n"
                    && be32(8)? == 13
                    && &bytes[12..16] == b"IHDR",
                "RESOURCE_UNAVAILABLE"
            );
            let mut at = 8;
            let mut data = false;
            let mut ended = false;
            while at + 12 <= bytes.len() {
                let n = be32(at)?;
                let kind = &bytes[at + 4..at + 8];
                ensure!(
                    n <= bytes.len() - at - 12 && kind != b"acTL",
                    "RESOURCE_UNAVAILABLE"
                );
                data |= kind == b"IDAT";
                at += n + 12;
                if kind == b"IEND" {
                    ensure!(n == 0 && at == bytes.len(), "RESOURCE_UNAVAILABLE");
                    ended = true;
                    break;
                }
            }
            ensure!(data && ended, "RESOURCE_UNAVAILABLE");
            (be32(16)?, be32(20)?)
        }
        "image/gif" => {
            ensure!(
                bytes.len() >= 14
                    && matches!(&bytes[..6], b"GIF87a" | b"GIF89a")
                    && bytes.last() == Some(&0x3b),
                "RESOURCE_UNAVAILABLE"
            );
            let (width, height) = (le16(6)?, le16(8)?);
            let mut at = 13
                + if bytes[10] & 128 != 0 {
                    3 * (1usize << ((bytes[10] & 7) + 1))
                } else {
                    0
                };
            let mut frames = 0;
            while at < bytes.len() - 1 {
                let kind = bytes[at];
                at += 1;
                if kind == 0x21 {
                    at += 1;
                } else if kind == 0x2c {
                    frames += 1;
                    ensure!(frames == 1 && at + 9 <= bytes.len(), "RESOURCE_UNAVAILABLE");
                    let (w, h) = (le16(at + 4)?, le16(at + 6)?);
                    ensure!(
                        w > 0 && h > 0 && le16(at)? + w <= width && le16(at + 2)? + h <= height,
                        "RESOURCE_UNAVAILABLE"
                    );
                    let packed = bytes[at + 8];
                    at += 10
                        + if packed & 128 != 0 {
                            3 * (1usize << ((packed & 7) + 1))
                        } else {
                            0
                        };
                } else {
                    return Err(fail("RESOURCE_UNAVAILABLE"));
                }
                loop {
                    let n = *bytes.get(at).context("RESOURCE_UNAVAILABLE")? as usize;
                    at += 1;
                    if n == 0 {
                        break;
                    }
                    at += n;
                    ensure!(at <= bytes.len(), "RESOURCE_UNAVAILABLE");
                }
            }
            ensure!(frames == 1 && at == bytes.len() - 1, "RESOURCE_UNAVAILABLE");
            (width, height)
        }
        "image/webp" => {
            ensure!(
                &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" && le32(4)? + 8 == bytes.len(),
                "RESOURCE_UNAVAILABLE"
            );
            let mut at = 12;
            let mut dimensions = None;
            let mut found = false;
            while at + 8 <= bytes.len() {
                let kind = &bytes[at..at + 4];
                let n = le32(at + 4)?;
                let start = at + 8;
                ensure!(
                    n <= bytes.len() - start && kind != b"ANIM" && kind != b"ANMF",
                    "RESOURCE_UNAVAILABLE"
                );
                if kind == b"VP8X" {
                    ensure!(
                        at == 12 && !found && n == 10 && bytes[start] & 2 == 0,
                        "RESOURCE_UNAVAILABLE"
                    );
                    let u24 = |i| {
                        bytes[i] as usize
                            + (bytes[i + 1] as usize) * 256
                            + (bytes[i + 2] as usize) * 65536
                    };
                    dimensions = Some((u24(start + 4) + 1, u24(start + 7) + 1));
                }
                if kind == b"VP8 " || kind == b"VP8L" {
                    ensure!(!found, "RESOURCE_UNAVAILABLE");
                    found = true;
                    let current = if kind == b"VP8 " {
                        ensure!(
                            n >= 10 && &bytes[start + 3..start + 6] == b"\x9d\x01\x2a",
                            "RESOURCE_UNAVAILABLE"
                        );
                        (le16(start + 6)? & 0x3fff, le16(start + 8)? & 0x3fff)
                    } else {
                        ensure!(n >= 5 && bytes[start] == 0x2f, "RESOURCE_UNAVAILABLE");
                        let bits = le32(start + 1)?;
                        ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
                    };
                    ensure!(
                        dimensions.is_none_or(|previous| previous == current),
                        "RESOURCE_UNAVAILABLE"
                    );
                    dimensions = Some(current);
                }
                at = start + n + (n & 1);
            }
            ensure!(found && at == bytes.len(), "RESOURCE_UNAVAILABLE");
            dimensions.context("RESOURCE_UNAVAILABLE")?
        }
        "image/jpeg" => {
            ensure!(
                &bytes[..2] == b"\xff\xd8" && &bytes[bytes.len() - 2..] == b"\xff\xd9",
                "RESOURCE_UNAVAILABLE"
            );
            let mut at = 2;
            let mut dimensions = None;
            let mut scan = false;
            while at + 4 < bytes.len() {
                ensure!(bytes[at] == 255, "RESOURCE_UNAVAILABLE");
                at += 1;
                while bytes.get(at) == Some(&255) {
                    at += 1;
                }
                let marker = *bytes.get(at).context("RESOURCE_UNAVAILABLE")?;
                at += 1;
                let n = be16(at)?;
                ensure!(n >= 2 && at + n <= bytes.len() - 2, "RESOURCE_UNAVAILABLE");
                if marker == 0xda {
                    ensure!(n >= 6 && at + n < bytes.len() - 2, "RESOURCE_UNAVAILABLE");
                    scan = true;
                    break;
                }
                if matches!(marker, 0xc0..=0xc2) {
                    ensure!(n >= 8 && dimensions.is_none(), "RESOURCE_UNAVAILABLE");
                    dimensions = Some((be16(at + 5)?, be16(at + 3)?));
                }
                at += n;
            }
            ensure!(scan, "RESOURCE_UNAVAILABLE");
            dimensions.context("RESOURCE_UNAVAILABLE")?
        }
        _ => return Err(fail("RESOURCE_UNAVAILABLE")),
    };
    ensure!(
        width > 0
            && height > 0
            && width <= 16384
            && height <= 16384
            && width * height <= 16 * 1024 * 1024,
        "RESOURCE_UNAVAILABLE"
    );
    Ok(json!({"mime":mime,"width":width,"height":height}))
}

pub(crate) async fn read_blob(
    service: &Service,
    thread: &str,
    uri: &str,
    guard: impl Fn() -> Result<()>,
) -> Result<Value> {
    guard()?;
    let (url, token) = core_blob_url(service, &format!("/areal/blobs/{}", digest(uri)?), thread)?;
    read_blob_from(url, token, uri, guard).await
}
async fn read_blob_from(
    url: url::Url,
    token: String,
    uri: &str,
    guard: impl Fn() -> Result<()>,
) -> Result<Value> {
    let mut response = core_client()?.get(url).bearer_auth(token).send().await?;
    ensure!(response.status().is_success(), "RESOURCE_UNAVAILABLE");
    ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= MAX_BYTES as u64),
        "LIMIT_EXCEEDED"
    );
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|mime| mime.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        guard()?;
        ensure!(bytes.len() + chunk.len() <= MAX_BYTES, "LIMIT_EXCEEDED");
        bytes.extend_from_slice(&chunk);
    }
    ensure!(
        format!("{:x}", Sha256::digest(&bytes)) == digest(uri)?,
        "RESOURCE_UNAVAILABLE"
    );
    guard()?;
    Ok(json!({"base64":STANDARD.encode(bytes),"mime":mime}))
}

fn remote_blob_url(endpoint: &str, thread: &str, path: &str) -> Result<url::Url> {
    let mut url = url::Url::parse(endpoint)?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => anyhow::bail!("INVALID_PARAMS"),
    };
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
    let path = format!("{}/areal/blobs{}", url.path().trim_end_matches('/'), path);
    url.set_path(&path);
    url.set_query(None);
    url.query_pairs_mut().append_pair("threadId", thread);
    Ok(url)
}
pub(crate) async fn remote_blob(
    endpoint: &str,
    token: &str,
    params: &Value,
    guard: impl Fn() -> Result<()>,
) -> Result<Value> {
    let thread = params["threadId"].as_str().context("INVALID_PARAMS")?;
    guard()?;
    if params["operation"] == "read" {
        let uri = params["uri"].as_str().context("INVALID_PARAMS")?;
        let url = remote_blob_url(endpoint, thread, &format!("/{}", digest(uri)?))?;
        return read_blob_from(url, token.into(), uri, guard).await;
    }
    ensure!(
        params["operation"] == "upload"
            && params.get("callId").is_none()
            && params.get("hostGeneration").is_none(),
        "FORBIDDEN"
    );
    let encoded = params["base64"]
        .as_str()
        .filter(|text| text.len() <= 22_369_624)
        .context("INVALID_PARAMS")?;
    let bytes = STANDARD.decode(encoded)?;
    ensure!(STANDARD.encode(&bytes) == encoded, "INVALID_PARAMS");
    let result = upload_to(
        remote_blob_url(endpoint, thread, "")?,
        token.into(),
        params["mime"].as_str().context("INVALID_PARAMS")?,
        bytes,
    )
    .await?;
    guard()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn png() -> Vec<u8> {
        STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aKsAAAAASUVORK5CYII=").unwrap()
    }
    fn reference(bytes: &[u8]) -> MediaReference {
        MediaReference {
            source_thread_id: "inherited-source".into(),
            turn_id: "turn".into(),
            item_id: "image".into(),
            uri: format!("areal://blob/{:x}", Sha256::digest(bytes)),
            mime: Some("image/png".into()),
            size: Some(bytes.len()),
        }
    }
    fn service(root: &std::path::Path, address: std::net::SocketAddr) -> Service {
        let service: Service = serde_json::from_value(json!({
            "protocolVersion":1,"serviceId":"core","generation":"first","workspace":root,"dataDir":root,"configFingerprint":"test",
            "owner":null,"endpoint":format!("ws://{address}/"),"webUrl":"","authFile":root.join("auth.json"),"logFile":root.join("core.log"),"hostPid":1,"corePid":2,"state":"ready"
        })).unwrap();
        areal_local_service::storage::write(&service.auth_file, &json!({"principals":[{"id":"other","token":"wrong"},{"id":"desktop-owner","token":"private-owner"}]})).unwrap();
        service
    }
    async fn request(listener: &TcpListener) -> tokio::net::TcpStream {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
            assert!(request.len() < 8192);
        }
        let request = String::from_utf8(request).unwrap();
        let first = request.lines().next().unwrap();
        assert!(first.starts_with("GET /areal/blobs/"));
        assert!(first.ends_with("?threadId=selected HTTP/1.1"));
        assert!(!first.contains("private-owner"));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer private-owner\r\n")
        );
        socket
    }
    async fn respond(socket: &mut tokio::net::TcpStream, bytes: &[u8]) {
        socket
            .write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", bytes.len()).as_bytes(),
            )
            .await
            .unwrap();
        socket.write_all(bytes).await.unwrap();
    }
    #[tokio::test]
    async fn upload_reports_core_content_rejection_as_unsupported_attachment() {
        for (core, expected) in [
            (-32602, "ATTACHMENT_UNSUPPORTED"),
            (-32001, "LIMIT_EXCEEDED"),
        ] {
            let root = tempfile::tempdir().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let service = service(root.path(), listener.local_addr().unwrap());
            let upload = upload_owned(
                &service,
                "selected",
                "application/typescript",
                vec![0xff, 0xfe],
                None,
                None,
            );
            let server = async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n\xff\xfe") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let body = json!({"error":{"code":core,"message":"private detail"}}).to_string();
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            };
            let (result, _) = tokio::join!(upload, server);
            assert_eq!(result.unwrap_err().to_string(), expected);
        }
    }
    #[tokio::test]
    async fn native_media_preserves_audio_and_binary_attachments() {
        for (mime, bytes) in [
            (
                Some("audio/wav"),
                b"RIFF\0\0\0\0WAVE attachment bytes".as_slice(),
            ),
            (None, b"%PDF-1.7\nopaque-document".as_slice()),
            (None, b"".as_slice()),
        ] {
            let root = tempfile::tempdir().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let service = service(root.path(), listener.local_addr().unwrap());
            let mut reference = reference(bytes);
            reference.mime = mime.map(str::to_owned);
            let download = fetch(&service, "selected", reference, || Ok(()));
            let respond = async {
                let mut socket = request(&listener).await;
                respond(&mut socket, bytes).await;
            };
            let (cache, _) = tokio::join!(download, respond);
            let part = cache.unwrap().chunk(0, 65536).unwrap();
            assert_eq!(part["mimeType"], mime.unwrap_or("application/octet-stream"));
            assert_eq!(
                STANDARD.decode(part["base64"].as_str().unwrap()).unwrap(),
                bytes
            );
            assert!(part.get("raster").is_none());
        }
    }
    #[tokio::test]
    async fn native_media_uses_selected_core_authority_and_paginates_cached_bytes() {
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = service(root.path(), listener.local_addr().unwrap());
        let bytes = png();
        let fetch = fetch(&service, "selected", reference(&bytes), || Ok(()));
        let server = async {
            let mut socket = request(&listener).await;
            respond(&mut socket, &bytes).await;
        };
        let (cache, _) = tokio::join!(fetch, server);
        let cache = cache.unwrap();
        let first = cache.chunk(0, 32).unwrap();
        let rest = cache.chunk(32, 65536).unwrap();
        assert_eq!(first["sourceThreadId"], "inherited-source");
        assert_eq!(first["nextOffset"], 32);
        assert!(rest["nextOffset"].is_null());
        let mut joined = STANDARD.decode(first["base64"].as_str().unwrap()).unwrap();
        joined.extend(STANDARD.decode(rest["base64"].as_str().unwrap()).unwrap());
        assert_eq!(joined, bytes);
        assert_eq!(
            first["raster"],
            json!({"mime":"image/png","width":1,"height":1})
        );
        assert!(cache.chunk(bytes.len(), 32).is_err());
        assert!(cache.chunk(0, 65537).is_err());
    }
    #[tokio::test]
    async fn native_media_rejects_foreign_blobs_wrong_digest_and_generation_changes() {
        for fault in [
            "not-referenced",
            "digest",
            "size",
            "generation",
            "generation-error",
        ] {
            let root = tempfile::tempdir().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let service = service(root.path(), listener.local_addr().unwrap());
            let bytes = png();
            let current = Cell::new(true);
            let mut media = reference(&bytes);
            if fault == "digest" {
                media.uri = format!("areal://blob/{}", "0".repeat(64));
            }
            if fault == "size" {
                media.size = Some(bytes.len() + 1);
            }
            let fetch = fetch(&service, "selected", media, || {
                ensure!(current.get(), "RESYNC_REQUIRED");
                Ok(())
            });
            let server = async {
                let mut socket = request(&listener).await;
                if fault.starts_with("generation") {
                    current.set(false);
                }
                if fault == "generation-error" {
                    return;
                }
                if fault == "not-referenced" {
                    socket
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                        .await
                        .unwrap();
                } else {
                    respond(&mut socket, &bytes).await;
                }
            };
            let (result, _) = tokio::join!(fetch, server);
            let error = result.err().unwrap().to_string();
            assert_eq!(
                error,
                if fault.starts_with("generation") {
                    "RESYNC_REQUIRED"
                } else {
                    "RESOURCE_UNAVAILABLE"
                },
                "{fault}"
            );
        }
    }
    #[tokio::test]
    async fn native_media_preserves_animation_without_relaxing_legacy_raster_policy() {
        let frame = STANDARD
            .decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
            .unwrap();
        assert!(raster_info(&frame, "image/gif").is_ok());
        let mut bytes = frame[..frame.len() - 1].to_vec();
        bytes.extend_from_slice(&frame[19..]);
        assert!(raster_info(&bytes, "image/gif").is_err());
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = service(root.path(), listener.local_addr().unwrap());
        let mut media = reference(&bytes);
        media.mime = Some("image/gif".into());
        let fetch = fetch(&service, "selected", media, || Ok(()));
        let server = async {
            let mut socket = request(&listener).await;
            respond(&mut socket, &bytes).await;
        };
        let (cache, _) = tokio::join!(fetch, server);
        let chunk = cache.unwrap().chunk(0, 65536).unwrap();
        assert_eq!(chunk["mimeType"], "image/gif");
        assert!(chunk.get("raster").is_none());
        assert_eq!(
            STANDARD.decode(chunk["base64"].as_str().unwrap()).unwrap(),
            bytes
        );
    }

    #[test]
    fn references_keep_native_source_identity_and_reject_paths() {
        let bytes = png();
        let media = reference(&bytes);
        let item = json!({"id":"image","type":"agentMedia","media":{"uri":media.uri,"mimeType":"image/png","sizeBytes":bytes.len()}});
        let page = json!({"data":[{"sourceThreadId":"inherited-source","sourceTurnId":"turn","sourceItemId":"image","item":item}]});
        assert_eq!(page_references(&page), vec![media]);
        let forged = json!({"id":"image","type":"userMessage","content":[{"type":"image","url":"file:///private/secret"}]});
        assert!(item_references("selected", "turn", &forged).is_empty());
        assert!(digest("areal://blob/../../auth.json").is_err());
        assert!(digest(&format!("areal://blob/{}", "A".repeat(64))).is_err());
    }
}
