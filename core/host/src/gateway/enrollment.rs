use super::*;

pub(super) fn origin(value: &Value) -> Result<&str> {
    let value = value
        .as_str()
        .ok_or_else(|| error("invalid-origin", "Remote network: invalid-origin"))?;
    let parsed = url::Url::parse(value)
        .map_err(|_| error("invalid-origin", "Remote network: invalid-origin"))?;
    ensure!(
        parsed.scheme() == "https"
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.host_str().is_some()
            && parsed.origin().ascii_serialization() == value,
        error("invalid-origin", "Remote network: invalid-origin")
    );
    Ok(value)
}
pub(super) fn code(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|value| {
            value.len() == 43
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
        .ok_or_else(|| error("invalid-code", "请输入管理员生成的一次性登记码"))
}
pub(super) enum Outcome {
    Registered(Value),
    Rejected,
    CertificateRejected(&'static str),
}
fn certificate_code(error: &rustls::Error) -> Option<&'static str> {
    use rustls::CertificateError;
    match error {
        rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer) => {
            Some("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")
        }
        rustls::Error::InvalidCertificate(
            CertificateError::Expired | CertificateError::ExpiredContext { .. },
        ) => Some("CERT_HAS_EXPIRED"),
        rustls::Error::InvalidCertificate(
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
        ) => Some("ERR_TLS_CERT_ALTNAME_INVALID"),
        _ => None,
    }
}
fn certificate_cause(error: &(dyn std::error::Error + 'static)) -> Option<&'static str> {
    let mut source = Some(error);
    while let Some(current) = source {
        if let Some(tls) = current.downcast_ref::<rustls::Error>() {
            return certificate_code(tls);
        }
        source = if let Some(io) = current.downcast_ref::<std::io::Error>() {
            io.get_ref().map(|inner| inner as &dyn std::error::Error)
        } else {
            current.source()
        };
    }
    None
}
fn rejected_certificate(error: &reqwest::Error) -> Option<&'static str> {
    if !error.is_connect() {
        return None;
    }
    certificate_cause(error)
}
pub(super) async fn register(origin: &str, code: &str) -> Result<Outcome> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    ensure!(!roots.is_empty(), "no TLS trust roots");
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(15))
        .build()?;
    let mut response = match client
        .post(format!("{origin}/enroll"))
        .json(&json!({"code":code}))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            if let Some(code) = rejected_certificate(&error) {
                return Ok(Outcome::CertificateRejected(code));
            }
            return Err(error.into());
        }
    };
    if matches!(response.status().as_u16(), 403 | 429) {
        return Ok(Outcome::Rejected);
    }
    ensure!(
        response.status() == reqwest::StatusCode::CREATED,
        "Relay enrollment response is unresolved"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 4096,
            "Relay enrollment response exceeds its limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    let capability = self::code(&value["capability"])?;
    ensure!(
        value["room"].as_str() == Some(storage::digest(capability.as_bytes()).as_str()),
        "invalid Relay enrollment receipt"
    );
    Ok(Outcome::Registered(
        json!({"room":value["room"],"capability":capability}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_supported_certificate_failures_are_definite_rejections() {
        for (failure, expected) in [
            (
                rustls::CertificateError::UnknownIssuer,
                "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
            ),
            (rustls::CertificateError::Expired, "CERT_HAS_EXPIRED"),
            (
                rustls::CertificateError::NotValidForName,
                "ERR_TLS_CERT_ALTNAME_INVALID",
            ),
        ] {
            assert_eq!(
                certificate_code(&rustls::Error::InvalidCertificate(failure)),
                Some(expected)
            );
        }
        assert_eq!(
            certificate_code(&rustls::Error::InvalidCertificate(
                rustls::CertificateError::BadSignature
            )),
            None
        );
        assert_eq!(
            certificate_code(&rustls::Error::General("unresolved transport".into())),
            None
        );
    }

    #[test]
    fn connector_io_wrappers_preserve_typed_certificate_causes() {
        let certificate = std::io::Error::other(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
        ));
        assert_eq!(
            certificate_cause(&certificate),
            Some("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")
        );
        let transport = std::io::Error::other(std::io::Error::other("disconnected"));
        assert_eq!(certificate_cause(&transport), None);
    }
}
