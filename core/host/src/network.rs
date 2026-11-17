//! Host 共享 HTTP 传输：保留公共与系统信任根、代理绕过和禁止重定向。
use anyhow::{Context, Result, ensure};
use reqwest::{Client, Url};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::IpAddr,
    path::Path,
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NetworkInput {
    pub(crate) proxies: BTreeMap<String, String>,
    pub(crate) extra_ca_pem: Vec<String>,
    pub(crate) proxy_unavailable: bool,
}

pub(crate) fn client(input: &NetworkInput) -> Result<Client> {
    let proxies = input.proxies.clone();
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .proxy(reqwest::Proxy::custom(move |url| {
            proxy_for_url(url, &proxies)
        }));
    for pem in &input.extra_ca_pem {
        for certificate in reqwest::Certificate::from_pem_bundle(pem.as_bytes())? {
            builder = builder.add_root_certificate(certificate);
        }
    }
    Ok(builder.build()?)
}

fn proxy_for_url(url: &Url, source: &BTreeMap<String, String>) -> Option<String> {
    let host = url
        .host_str()?
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let ip = host.parse::<IpAddr>().ok();
    if host == "localhost" || host.ends_with(".localhost") || ip.is_some_and(|ip| ip.is_loopback())
    {
        return None;
    }
    let variable = |key: &str| {
        source
            .get(key)
            .filter(|s| !s.is_empty())
            .or_else(|| source.get(&key.to_ascii_lowercase()))
            .filter(|s| !s.is_empty())
            .cloned()
    };
    let port = url.port_or_known_default().unwrap_or(0);
    for entry in variable("NO_PROXY")
        .unwrap_or_default()
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
    {
        let entry = entry.to_ascii_lowercase();
        if entry == "*" {
            return None;
        }
        if let Some((address, prefix)) = entry.split_once('/') {
            if let (Some(ip), Ok(network), Ok(bits)) = (
                ip,
                address.trim_matches(['[', ']']).parse::<IpAddr>(),
                prefix.parse::<u32>(),
            ) {
                let matched = match (ip, network) {
                    (IpAddr::V4(ip), IpAddr::V4(net)) if bits <= 32 => {
                        u32::from(ip).checked_shr(32 - bits).unwrap_or(0)
                            == u32::from(net).checked_shr(32 - bits).unwrap_or(0)
                    }
                    (IpAddr::V6(ip), IpAddr::V6(net)) if bits <= 128 => {
                        u128::from(ip).checked_shr(128 - bits).unwrap_or(0)
                            == u128::from(net).checked_shr(128 - bits).unwrap_or(0)
                    }
                    _ => false,
                };
                if matched {
                    return None;
                }
            }
            continue;
        }
        let entry = if let Some((name, suffix)) = entry
            .rsplit_once(':')
            .filter(|(name, _)| !name.contains(':') || name.ends_with(']'))
        {
            if let Ok(value) = suffix.parse::<u16>() {
                if value != port {
                    continue;
                }
                name
            } else {
                &entry
            }
        } else {
            &entry
        };
        let domain = entry
            .trim_matches(['[', ']'])
            .trim_start_matches("*.")
            .trim_start_matches('.');
        if host == domain
            || (domain.parse::<IpAddr>().is_err() && host.ends_with(&format!(".{domain}")))
        {
            return None;
        }
    }
    if source
        .get("AREAL_CHATGPT_SYSTEM_PROXY")
        .is_some_and(|s| s == "DIRECT")
    {
        return None;
    }
    source
        .get("AREAL_CHATGPT_SYSTEM_PROXY")
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| {
            variable(if url.scheme() == "https" {
                "HTTPS_PROXY"
            } else {
                "HTTP_PROXY"
            })
        })
        .or_else(|| variable("ALL_PROXY"))
}

fn setting<'a>(settings: &'a Value, key: &str) -> Result<&'a str> {
    let text = match settings.get(key) {
        None => "",
        Some(value) => value.as_str().context("invalid network setting")?,
    };
    ensure!(
        text.chars().count() <= 4096 && !text.chars().any(char::is_control),
        "invalid network setting"
    );
    Ok(text.trim())
}
/// 在不触发系统代理探测的情况下校验并归一化资料库里的网络设置项。
pub(crate) fn validate_setting(key: &str, value: &str) -> Result<String> {
    ensure!(
        value.chars().count() <= 4096 && !value.chars().any(char::is_control),
        "invalid network setting"
    );
    let text = value.trim();
    match key {
        "httpProxy" => proxy_setting(text),
        "httpProxyNoProxy" => bypass_setting(text),
        "httpProxyCaCertPath" => {
            if !text.is_empty() {
                ca_bundle(Path::new(text), true)?;
            }
            Ok(text.to_owned())
        }
        _ => anyhow::bail!("unknown network setting"),
    }
}
fn proxy_setting(text: &str) -> Result<String> {
    if text.is_empty() {
        return Ok(String::new());
    }
    let url = Url::parse(text)?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "invalid proxy setting"
    );
    Ok(url.origin().ascii_serialization())
}
fn bypass_setting(text: &str) -> Result<String> {
    let mut values = BTreeSet::new();
    for raw in text
        .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .filter(|s| !s.is_empty())
    {
        let raw = raw.to_ascii_lowercase();
        let value = raw.trim_matches(['[', ']']);
        if value == "*" || value.parse::<IpAddr>().is_ok() {
            values.insert(value.to_owned());
            continue;
        }
        if let Some((address, bits)) = value.split_once('/') {
            let ip: IpAddr = address.parse()?;
            let bits: u32 = bits.parse()?;
            ensure!(
                bits <= if ip.is_ipv4() { 32 } else { 128 },
                "invalid proxy bypass"
            );
            values.insert(format!("{address}/{bits}"));
            continue;
        }
        let value = value
            .strip_prefix("*.")
            .map(|s| format!(".{s}"))
            .unwrap_or_else(|| value.into());
        let domain = value.trim_start_matches('.').trim_end_matches('.');
        ensure!(
            domain.len() <= 253
                && !domain.is_empty()
                && domain.split('.').all(|label| !label.is_empty()
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && label
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label
                        .as_bytes()
                        .last()
                        .is_some_and(u8::is_ascii_alphanumeric)),
            "invalid proxy bypass"
        );
        values.insert(value.trim_end_matches('.').to_owned());
    }
    Ok(values.into_iter().collect::<Vec<_>>().join(","))
}
fn ca_bundle(path: &Path, strict: bool) -> Result<String> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    ensure!(path.is_absolute(), "CA bundle must be absolute");
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= 1_048_576,
        "invalid CA bundle file"
    );
    let mut bytes = Vec::new();
    file.by_ref().take(1_048_577).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1_048_576, "CA bundle too large");
    let text = std::str::from_utf8(&bytes)?;
    let mut remaining = text;
    let mut count = 0;
    let mut bundle = String::new();
    while let Some(start) = remaining.find("-----BEGIN CERTIFICATE-----") {
        ensure!(
            !strict || remaining[..start].trim().is_empty(),
            "invalid CA bundle content"
        );
        let body = &remaining[start..];
        let end = body
            .find("-----END CERTIFICATE-----")
            .context("invalid CA bundle")?
            + 25;
        let block = &body[..end];
        let (_, pem) = x509_parser::pem::parse_x509_pem(block.as_bytes())
            .map_err(|_| anyhow::anyhow!("invalid CA bundle"))?;
        let (_, certificate) = x509_parser::parse_x509_certificate(&pem.contents)
            .map_err(|_| anyhow::anyhow!("invalid CA certificate"))?;
        if strict {
            ensure!(
                certificate.subject() == certificate.issuer()
                    && certificate
                        .basic_constraints()
                        .ok()
                        .flatten()
                        .is_some_and(|extension| extension.value.ca)
                    && certificate.key_usage().is_ok_and(|extension| extension
                        .is_none_or(|extension| extension.value.key_cert_sign()))
                    && certificate.verify_signature(None).is_ok(),
                "CA bundle requires self-signed authorities"
            );
        }
        bundle.push_str(block);
        bundle.push('\n');
        count += 1;
        ensure!(
            count <= if strict { 128 } else { 1024 },
            "too many CA certificates"
        );
        remaining = &body[end..];
    }
    ensure!(
        count > 0 && (!strict || remaining.trim().is_empty()),
        "invalid CA bundle"
    );
    Ok(bundle)
}
fn system_settings(text: &str) -> Result<BTreeMap<String, String>> {
    let mut depth = 0;
    let mut exceptions = 0;
    let mut values = BTreeMap::new();
    let mut bypass = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.contains("<dictionary> {") || line.contains("<array> {") {
            depth += 1;
            if depth == 2 && line.starts_with("ExceptionsList :") {
                exceptions = depth;
            }
        } else if line == "}" {
            if depth == exceptions {
                exceptions = 0;
            }
            depth -= 1;
        } else if let Some((key, value)) = line.split_once(':') {
            if depth == 1 {
                values.insert(key.trim().to_owned(), value.trim().to_owned());
            } else if exceptions > 0 && depth == exceptions {
                bypass.push(value.trim().replace("*.", "."));
            }
        }
    }
    let mut proxies = BTreeMap::new();
    for (prefix, scheme, name) in [
        ("HTTP", "http", "HTTP_PROXY"),
        ("HTTPS", "http", "HTTPS_PROXY"),
        ("SOCKS", "socks5h", "ALL_PROXY"),
    ] {
        if values
            .get(&format!("{prefix}Enable"))
            .is_none_or(|v| v != "1")
        {
            continue;
        }
        let host = values
            .get(&format!("{prefix}Proxy"))
            .context("invalid system proxy")?;
        let port: u16 = values
            .get(&format!("{prefix}Port"))
            .context("invalid system proxy")?
            .parse()?;
        ensure!(
            port > 0
                && !host.is_empty()
                && !host
                    .chars()
                    .any(|c| c.is_whitespace() || "/@?#".contains(c)),
            "invalid system proxy"
        );
        let host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
            format!("[{host}]")
        } else {
            host.clone()
        };
        let target = format!("{scheme}://{host}:{port}");
        Url::parse(&target)?;
        proxies.insert(name.into(), target);
    }
    proxies.insert("NO_PROXY".into(), bypass.join(","));
    Ok(proxies)
}
async fn system_proxy() -> Result<BTreeMap<String, String>> {
    if !cfg!(target_os = "macos") {
        return Ok(BTreeMap::new());
    }
    let mut command = tokio::process::Command::new("/usr/sbin/scutil");
    command
        .arg("--proxy")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .context("system proxy output unavailable")?;
    let mut output = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        (&mut stdout).take(131_073).read_to_end(&mut output).await?;
        ensure!(output.len() <= 131_072, "system proxy output too large");
        ensure!(child.wait().await?.success(), "system proxy unavailable");
        anyhow::Ok(())
    })
    .await??;
    system_settings(std::str::from_utf8(&output)?)
}
pub(crate) async fn desktop(
    settings: &Value,
    environment: &BTreeMap<String, String>,
) -> Result<NetworkInput> {
    let proxy = proxy_setting(setting(settings, "httpProxy")?)?;
    let bypass = bypass_setting(setting(settings, "httpProxyNoProxy")?)?;
    let ca = setting(settings, "httpProxyCaCertPath")?;
    let system = if proxy.is_empty() {
        system_proxy().await?
    } else {
        BTreeMap::new()
    };
    let value = |key: &str| {
        environment
            .get(key)
            .filter(|v| !v.is_empty())
            .or_else(|| environment.get(&key.to_ascii_lowercase()))
            .cloned()
            .unwrap_or_default()
    };
    let mut proxies = BTreeMap::new();
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        let inherited = value(name);
        let all = value("ALL_PROXY");
        let selected = if !proxy.is_empty() {
            proxy.clone()
        } else if !inherited.is_empty() {
            inherited
        } else if !all.is_empty() {
            all
        } else {
            system
                .get(name)
                .or_else(|| system.get("ALL_PROXY"))
                .cloned()
                .unwrap_or_default()
        };
        if !selected.is_empty() {
            proxies.insert(name.into(), selected);
        }
    }
    if !proxy.is_empty() {
        proxies.insert("AREAL_CHATGPT_SYSTEM_PROXY".into(), proxy);
    }
    proxies.insert(
        "NO_PROXY".into(),
        [
            value("NO_PROXY"),
            system.get("NO_PROXY").cloned().unwrap_or_default(),
            bypass,
            "localhost,.localhost,127.0.0.0/8,::1".into(),
        ]
        .join(","),
    );
    let mut extra_ca_pem = Vec::new();
    if !ca.is_empty() {
        extra_ca_pem.push(ca_bundle(Path::new(ca), true)?);
    }
    let mut inherited = BTreeSet::new();
    for key in [
        "SSL_CERT_FILE",
        "NODE_EXTRA_CA_CERTS",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "GIT_SSL_CAINFO",
    ] {
        let path = value(key);
        if !path.is_empty() && inherited.insert(path.clone()) {
            extra_ca_pem.push(ca_bundle(Path::new(&path), false)?);
        }
    }
    Ok(NetworkInput {
        proxies,
        extra_ca_pem,
        proxy_unavailable: false,
    })
}

/// 子进程使用同一代理规则；补充证书与原系统信任根合并，不能替换公共根。
pub(crate) fn launch_environment(
    input: NetworkInput,
    directory: &Path,
) -> Result<BTreeMap<String, String>> {
    use areal_local_service::storage;
    use base64::Engine;
    ensure!(!input.proxy_unavailable, "system proxy unavailable");
    let mut environment: BTreeMap<_, _> = input
        .proxies
        .into_iter()
        .filter(|(name, _)| crate::launch::allowed_environment(name))
        .collect();
    if !input.extra_ca_pem.is_empty() {
        let native = rustls_native_certs::load_native_certs();
        ensure!(
            !native.certs.is_empty(),
            "native certificate roots unavailable"
        );
        let mut roots = Vec::new();
        for certificate in native.certs {
            let encoded = base64::engine::general_purpose::STANDARD.encode(certificate.as_ref());
            let body = encoded
                .as_bytes()
                .chunks(64)
                .map(|line| std::str::from_utf8(line).unwrap())
                .collect::<Vec<_>>()
                .join("\n");
            roots.push(format!(
                "-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----"
            ));
        }
        roots.extend(input.extra_ca_pem);
        let combined = roots.join("\n");
        storage::private_dir(directory)?;
        let path = directory.join(format!("ca-{}.pem", storage::digest(combined.as_bytes())));
        storage::write_bytes(&path, combined.as_bytes())?;
        for name in [
            "SSL_CERT_FILE",
            "NODE_EXTRA_CA_CERTS",
            "REQUESTS_CA_BUNDLE",
            "CURL_CA_BUNDLE",
            "GIT_SSL_CAINFO",
        ] {
            environment.insert(name.into(), path.to_string_lossy().into_owned());
        }
    }
    Ok(environment)
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;
