//! Finding herdr-web, the one browser that owns every tab, and starting it for the Herdr app when
//! none runs (helpers/web/PROTOCOL.md §1). The connection is one JSON object per line over
//! 127.0.0.1 TCP; the first line is a hello with the port file's token, which is never printed.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;

pub const OPEN_PANEL: &str = "open the Browser panel in Herdr";
pub const OLD_HELPER: &str = "herdr-web is an older version: close and reopen the Browser panel in Herdr to update it";

/// When no herdr-web answers: start one for the Herdr app (the agent doors only).
pub struct Spawn {
    /// The Herdr GUI pids; a field so tests never see the real app.
    pub herdr_pids: Box<dyn Fn() -> Vec<i32> + Send + Sync>,
    /// How long the new helper has to answer.
    pub wait: Duration,
}

impl Spawn {
    pub fn herdr() -> Spawn {
        Spawn { herdr_pids: Box::new(pgrep_herdr), wait: Duration::from_secs(8) }
    }
}

fn pgrep_herdr() -> Vec<i32> {
    let uid = unsafe { libc::getuid() }.to_string(); // this user's Herdr only
    let out = std::process::Command::new("/usr/bin/pgrep").args(["-x", "-U", &uid, "Herdr"]).stderr(std::process::Stdio::null()).output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect()).unwrap_or_default()
}

/// One open, greeted connection to herdr-web.
pub struct Helper {
    lines: Lines<BufReader<OwnedReadHalf>>,
    w: OwnedWriteHalf,
}

impl Helper {
    pub async fn send(&mut self, v: &Value) -> Result<(), String> {
        let mut s = v.to_string();
        s.push('\n');
        self.w.write_all(s.as_bytes()).await.map_err(|e| format!("herdr-web: {e}"))
    }

    /// The next JSON line (other lines are skipped); Err once herdr-web closed the connection.
    pub async fn next(&mut self) -> Result<Value, String> {
        loop {
            match self.lines.next_line().await {
                Ok(Some(l)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&l) {
                        return Ok(v);
                    }
                }
                _ => return Err("herdr-web closed the connection".into()),
            }
        }
    }
}

pub fn dir(app_home: &Path) -> PathBuf {
    app_home.join("data").join("herdr-web")
}

/// kill(pid, 0) succeeds, or fails only for lack of permission. pid 0 would mean our own group.
fn alive(pid: i32) -> bool {
    pid > 0 && (unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

/// `port-<pid>` files whose pid is alive, newest first.
fn candidates(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_prefix("port-").filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) else { continue };
        if !pid.parse().map(alive).unwrap_or(false) {
            continue;
        }
        let mtime = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        out.push((mtime, e.path()));
    }
    out.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    out.into_iter().map(|(_, p)| p).collect()
}

enum Hello {
    V2(Helper),
    /// Answered without `v >= 2`.
    Old,
    /// Answered v2 with an error (an agent hello with a bad group).
    Refused(String),
}

/// Connect to the helper of one port file and send `hello` (the token is added here).
async fn handshake(port_file: &Path, hello: &Value) -> Result<Hello, String> {
    let body = std::fs::read_to_string(port_file).map_err(|_| "no port file".to_string())?;
    let mut it = body.lines();
    let (Some(port), Some(token)) = (it.next().and_then(|p| p.trim().parse::<u16>().ok()), it.next()) else {
        return Err("bad port file".into());
    };
    let s = tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(("127.0.0.1", port)))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let (r, w) = s.into_split();
    let mut h = Helper { lines: BufReader::new(r).lines(), w };
    let mut hello = hello.clone();
    hello["token"] = json!(token.trim());
    h.send(&hello).await?;
    let reply = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let v = h.next().await?;
            if v["ev"] == "hello" {
                return Ok::<Value, String>(v);
            }
        }
    })
    .await
    .map_err(|_| "no hello".to_string())??;
    if !reply["v"].as_f64().map(|v| v >= 2.0).unwrap_or(false) {
        return Ok(Hello::Old);
    }
    Ok(match reply["error"].as_str() {
        Some(e) => Hello::Refused(format!("herdr-web refused the connection: {e}")),
        None => Hello::V2(h),
    })
}

/// Every live v2 helper (the cookie CLI imports into each). Never spawns.
pub async fn connect_all(app_home: &Path, hello: &Value) -> Result<Vec<Helper>, String> {
    let (mut out, mut old) = (Vec::new(), false);
    for p in candidates(&dir(app_home)) {
        match handshake(&p, hello).await {
            Ok(Hello::V2(h)) => out.push(h),
            Ok(Hello::Old) => old = true,
            _ => {}
        }
    }
    if out.is_empty() {
        return Err(if old { OLD_HELPER } else { OPEN_PANEL }.into());
    }
    Ok(out)
}

/// The newest live v2 helper, else one started for the Herdr app when `spawn` allows it.
pub async fn find(app_home: &Path, hello: &Value, spawn: Option<&Spawn>) -> Result<Helper, String> {
    let dir = dir(app_home);
    let mut old = false;
    for p in candidates(&dir) {
        match handshake(&p, hello).await {
            Ok(Hello::V2(h)) => return Ok(h),
            Ok(Hello::Refused(e)) => return Err(e),
            Ok(Hello::Old) => old = true,
            Err(_) => {}
        }
    }
    if old {
        return Err(OLD_HELPER.into());
    }
    let Some(spawn) = spawn else { return Err(OPEN_PANEL.into()) };
    let [pid] = (spawn.herdr_pids)()[..] else { return Err(OPEN_PANEL.into()) };
    start(app_home, &dir, pid)?;
    let port_file = dir.join(format!("port-{pid}"));
    let end = tokio::time::Instant::now() + spawn.wait;
    while tokio::time::Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(200)).await;
        match handshake(&port_file, hello).await {
            Ok(Hello::V2(h)) => return Ok(h),
            Ok(Hello::Refused(e)) => return Err(e),
            Ok(Hello::Old) => return Err(OLD_HELPER.into()),
            Err(_) => {}
        }
    }
    Err(format!("herdr-web did not start (see data/herdr-web/helper-{pid}.log)"))
}

/// Start herdr-web for Herdr pid `pid`, detached in its own process group with its output in
/// `helper-<pid>.log` (an inherited stdout would corrupt the MCP stream). Removes no file: the
/// helper's lock decides which one runs.
fn start(app_home: &Path, dir: &Path, pid: i32) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::os::unix::process::CommandExt;
    let bin = app_home.join("bin").join("herdr-web");
    if !bin.is_file() {
        return Err("herdr-web is not installed (run install-helpers.sh)".into());
    }
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(dir.join(format!("helper-{pid}.log")))
        .map_err(|e| format!("helper log: {e}"))?;
    let err = log.try_clone().map_err(|e| format!("helper log: {e}"))?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--herdr-pid").arg(pid.to_string()).arg("--port-file").arg(dir.join(format!("port-{pid}")));
    if std::env::var("HERDR_WEB_EPHEMERAL").as_deref() == Ok("1") {
        cmd.arg("--ephemeral");
    }
    let mut child = cmd
        .current_dir("/") // not the agent's working directory
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(err)
        .process_group(0)
        .spawn()
        .map_err(|e| format!("start herdr-web: {e}"))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::net::TcpListener;

    /// A scratch app home under $TMPDIR, removed on drop.
    pub struct Home(pub PathBuf);

    impl Home {
        pub fn new(tag: &str) -> Home {
            let p = std::env::temp_dir().join(format!("herdr-browser-test-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(dir(&p)).unwrap();
            Home(p)
        }

        pub fn port_file(&self, pid: i32, port: u16) {
            std::fs::write(dir(&self.0).join(format!("port-{pid}")), format!("{port}\ntest-token\n")).unwrap();
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A `sleep 600` we start and kill: a live pid that is no Herdr.
    pub struct FakePid(std::process::Child);

    impl FakePid {
        pub fn new() -> FakePid {
            FakePid(std::process::Command::new("/bin/sleep").arg("600").spawn().unwrap())
        }
        pub fn pid(&self) -> i32 {
            self.0.id() as i32
        }
    }

    impl Drop for FakePid {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A fake herdr-web on 127.0.0.1: answers each hello with `hello_reply` (an array: several
    /// lines), then each line with `answer(connection number, line)`; an answer `"close"` closes
    /// the connection. Counts connections; records every line it read.
    pub async fn fake_web(
        hello_reply: Value,
        answer: fn(usize, &Value) -> Vec<Value>,
    ) -> (u16, Arc<AtomicUsize>, Arc<std::sync::Mutex<Vec<Value>>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let conns = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (c, s) = (conns.clone(), seen.clone());
        tokio::spawn(async move {
            while let Ok((sock, _)) = l.accept().await {
                let n = c.fetch_add(1, Ordering::SeqCst);
                let (hello_reply, s) = (hello_reply.clone(), s.clone());
                tokio::spawn(async move {
                    let (r, mut w) = sock.into_split();
                    let mut lines = BufReader::new(r).lines();
                    let mut first = true;
                    while let Ok(Some(l)) = lines.next_line().await {
                        let v: Value = serde_json::from_str(&l).unwrap_or_default();
                        s.lock().unwrap().push(v.clone());
                        let out = match (first, &hello_reply) {
                            (true, Value::Array(a)) => a.clone(),
                            (true, h) => vec![h.clone()],
                            _ => answer(n, &v),
                        };
                        first = false;
                        for o in out {
                            if o == "close" || w.write_all(format!("{o}\n").as_bytes()).await.is_err() {
                                return;
                            }
                        }
                    }
                });
            }
        });
        (port, conns, seen)
    }

    fn none(_: usize, _: &Value) -> Vec<Value> {
        vec![]
    }

    fn hello() -> Value {
        json!({"op": "hello", "v": 2, "role": "cookies"})
    }

    /// `bin/herdr-web` that records its argv in `<home>/spawned` and exits.
    fn recording_bin(home: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let p = bin.join("herdr-web");
        std::fs::write(&p, format!("#!/bin/sh\necho \"$@\" > '{}'\necho started\n", home.join("spawned").display())).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        home.join("spawned")
    }

    fn spawn_with(pids: Vec<i32>) -> Spawn {
        Spawn { herdr_pids: Box::new(move || pids.clone()), wait: Duration::from_millis(600) }
    }

    #[tokio::test]
    async fn uses_a_live_v2_helper_and_sends_the_token() {
        let home = Home::new("live");
        let fake = FakePid::new();
        let (port, _, seen) = fake_web(json!({"ev": "hello", "v": 2, "role": "cookies"}), none).await;
        home.port_file(fake.pid(), port);
        assert!(find(&home.0, &hello(), None).await.is_ok());
        let first = seen.lock().unwrap()[0].clone();
        assert_eq!(first, json!({"op": "hello", "v": 2, "role": "cookies", "token": "test-token"}));
    }

    #[tokio::test]
    async fn skips_a_stale_pid() {
        let home = Home::new("stale");
        let mut dead = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = dead.id() as i32;
        dead.wait().unwrap(); // reaped: a zombie would still look alive
        let (port, conns, _) = fake_web(json!({"ev": "hello", "v": 2}), none).await;
        home.port_file(pid, port);
        // Not port-<pid> names: skipped too.
        std::fs::write(dir(&home.0).join(format!("port-{pid}.lock")), "").unwrap();
        assert_eq!(find(&home.0, &hello(), None).await.err().as_deref(), Some(OPEN_PANEL));
        assert_eq!(conns.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_old_helper_is_reported_and_never_respawned() {
        let home = Home::new("old");
        let marker = recording_bin(&home.0);
        let fake = FakePid::new();
        let (port, _, _) = fake_web(json!({"ev": "hello"}), none).await;
        home.port_file(fake.pid(), port);
        let sp = spawn_with(vec![424242]);
        assert_eq!(find(&home.0, &hello(), Some(&sp)).await.err().as_deref(), Some(OLD_HELPER));
        assert_eq!(connect_all(&home.0, &hello()).await.err().as_deref(), Some(OLD_HELPER));
        // v below 2 is old as well.
        let (port, _, _) = fake_web(json!({"ev": "hello", "v": 1}), none).await;
        home.port_file(fake.pid(), port);
        assert_eq!(find(&home.0, &hello(), None).await.err().as_deref(), Some(OLD_HELPER));
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn a_refused_hello_is_an_error() {
        let home = Home::new("refused");
        let fake = FakePid::new();
        let (port, _, _) = fake_web(json!({"ev": "hello", "v": 2, "role": "agent", "error": "bad group"}), none).await;
        home.port_file(fake.pid(), port);
        assert_eq!(find(&home.0, &hello(), None).await.err().as_deref(), Some("herdr-web refused the connection: bad group"));
    }

    #[tokio::test]
    async fn no_spawn_unless_exactly_one_herdr() {
        let home = Home::new("nospawn");
        let marker = recording_bin(&home.0);
        for pids in [vec![], vec![424242, 424243]] {
            let sp = spawn_with(pids);
            assert_eq!(find(&home.0, &hello(), Some(&sp)).await.err().as_deref(), Some(OPEN_PANEL));
        }
        assert_eq!(find(&home.0, &hello(), None).await.err().as_deref(), Some(OPEN_PANEL));
        assert_eq!(connect_all(&home.0, &hello()).await.err().as_deref(), Some(OPEN_PANEL));
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn spawns_for_the_one_herdr() {
        use std::os::unix::fs::PermissionsExt;
        let home = Home::new("spawn");
        let sp = spawn_with(vec![424242]);
        let d = dir(&home.0);
        std::fs::remove_dir_all(&d).unwrap();
        assert_eq!(find(&home.0, &hello(), Some(&sp)).await.err().as_deref(), Some("herdr-web is not installed (run install-helpers.sh)"));
        let marker = recording_bin(&home.0);
        assert_eq!(
            find(&home.0, &hello(), Some(&sp)).await.err().as_deref(),
            Some("herdr-web did not start (see data/herdr-web/helper-424242.log)")
        );
        let args = std::fs::read_to_string(&marker).unwrap();
        assert_eq!(args.trim(), format!("--herdr-pid 424242 --port-file {}", d.join("port-424242").display()));
        assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::read_to_string(d.join("helper-424242.log")).unwrap(), "started\n");
    }
}
