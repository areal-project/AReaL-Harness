use std::{collections::BTreeMap, net::IpAddr};
use url::Url;

pub const MANAGED_PROXY: &str = "AREAL_MANAGED_MODEL_PROXY";

/// Host 探测和桌面项目模型共用同一个代理与绕过判断。
pub fn proxy_for_url(url: &Url, source: &BTreeMap<String, String>) -> Option<String> {
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
