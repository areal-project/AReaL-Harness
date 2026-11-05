use super::*;
use hyper::{Method, StatusCode};

fn response(status: StatusCode, bytes: impl Into<Bytes>, mime: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .body(Full::new(bytes.into()))
        .unwrap()
}

pub(super) async fn request(
    host: &Rc<Host>,
    endpoint: &LoopbackEndpoint,
    request: Request<Incoming>,
) -> Response<Full<Bytes>> {
    let path = request.uri().path().to_owned();
    // 公开端点仅含固定代理代码；用户页面与资源始终经已鉴权 WebSocket 读取。
    if path == "/host/pages/proxy" && request.method() == Method::GET {
        let mut result = response(
            StatusCode::OK,
            include_str!("page_proxy.html"),
            "text/html; charset=utf-8",
        );
        result.headers_mut().insert("content-security-policy", hyper::header::HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline' http: https: data: blob:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src http: https: wss:; frame-src http: https: data: blob:; base-uri http: https:; object-src 'none'; form-action 'none'; worker-src 'none'; sandbox allow-scripts"
        ));
        return result;
    }
    if path.starts_with("/host/auth/") {
        if request.method() != Method::POST
            || request.headers().get_all("origin").iter().count() != 1
            || request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                != Some(endpoint.origin.as_str())
            || request
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .is_none_or(|value| !value.eq_ignore_ascii_case("application/json"))
        {
            return response(StatusCode::FORBIDDEN, Bytes::new(), "application/json");
        }
        let result = async {
            let body =
                tokio::time::timeout(TIMEOUT, Limited::new(request.into_body(), 8192).collect())
                    .await?
                    .map_err(|_| anyhow::anyhow!("invalid authentication body"))?
                    .to_bytes();
            let params: Value = serde_json::from_slice(&body)?;
            match path.as_str() {
                "/host/auth/challenge" => host
                    .loopback
                    .browser
                    .borrow_mut()
                    .as_mut()
                    .context("authentication unavailable")?
                    .challenge(&endpoint.origin, &params),
                "/host/auth/ticket" => {
                    let device_id = host
                        .loopback
                        .browser
                        .borrow_mut()
                        .as_mut()
                        .context("authentication unavailable")?
                        .authenticate(&endpoint.origin, &params)?;
                    let mut ticket = host.loopback.mint_ticket(
                        LocalWebTicketParams {
                            origin: endpoint.origin.clone(),
                            expected_generation: host.identity.generation.clone(),
                            profile: None,
                        },
                        Some(device_id),
                    )?;
                    ticket.preferred_source_id =
                        crate::remote_state::RemoteState::selected_source(&host.home)?;
                    Ok(serde_json::to_value(ticket)?)
                }
                _ => anyhow::bail!("unknown authentication route"),
            }
        }
        .await;
        return match result {
            Ok(value) => response(
                StatusCode::OK,
                serde_json::to_vec(&value).unwrap(),
                "application/json",
            ),
            Err(_) => response(
                StatusCode::FORBIDDEN,
                Bytes::from_static(b"{\"error\":\"authentication failed\"}"),
                "application/json",
            ),
        };
    }
    if request.method() != Method::GET {
        return response(StatusCode::METHOD_NOT_ALLOWED, Bytes::new(), "text/plain");
    }
    let Some(root) = host.loopback.ui_root.borrow().clone() else {
        return response(
            StatusCode::SERVICE_UNAVAILABLE,
            Bytes::from_static(b"Shared interface is not installed"),
            "text/plain",
        );
    };
    let decoded = match percent_encoding::percent_decode_str(&path).decode_utf8() {
        Ok(value) => value,
        Err(_) => return response(StatusCode::BAD_REQUEST, Bytes::new(), "text/plain"),
    };
    let relative = if decoded == "/" {
        "index.html"
    } else {
        decoded.trim_start_matches('/')
    };
    if Path::new(relative)
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return response(StatusCode::NOT_FOUND, Bytes::new(), "text/plain");
    }
    let path = match root.join(relative).canonicalize() {
        Ok(path) if path.starts_with(&root) && path.is_file() => path,
        _ => return response(StatusCode::NOT_FOUND, Bytes::new(), "text/plain"),
    };
    let mime = match path.extension().and_then(|value| value.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("wasm") => "application/wasm",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    };
    let bytes = match std::fs::metadata(&path).and_then(|metadata| {
        if metadata.len() > 32 * 1024 * 1024 {
            return Err(std::io::Error::other("asset exceeds limit"));
        }
        std::fs::read(path)
    }) {
        Ok(bytes) => bytes,
        Err(_) => return response(StatusCode::NOT_FOUND, Bytes::new(), "text/plain"),
    };
    let mut result = response(StatusCode::OK, bytes, mime);
    result.headers_mut().insert("content-security-policy", hyper::header::HeaderValue::from_str(&format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' {}; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        endpoint.websocket_url.trim_end_matches("/host/socket")
    )).unwrap());
    result
}
