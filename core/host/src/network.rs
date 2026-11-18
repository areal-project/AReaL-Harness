//! Host 共享 HTTP 传输：保留公共与系统信任根、代理绕过和禁止重定向。
use anyhow::{Context, Result, ensure};
use areal_config::proxy::proxy_for_url;
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
    let setting_proxy = setting(settings, "httpProxy")?;
    let direct = setting_proxy == "direct";
    let proxy = proxy_setting(if direct { "" } else { setting_proxy })?;
    let bypass = bypass_setting(setting(settings, "httpProxyNoProxy")?)?;
    let ca = setting(settings, "httpProxyCaCertPath")?;
    let system = if !direct && proxy.is_empty() {
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
        if !direct && !selected.is_empty() {
            proxies.insert(name.into(), selected);
        }
    }
    if direct || !proxy.is_empty() {
        proxies.insert(
            "AREAL_CHATGPT_SYSTEM_PROXY".into(),
            if direct { "DIRECT".into() } else { proxy },
        );
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

pub(super) fn apply_model_proxy(input: NetworkInput, environment: &mut BTreeMap<String, String>) {
    environment.retain(|key, _| !areal_config::PROXY_ENV_VARS.contains(&key.as_str()));
    for (key, value) in input.proxies {
        if areal_config::PROXY_ENV_VARS.contains(&key.as_str()) {
            environment.insert(key, value);
        }
    }
    environment.insert(areal_config::proxy::MANAGED_PROXY.into(), "1".into());
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;
