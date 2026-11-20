//! Control WebSocket server: a thin adapter between socket frames and engine `Cmd`s.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use crate::engine::{client_channel, Cmd, Config, Engine};
use crate::proto::parse_client;
use crate::select::write_atomic;

pub struct ServerHandle {
    pub port: u16,
    /// Clients must connect to `ws://127.0.0.1:<port>/?token=<token>`.
    pub token: String,
    pub cmd_tx: mpsc::UnboundedSender<Cmd>,
    /// Finishes after the engine has exited (Chrome is gone) and the port/pid files are removed.
    pub done: JoinHandle<()>,
}

pub async fn start(cfg: Config, write_files: bool) -> std::io::Result<ServerHandle> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let port_file = cfg.data_dir.join("port");
    let pid_file = cfg.data_dir.join("pid");
    let token = new_token()?;
    // The port file holds "<port>\n<token>\n" and is 0600, so only this user can connect.
    let port_body = format!("{port}\n{token}\n");
    if write_files {
        std::fs::create_dir_all(&cfg.data_dir)?;
        write_atomic(&pid_file, std::process::id().to_string().as_bytes()).map_err(std::io::Error::other)?;
        write_private(&port_file, port_body.as_bytes())?;
    }
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let engine_task = tokio::spawn(Engine::new(cfg).run(cmd_rx));
    let auth = Arc::new(Auth { token: token.clone(), host: format!("127.0.0.1:{port}") });
    let accept_task = tokio::spawn(accept_loop(listener, cmd_tx.clone(), auth));
    let done = tokio::spawn(async move {
        let _ = engine_task.await;
        accept_task.abort();
        if write_files {
            remove_if_ours(&port_file, &port_body);
            remove_if_ours(&pid_file, &std::process::id().to_string());
        }
    });
    Ok(ServerHandle { port, token, cmd_tx, done })
}

/// 128 random bits, hex.
fn new_token() -> std::io::Result<String> {
    use std::io::Read;
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Atomic write of a file that is 0600 from the moment it exists.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
    f.write_all(bytes)?;
    drop(f);
    std::fs::rename(&tmp, path)
}

struct Auth {
    token: String,
    host: String,
}

fn query_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == name).then_some(v)
    })
}

fn eq_ct(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Why a handshake is refused, or None to accept. Web pages always send `Origin` on a WebSocket
/// handshake and cannot drop it, so any `Origin` is refused; `Host` must be exactly ours (DNS
/// rebinding); the token proves the client could read the 0600 port file.
fn refuse(req: &Request, auth: &Auth) -> Option<&'static str> {
    if req.headers().contains_key("origin") {
        return Some("origin not allowed");
    }
    let host = req.headers().get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    if host != auth.host {
        return Some("bad host");
    }
    let token = req.uri().query().and_then(|q| query_param(q, "token")).unwrap_or("");
    if !eq_ct(token.as_bytes(), auth.token.as_bytes()) {
        return Some("bad token");
    }
    None
}

fn remove_if_ours(path: &PathBuf, value: &str) {
    if std::fs::read_to_string(path).map(|s| s.trim() == value.trim()).unwrap_or(false) {
        let _ = std::fs::remove_file(path);
    }
}

async fn accept_loop(listener: TcpListener, cmd_tx: mpsc::UnboundedSender<Cmd>, auth: Arc<Auth>) {
    let ids = AtomicU64::new(1);
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let id = ids.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(serve(stream, id, cmd_tx.clone(), auth.clone()));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

async fn serve(stream: TcpStream, id: u64, cmd_tx: mpsc::UnboundedSender<Cmd>, auth: Arc<Auth>) {
    let _ = stream.set_nodelay(true);
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        match refuse(req, &auth) {
            None => Ok(resp),
            Some(why) => {
                let mut e = ErrorResponse::new(Some(why.to_string()));
                *e.status_mut() = StatusCode::FORBIDDEN;
                Err(e)
            }
        }
    };
    let accept = tokio_tungstenite::accept_hdr_async(stream, check);
    let ws = match tokio::time::timeout(Duration::from_secs(5), accept).await {
        Ok(Ok(ws)) => ws,
        _ => return,
    };
    let (mut sink, mut source) = ws.split();
    let (out, mut rx) = client_channel();
    if cmd_tx.send(Cmd::Connect { id, out }).is_err() {
        return;
    }
    let (done_tx, mut done_rx) = oneshot::channel::<()>();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                m = rx.ctrl.recv() => match m {
                    Some(s) => if sink.send(Message::text(s)).await.is_err() { break },
                    // The engine dropped us (replaced by a newer client or shutting down).
                    None => break,
                },
                r = rx.frame.changed() => {
                    if r.is_err() { break }
                    let s = rx.frame.borrow_and_update().clone();
                    if let Some(s) = s {
                        if sink.send(Message::text(s)).await.is_err() { break }
                    }
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), sink.send(Message::Close(None))).await;
        let _ = done_tx.send(());
    });
    loop {
        tokio::select! {
            m = source.next() => match m {
                Some(Ok(Message::Text(t))) => {
                    let c = match parse_client(t.as_str()) {
                        Ok(msg) => Cmd::Client { id, msg },
                        Err(err) => Cmd::BadMessage { id, err },
                    };
                    if cmd_tx.send(c).is_err() { break }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = &mut done_rx => break,
        }
    }
    let _ = cmd_tx.send(Cmd::Disconnect { id });
    writer.abort();
}

/// True if a live sidecar already serves on the port in `<data_dir>/port`.
pub fn live_instance(data_dir: &Path) -> bool {
    let read = |n: &str| std::fs::read_to_string(data_dir.join(n)).ok().map(|s| s.trim().to_string());
    let port = read("port").and_then(|s| s.lines().next().map(|l| l.trim().to_string()));
    let (Some(port), Some(pid)) = (port, read("pid")) else { return false };
    let (Ok(port), Ok(pid)) = (port.parse::<u16>(), pid.parse::<i32>()) else { return false };
    if pid as u32 == std::process::id() || unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(uri: &str, headers: &[(&str, &str)]) -> Request {
        let mut b = Request::builder().uri(uri);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        b.body(()).unwrap()
    }

    #[test]
    fn handshake_auth() {
        let a = Auth { token: "abc123".into(), host: "127.0.0.1:4000".into() };
        let host = ("host", "127.0.0.1:4000");
        assert_eq!(refuse(&req("/?token=abc123", &[host]), &a), None);
        assert_eq!(refuse(&req("/?x=1&token=abc123", &[host]), &a), None);
        assert_eq!(refuse(&req("/", &[host]), &a), Some("bad token"));
        assert_eq!(refuse(&req("/?token=abc124", &[host]), &a), Some("bad token"));
        assert_eq!(refuse(&req("/?token=abc12", &[host]), &a), Some("bad token"));
        assert_eq!(refuse(&req("/?token=abc123", &[("host", "evil.com:4000")]), &a), Some("bad host"));
        assert_eq!(refuse(&req("/?token=abc123", &[]), &a), Some("bad host"));
        assert_eq!(
            refuse(&req("/?token=abc123", &[host, ("origin", "https://evil.example")]), &a),
            Some("origin not allowed")
        );
    }

    #[test]
    fn token_is_random_hex() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
