use super::*;
use base64::Engine;
fn openssl(root: &Path, args: &[&str]) {
    assert!(
        std::process::Command::new("openssl")
            .current_dir(root)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}
fn authority(root: &Path) -> String {
    std::fs::write(root.join("ca.cnf"),"[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Isolated AReaL transport test\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n").unwrap();
    openssl(
        root,
        &[
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
            "-days", "1", "-config", "ca.cnf",
        ],
    );
    std::fs::read_to_string(root.join("ca.pem")).unwrap()
}
#[test]
fn proxy_rules_keep_system_scope_and_bypass_boundaries() {
    let parsed=system_settings("<dictionary> {\nHTTPEnable : 1\nHTTPProxy : proxy.test\nHTTPPort : 8080\nSOCKSEnable : 1\nSOCKSProxy : ::1\nSOCKSPort : 1080\nExceptionsList : <array> {\n0 : *.internal.test\n}\n__SCOPED__ : <dictionary> {\nen0 : <dictionary> {\nHTTPProxy : ignored.test\n}\n}\n}\n").unwrap();
    assert_eq!(parsed["HTTP_PROXY"], "http://proxy.test:8080");
    assert_eq!(parsed["ALL_PROXY"], "socks5h://[::1]:1080");
    let mut proxies = parsed;
    proxies.insert("HTTPS_PROXY".into(), "http://secure.test:8443".into());
    proxies.insert(
        "NO_PROXY".into(),
        ".internal.test,10.0.0.0/8,[2001:db8::]/32,port.test:8443".into(),
    );
    for target in [
        "http://localhost",
        "https://a.localhost",
        "http://127.0.0.2",
        "http://[::1]",
        "http://x.internal.test",
        "http://10.2.3.4",
        "http://[2001:db8::1]",
        "https://port.test:8443",
    ] {
        assert_eq!(
            proxy_for_url(&Url::parse(target).unwrap(), &proxies),
            None,
            "{target}"
        );
    }
    assert_eq!(
        proxy_for_url(&Url::parse("https://otherinternal.test").unwrap(), &proxies),
        Some("http://secure.test:8443".into())
    );
    assert_eq!(
        proxy_for_url(&Url::parse("https://port.test:443").unwrap(), &proxies),
        Some("http://secure.test:8443".into())
    );
    assert!(
        system_settings("<dictionary> {\nHTTPEnable : 1\nHTTPProxy : proxy\nHTTPPort : 0\n}\n")
            .is_err()
    );
}
#[test]
fn desktop_settings_reject_credentials_paths_and_invalid_bypass() {
    for value in [
        "http://user:secret@proxy.test",
        "http://proxy.test/path",
        "ftp://proxy.test",
        "http://proxy.test?query",
        "http://proxy.test#hash",
    ] {
        assert!(proxy_setting(value).is_err());
    }
    assert_eq!(
        proxy_setting("https://proxy.test:8443/").unwrap(),
        "https://proxy.test:8443"
    );
    for value in [
        "bad.test:8080",
        "10.0.0.0/33",
        "[::1]/129",
        "bad/name",
        "-invalid.test",
        "bad_.test",
    ] {
        assert!(bypass_setting(value).is_err(), "{value}");
    }
    assert_eq!(
        bypass_setting("*.internal.test; 127.0.0.1,10.0.0.0/8").unwrap(),
        ".internal.test,10.0.0.0/8,127.0.0.1"
    );
}
#[test]
fn configured_ca_requires_regular_bounded_self_signed_authority_and_valid_signature() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("ca.pem");
    let original = authority(root.path());
    let native = rustls_native_certs::load_native_certs();
    assert!(!native.certs.is_empty());
    let environment = launch_environment(
        NetworkInput {
            extra_ca_pem: vec![original.clone()],
            ..Default::default()
        },
        &root.path().join("launch"),
    )
    .unwrap();
    let bytes = std::fs::read(&environment["SSL_CERT_FILE"]).unwrap();
    let mut remaining = bytes.as_slice();
    let mut retained = BTreeSet::new();
    while let Some(start) = remaining
        .windows(27)
        .position(|part| part == b"-----BEGIN CERTIFICATE-----")
    {
        let (rest, pem) = x509_parser::pem::parse_x509_pem(&remaining[start..]).unwrap();
        retained.insert(pem.contents);
        remaining = rest;
    }
    assert!(
        native
            .certs
            .iter()
            .all(|cert| retained.contains(cert.as_ref())),
        "additional CA must retain original native roots"
    );
    let (_, extra) = x509_parser::pem::parse_x509_pem(original.as_bytes()).unwrap();
    assert!(retained.contains(&extra.contents));
    assert!(
        environment
            .keys()
            .all(|name| crate::launch::allowed_environment(name))
    );

    std::fs::write(&path, &original).unwrap();
    assert!(
        ca_bundle(&path, true)
            .unwrap()
            .contains("BEGIN CERTIFICATE")
    );
    let (_, pem) = x509_parser::pem::parse_x509_pem(original.as_bytes()).unwrap();
    let mut der = pem.contents;
    let last = der.len() - 1;
    der[last] ^= 1;
    let broken = format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        base64::engine::general_purpose::STANDARD.encode(der)
    );
    std::fs::write(&path, broken).unwrap();
    assert!(ca_bundle(&path, true).is_err());
    std::fs::write(&path, format!("unexpected content\n{original}")).unwrap();
    assert!(ca_bundle(&path, true).is_err());
    assert!(ca_bundle(&path, false).is_ok());
    std::fs::write(&path, vec![b' '; 1_048_577]).unwrap();
    assert!(ca_bundle(&path, true).is_err());
    assert!(ca_bundle(root.path(), true).is_err());
    assert!(ca_bundle(Path::new("relative.pem"), true).is_err());
}
#[tokio::test]
async fn supplemental_ca_preserves_tls_validation_and_never_follows_redirects() {
    use tokio::io::AsyncBufReadExt;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    authority(root);
    openssl(
        root,
        &[
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "key.pem",
            "-out",
            "server.csr",
            "-subj",
            "/CN=localhost",
        ],
    );
    std::fs::write(root.join("server.cnf"),"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n").unwrap();
    openssl(
        root,
        &[
            "x509",
            "-req",
            "-in",
            "server.csr",
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-out",
            "cert.pem",
            "-days",
            "1",
            "-extfile",
            "server.cnf",
        ],
    );
    let mut child=tokio::process::Command::new("node").arg("-e").arg(r#"
const fs=require('node:fs'),https=require('node:https');
const server=https.createServer({cert:fs.readFileSync(process.argv[1]),key:fs.readFileSync(process.argv[2])},(req,res)=>{
 if(req.url==='/redirect'){res.writeHead(302,{location:'/followed'});res.end();}
 else {res.end('verified');}
});server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
process.stdin.on('end',()=>{server.closeAllConnections();server.close();});process.stdin.resume();
"#).arg(root.join("cert.pem")).arg(root.join("key.pem")).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn().unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let port = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let url = format!("https://localhost:{port}");
    let plain = client(&NetworkInput::default()).unwrap();
    assert!(plain.get(&url).send().await.is_err());
    let custom = client(&NetworkInput {
        extra_ca_pem: vec![ca_bundle(&root.join("ca.pem"), true).unwrap()],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        custom.get(&url).send().await.unwrap().text().await.unwrap(),
        "verified"
    );
    assert_eq!(
        custom
            .get(format!("{url}/redirect"))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        302
    );
    child.stdin.take();
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn configured_proxy_overrides_environment_and_loopback_still_connects_directly() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = proxy.accept().await.unwrap();
        let mut bytes = [0; 4096];
        let n = stream.read(&mut bytes).await.unwrap();
        assert!(
            std::str::from_utf8(&bytes[..n])
                .unwrap()
                .starts_with("GET http://model.invalid/models HTTP/1.1")
        );
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied")
            .await
            .unwrap();
    });
    let input = desktop(
        &serde_json::json!({"httpProxy":proxy_url}),
        &BTreeMap::from([("HTTP_PROXY".into(), "http://invalid.proxy:1".into())]),
    )
    .await
    .unwrap();
    let transport = client(&input).unwrap();
    assert_eq!(
        transport
            .get("http://model.invalid/models")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "proxied"
    );
    server.await.unwrap();
    let direct = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let direct_url = format!("http://{}/", direct.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = direct.accept().await.unwrap();
        let mut bytes = [0; 4096];
        let count = stream.read(&mut bytes).await.unwrap();
        assert!(count > 0);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndirect")
            .await
            .unwrap();
    });
    assert_eq!(
        transport
            .get(direct_url)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "direct"
    );
    server.await.unwrap();
}
