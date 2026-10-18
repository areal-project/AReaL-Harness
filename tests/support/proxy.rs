//! 本地代理只转发到固定 fixture，验证真实握手、DNS 和认证，不访问外部网络。
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        self,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};

pub const CERT: &[u8] = include_bytes!("../fixtures/proxy/cert.pem");
pub const CERT_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/proxy/cert.pem"
);
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub type Stream = Box<dyn Io>;

pub fn tls() -> TlsAcceptor {
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from_pem_slice(CERT).unwrap()],
        PrivateKeyDer::from_pem_slice(include_bytes!("../fixtures/proxy/key.pem")).unwrap(),
    )
    .unwrap();
    TlsAcceptor::from(Arc::new(config))
}

pub async fn headers(stream: &mut (impl AsyncRead + Unpin + ?Sized)) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 64 * 1024);
        bytes.push(stream.read_u8().await.unwrap());
    }
    String::from_utf8(bytes).unwrap()
}

pub fn child(test: &str) -> Command {
    let executable = std::env::current_exe().unwrap();
    #[cfg(target_os = "macos")]
    let mut command = {
        // 新构建二进制使用与 launcher 相同的可信 Python 父进程。
        let mut command = Command::new("/usr/bin/python3");
        command
            .args([
                "-I",
                "-S",
                "-c",
                "import os,sys; os.execv(sys.argv[1], sys.argv[1:])",
            ])
            .arg(executable);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(executable);
    command
        .args(["--exact", test, "--nocapture"])
        .env_clear()
        .kill_on_drop(true);
    command
}

pub struct Proxy {
    pub url: String,
    hits: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}
impl Proxy {
    pub async fn start(
        scheme: &'static str,
        origin: SocketAddr,
        hostname: &'static str,
        authenticated: bool,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    connection = listener.accept() => {
                        let (socket, _) = connection.unwrap();
                        let count = count.clone();
                        connections.spawn(async move {
                            tokio::time::timeout(Duration::from_secs(15), async move {
                                let mut stream: Stream = if scheme == "https" { Box::new(tls().accept(socket).await.unwrap()) } else { Box::new(socket) };
                                let mut upstream = TcpStream::connect(origin).await.unwrap();
                                if scheme.starts_with("socks") {
                                    socks(&mut *stream, scheme, origin.port(), hostname, authenticated).await;
                                } else {
                                    let request = headers(&mut *stream).await;
                                    let mut lines = request.lines();
                                    let first = lines.next().unwrap();
                                    if authenticated {
                                        assert!(lines.clone().any(|line| line.eq_ignore_ascii_case("proxy-authorization: Basic dXNlcjpwYXNzd29yZA==")));
                                    }
                                    if first.starts_with("CONNECT ") {
                                        assert_eq!(first, format!("CONNECT {hostname}:{} HTTP/1.1", origin.port()));
                                        stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
                                    } else {
                                        assert!(first.contains(&format!("http://{hostname}:{}/", origin.port())));
                                        // HTTP 转发代理负责移除自身认证，避免它进入目标请求。
                                        let forwarded = request.lines().filter(|line| {
                                            let lower = line.to_ascii_lowercase();
                                            !line.is_empty() && !lower.starts_with("proxy-authorization:") && !lower.starts_with("connection:")
                                        }).collect::<Vec<_>>().join("\r\n") + "\r\nConnection: close\r\n\r\n";
                                        upstream.write_all(forwarded.as_bytes()).await.unwrap();
                                    }
                                }
                                count.fetch_add(1, Ordering::SeqCst);
                                let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
                            }).await.expect("proxy connection timed out");
                        });
                    }
                    Some(result) = connections.join_next() => { result.unwrap(); }
                }
            }
        });
        let credentials = if authenticated { "user:password@" } else { "" };
        Self {
            url: format!("{scheme}://{credentials}{address}"),
            hits,
            task,
        }
    }
    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn socks(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin + ?Sized),
    scheme: &str,
    port: u16,
    hostname: &str,
    authenticated: bool,
) {
    let version = stream.read_u8().await.unwrap();
    assert_eq!(version, 5);
    let count = stream.read_u8().await.unwrap();
    let mut methods = vec![0; count.into()];
    stream.read_exact(&mut methods).await.unwrap();
    let method = if authenticated { 2 } else { 0 };
    assert!(methods.contains(&method));
    stream.write_all(&[5, method]).await.unwrap();
    if authenticated {
        assert_eq!(stream.read_u8().await.unwrap(), 1);
        for expected in [b"user".as_slice(), b"password".as_slice()] {
            let length = stream.read_u8().await.unwrap();
            let mut actual = vec![0; length.into()];
            stream.read_exact(&mut actual).await.unwrap();
            assert_eq!(actual, expected);
        }
        stream.write_all(&[1, 0]).await.unwrap();
    }
    let mut header = [0; 4];
    stream.read_exact(&mut header).await.unwrap();
    assert_eq!(&header[..3], &[5, 1, 0]);
    match header[3] {
        3 => {
            let length = stream.read_u8().await.unwrap();
            let mut name = vec![0; length.into()];
            stream.read_exact(&mut name).await.unwrap();
            if scheme == "socks5h" {
                assert_eq!(name, hostname.as_bytes());
            } else {
                // 底层连接器可将已解析的 IPv6 地址编码为域名字段，仍须是本地解析后的 IP。
                let name = String::from_utf8(name).unwrap();
                assert!(
                    name.trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .unwrap()
                        .is_loopback()
                );
            }
        }
        kind => {
            assert_eq!(scheme, "socks5");
            let address = match kind {
                1 => {
                    let mut bytes = [0; 4];
                    stream.read_exact(&mut bytes).await.unwrap();
                    std::net::IpAddr::from(bytes)
                }
                4 => {
                    let mut bytes = [0; 16];
                    stream.read_exact(&mut bytes).await.unwrap();
                    std::net::IpAddr::from(bytes)
                }
                other => panic!("invalid SOCKS address type {other}"),
            };
            assert!(address.is_loopback());
        }
    }
    assert_eq!(stream.read_u16().await.unwrap(), port);
    stream
        .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
        .await
        .unwrap();
}
