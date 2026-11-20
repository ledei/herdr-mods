//! `herdr-browser cookies ...`: copy sign-ins (cookies) from the user's own Chrome into the
//! helper's profile. User-driven only: a CLI the Browser panel's import dialog runs. It is not an
//! MCP tool or an agent op, and the helper refuses `import_cookies` from agent connections.
//!
//! Chrome on macOS stores each cookie value AES-128-CBC encrypted (prefix `v10`, IV 16 spaces,
//! PKCS7) under a key derived by PBKDF2-HMAC-SHA1(Keychain "Chrome Safe Storage" password,
//! "saltysalt", 1003 rounds, 16 bytes). From cookie DB version 24 the plaintext starts with
//! SHA-256(host_key), 32 bytes, which is dropped.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

/// Seconds between 1601-01-01 (Chrome's epoch) and 1970-01-01.
const CHROME_EPOCH_OFFSET: i64 = 11_644_473_600;

pub const USAGE: &str = "usage:
  herdr-browser cookies profiles --json
  herdr-browser cookies sites --profile <dir> --json
  herdr-browser cookies import --profile <dir> --sites a.com,b.se [--target native]
options: --chrome-dir DIR (default ~/Library/Application Support/Google/Chrome), --app-home DIR";

// ---------------------------------------------------------------- pure parts (unit tested)

/// The registrable site of a cookie host: the last two labels, or three when the last is a
/// 2-letter country code under a common second level (co.uk, com.au, ...). localhost, IPs and
/// single labels stay as they are.
pub fn site_of(host: &str) -> String {
    let h = host.trim().trim_start_matches('.').to_ascii_lowercase();
    let h = h.trim_end_matches('.');
    if h.parse::<std::net::IpAddr>().is_ok() || h.starts_with('[') || !h.contains('.') {
        return h.to_string();
    }
    let labels: Vec<&str> = h.split('.').collect();
    let n = labels.len();
    const SECOND: &[&str] = &["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "ltd", "plc", "sch", "nhs", "mil", "nom", "gv", "id"];
    let keep = if n >= 3 && labels[n - 1].len() == 2 && SECOND.contains(&labels[n - 2]) { 3 } else { 2 };
    labels[n.saturating_sub(keep)..].join(".")
}

/// Chrome's expires_utc (µs since 1601) → Unix seconds; None for 0 (a session cookie).
pub fn chrome_to_unix(expires_utc: i64) -> Option<f64> {
    (expires_utc > 0).then(|| expires_utc as f64 / 1e6 - CHROME_EPOCH_OFFSET as f64)
}

fn unix_now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

pub fn derive_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

/// Decrypt one `encrypted_value`. None: not `v10`, bad padding, or a hash prefix that is missing.
pub fn decrypt(key: &[u8; 16], blob: &[u8], db_version: i64) -> Option<Vec<u8>> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let body = blob.strip_prefix(b"v10")?;
    let mut buf = body.to_vec();
    let iv = [b' '; 16];
    let n = cbc::Decryptor::<aes::Aes128>::new(key.into(), &iv.into()).decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?.len();
    buf.truncate(n);
    if db_version >= 24 {
        if buf.len() < 32 {
            wipe_bytes(&mut buf);
            return None;
        }
        let rest = buf[32..].to_vec();
        wipe_bytes(&mut buf);
        return Some(rest);
    }
    Some(buf)
}

/// The same scheme forwards (selftest fixtures and unit tests).
pub fn encrypt(key: &[u8; 16], host_key: &str, value: &[u8], db_version: i64) -> Vec<u8> {
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use sha2::Digest;
    let mut plain = Vec::new();
    if db_version >= 24 {
        plain.extend_from_slice(&sha2::Sha256::digest(host_key.as_bytes()));
    }
    plain.extend_from_slice(value);
    let len = plain.len();
    plain.resize(len + 16 - len % 16, 0);
    let iv = [b' '; 16];
    let n = cbc::Encryptor::<aes::Aes128>::new(key.into(), &iv.into()).encrypt_padded_mut::<Pkcs7>(&mut plain, len).map(|c| c.len()).unwrap_or(0);
    plain.truncate(n);
    let mut out = b"v10".to_vec();
    out.extend_from_slice(&plain);
    out
}

fn wipe_bytes(b: &mut [u8]) {
    for x in b.iter_mut() {
        // Volatile so the zeroing is not optimized away as a dead store.
        unsafe { std::ptr::write_volatile(x, 0) };
    }
}

pub fn wipe(s: &mut String) {
    // SAFETY: zero bytes are valid UTF-8.
    wipe_bytes(unsafe { s.as_bytes_mut() });
    s.clear();
}

/// Chrome samesite column → CDP sameSite (-1 unspecified: omitted).
pub fn same_site(v: i64) -> Option<&'static str> {
    match v {
        0 => Some("None"),
        1 => Some("Lax"),
        2 => Some("Strict"),
        _ => None,
    }
}

/// One cookie row (from Chrome's `cookies` table) → a CDP CookieParam. Host-only cookies (no
/// leading dot) are set by URL so they stay host-only; domain cookies keep their domain.
pub fn cookie_param(row: &Value, value: &str) -> Value {
    let host = row["host_key"].as_str().unwrap_or("");
    let path = row["path"].as_str().filter(|p| p.starts_with('/')).unwrap_or("/");
    let secure = int(&row["is_secure"]) != 0;
    let mut c = json!({
        "name": row["name"].as_str().unwrap_or(""),
        "value": value,
        "path": path,
        "secure": secure,
        "httpOnly": int(&row["is_httponly"]) != 0,
    });
    if host.starts_with('.') {
        c["domain"] = json!(host);
    } else {
        c["url"] = json!(format!("{}://{}{}", if secure { "https" } else { "http" }, host, path));
    }
    if let Some(s) = same_site(int(&row["samesite"])) {
        c["sameSite"] = json!(s);
    }
    if int(&row["is_persistent"]) != 0 {
        if let Some(e) = chrome_to_unix(int(&row["expires_utc"])) {
            c["expires"] = json!(e);
        }
    }
    c
}

/// sqlite3 -json gives numbers, but be lenient with strings.
fn int(v: &Value) -> i64 {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0)
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// A site name from the user: letters, digits, dots, dashes, colons and brackets only (it ends
/// up inside an SQL string literal).
fn valid_site(s: &str) -> bool {
    !s.is_empty() && s.len() <= 253 && s.chars().all(|c| c.is_ascii_alphanumeric() || ".-:[]".contains(c))
}

// ---------------------------------------------------------------- Chrome files

struct Args {
    cmd: String,
    profile: Option<String>,
    sites: Vec<String>,
    chrome_dir: PathBuf,
    password_env: Option<String>,
    native: bool, // --target native: copy into the native (WebKit) view, not the Chrome one
}

fn default_chrome_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
    home.join("Library/Application Support/Google/Chrome")
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut a = Args { cmd: String::new(), profile: None, sites: Vec::new(), chrome_dir: default_chrome_dir(), password_env: None, native: false };
    let mut i = 0;
    while i < argv.len() {
        let flag = argv[i].clone();
        let next = argv.get(i + 1).cloned();
        let mut val = || {
            i += 1;
            next.clone().ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag.as_str() {
            "--json" => {}
            "--profile" => a.profile = Some(val()?),
            "--sites" => {
                a.sites = val()?.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect();
            }
            "--target" => a.native = val()? == "native",
            "--chrome-dir" => a.chrome_dir = PathBuf::from(val()?),
            // Test only: read the Keychain password from this env var instead of `security`.
            "--keychain-password-env" => a.password_env = Some(val()?),
            c if a.cmd.is_empty() && !c.starts_with('-') => a.cmd = c.to_string(),
            other => return Err(format!("unknown argument: {other}")),
        }
        i += 1;
    }
    Ok(a)
}

fn profiles(chrome_dir: &Path) -> Result<Vec<(String, String)>, String> {
    let ls = std::fs::read_to_string(chrome_dir.join("Local State")).map_err(|_| "Chrome's Local State was not found: is Google Chrome installed?".to_string())?;
    let v: Value = serde_json::from_str(&ls).map_err(|e| format!("Local State: {e}"))?;
    let mut out: Vec<(String, String)> = v["profile"]["info_cache"]
        .as_object()
        .map(|m| m.iter().map(|(dir, p)| (dir.clone(), p["name"].as_str().unwrap_or(dir).to_string())).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| (a.0 != "Default").cmp(&(b.0 != "Default")).then(a.0.cmp(&b.0)));
    Ok(out)
}

/// The profile dir, checked: one path component that Chrome lists.
fn profile_dir(a: &Args) -> Result<PathBuf, String> {
    let p = a.profile.as_deref().ok_or("--profile is required")?;
    let one = !p.is_empty() && p != "." && p != ".." && !p.contains('/') && !p.contains('\0');
    if !one || !profiles(&a.chrome_dir)?.iter().any(|(d, _)| d == p) {
        return Err(format!("no Chrome profile \"{p}\""));
    }
    Ok(a.chrome_dir.join(p))
}

/// A private copy of the profile's cookie DB (Chrome keeps the original open); removed on drop.
struct DbCopy {
    dir: PathBuf,
    db: PathBuf,
}

impl Drop for DbCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn copy_db(profile: &Path) -> Result<DbCopy, String> {
    use std::os::unix::fs::DirBuilderExt;
    let src = [profile.join("Network").join("Cookies"), profile.join("Cookies")]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("this Chrome profile has no cookie database")?;
    let mut rnd = [0u8; 8];
    {
        use std::io::Read;
        let _ = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut rnd));
    }
    let tag: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("herdr-browser-cookies-{}-{tag}", std::process::id()));
    std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|e| format!("temp dir: {e}"))?;
    let copy = DbCopy { db: dir.join("Cookies"), dir };
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let from = PathBuf::from(format!("{}{suffix}", src.display()));
        if from.is_file() {
            std::fs::copy(&from, copy.dir.join(format!("Cookies{suffix}"))).map_err(|e| format!("copy cookie database: {e}"))?;
        }
    }
    Ok(copy)
}

fn sqlite(db: &Path, sql: &str) -> Result<Vec<Value>, String> {
    let out = std::process::Command::new("/usr/bin/sqlite3")
        .arg("-readonly")
        .arg("-json")
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|e| format!("sqlite3: {e}"))?;
    if !out.status.success() {
        // sqlite's own message (schema, locking); it never contains row data.
        return Err(format!("sqlite3: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|e| format!("sqlite3 output: {e}"))
}

fn now_chrome() -> i64 {
    ((unix_now() as i64) + CHROME_EPOCH_OFFSET) * 1_000_000
}

// ---------------------------------------------------------------- the helper

fn port_file(app_home: &Path) -> Option<(String, String)> {
    let body = std::fs::read_to_string(app_home.join("data").join("herdr-browser").join("port")).ok()?;
    let mut l = body.lines();
    Some((l.next()?.trim().to_string(), l.next()?.trim().to_string()))
}

/// Sites open in the running helper's tabs (every group). Never starts the helper.
async fn open_sites(app_home: &Path) -> Vec<String> {
    let Some((port, token)) = port_file(app_home) else { return Vec::new() };
    let url = format!("ws://127.0.0.1:{port}/?token={token}");
    let fut = async {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.ok()?;
        ws.send(Message::text(json!({"t": "ui", "v": 1}).to_string())).await.ok()?;
        while let Some(Ok(m)) = ws.next().await {
            if let Message::Text(t) = m {
                let v: Value = serde_json::from_str(t.as_str()).unwrap_or_default();
                if v["t"] == "state" {
                    let _ = ws.close(None).await;
                    return Some(v);
                }
            }
        }
        None
    };
    let Ok(Some(state)) = tokio::time::timeout(Duration::from_secs(2), fut).await else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for g in state["groups"].as_array().into_iter().flatten() {
        for t in g["tabs"].as_array().into_iter().flatten() {
            let url = t["url"].as_str().unwrap_or("");
            let Some((scheme, rest)) = url.split_once("://") else { continue };
            if scheme != "http" && scheme != "https" {
                continue;
            }
            let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
            let host = auth.rsplit_once('@').map(|(_, h)| h).unwrap_or(auth);
            let host = if host.starts_with('[') { host.split(']').next().unwrap_or("").trim_start_matches('[') } else { host.split(':').next().unwrap_or("") };
            let s = site_of(host);
            if !s.is_empty() && !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}

fn keychain_password(a: &Args) -> Result<String, String> {
    if let Some(var) = &a.password_env {
        return std::env::var(var).map_err(|_| format!("{var} is not set"));
    }
    // macOS shows its own Allow prompt here; the password is never stored or logged.
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("security: {e}"))?;
    if !out.status.success() {
        return Err("macOS did not allow access to Chrome's sign-ins (the Keychain prompt was denied or Chrome's key is missing)".into());
    }
    let mut s = String::from_utf8(out.stdout).map_err(|_| "unexpected Keychain password".to_string())?;
    while s.ends_with('\n') || s.ends_with('\r') {
        s.pop();
    }
    Ok(s)
}

// ---------------------------------------------------------------- commands

fn print(v: &Value) {
    println!("{v}");
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("{}", json!({"error": msg}));
    ExitCode::from(1)
}

pub async fn main(app_home: PathBuf, argv: &[String]) -> ExitCode {
    let a = match parse_args(argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let r = match a.cmd.as_str() {
        "profiles" => profiles(&a.chrome_dir).map(|p| json!(p.into_iter().map(|(dir, name)| json!({"dir": dir, "name": name})).collect::<Vec<_>>())),
        "sites" => cmd_sites(&a, &app_home).await,
        "import" => cmd_import(&a, &app_home).await,
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match r {
        Ok(v) => {
            print(&v);
            ExitCode::SUCCESS
        }
        Err(e) => fail(&e),
    }
}

/// `[{site, cookies, expires_latest, open}]`: open sites first, then by count. Reads only
/// host_key, counts and expiry: never a value.
async fn cmd_sites(a: &Args, app_home: &Path) -> Result<Value, String> {
    let db = copy_db(&profile_dir(a)?)?;
    let sql = format!(
        "SELECT host_key, COUNT(*) AS n, MAX(CASE WHEN is_persistent != 0 THEN expires_utc ELSE 0 END) AS exp \
         FROM cookies WHERE is_persistent = 0 OR expires_utc > {} GROUP BY host_key",
        now_chrome()
    );
    let rows = sqlite(&db.db, &sql)?;
    drop(db);
    let open = open_sites(app_home).await;
    let mut sites: Vec<(String, i64, i64)> = Vec::new();
    for r in rows {
        let s = site_of(r["host_key"].as_str().unwrap_or(""));
        if s.is_empty() {
            continue;
        }
        let (n, exp) = (int(&r["n"]), int(&r["exp"]));
        match sites.iter_mut().find(|x| x.0 == s) {
            Some(x) => {
                x.1 += n;
                x.2 = x.2.max(exp);
            }
            None => sites.push((s, n, exp)),
        }
    }
    sites.sort_by(|x, y| (!open.contains(&x.0)).cmp(&!open.contains(&y.0)).then(y.1.cmp(&x.1)).then(x.0.cmp(&y.0)));
    Ok(json!(sites
        .into_iter()
        .map(|(site, n, exp)| json!({"site": site, "cookies": n, "expires_latest": chrome_to_unix(exp).map(|e| e as i64), "open": open.contains(&site)}))
        .collect::<Vec<_>>()))
}

/// Decrypt the picked sites' cookies and hand them to the helper (role `ui`). Prints
/// `{imported, skipped, sites}`; never a value.
/// Hands the cookies to every running native view helper (one per Herdr window) over its local socket; returns
/// (imported, skipped) as the first one that answered reports them.
fn send_native(app_home: &Path, cookies: &[Value]) -> Result<(u64, u64), String> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{SocketAddr, TcpStream};
    let dir = app_home.join("data/herdr-web");
    let mut result: Option<(u64, u64)> = None;
    let entries = std::fs::read_dir(&dir).map_err(|_| "the native view is not running: open the Browser panel first".to_string())?;
    for e in entries.flatten() {
        if !e.file_name().to_string_lossy().starts_with("port-") {
            continue;
        }
        let text = std::fs::read_to_string(e.path()).unwrap_or_default();
        let mut it = text.lines();
        let (Some(port), Some(token)) = (it.next().and_then(|p| p.trim().parse::<u16>().ok()), it.next()) else { continue };
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else { continue };
        let _ = s.set_read_timeout(Some(Duration::from_secs(20)));
        let hello = json!({"op": "hello", "token": token.trim()}).to_string();
        let op = json!({"op": "cookies", "cookies": cookies}).to_string();
        if s.write_all(format!("{hello}\n{op}\n").as_bytes()).is_err() {
            continue;
        }
        let mut r = BufReader::new(s);
        let mut line = String::new();
        while r.read_line(&mut line).unwrap_or(0) > 0 {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v["ev"] == "cookies" {
                    result.get_or_insert((v["imported"].as_u64().unwrap_or(0), v["skipped"].as_u64().unwrap_or(0)));
                    break;
                }
            }
            line.clear();
        }
    }
    result.ok_or_else(|| "the native view did not answer: open the Browser panel first".to_string())
}

async fn cmd_import(a: &Args, app_home: &Path) -> Result<Value, String> {
    if a.sites.is_empty() {
        return Err("--sites is required".into());
    }
    if let Some(bad) = a.sites.iter().find(|s| !valid_site(s)) {
        return Err(format!("not a site: {bad}"));
    }
    let profile = profile_dir(a)?;
    let db = copy_db(&profile)?;
    let version = sqlite(&db.db, "SELECT value FROM meta WHERE key = 'version'")?
        .first()
        .map(|r| int(&r["value"]))
        .unwrap_or(0);
    // Only rows that can belong to a picked site (exact grouping is checked again below).
    let cond: Vec<String> = a.sites.iter().map(|s| format!("host_key = '{s}' OR host_key = '.{s}' OR host_key LIKE '%.{s}'")).collect();
    let sql = format!(
        "SELECT host_key, name, value, hex(encrypted_value) AS ev, path, expires_utc, is_secure, is_httponly, samesite, is_persistent, \
         COALESCE(top_frame_site_key, '') AS tfsk FROM cookies WHERE {}",
        cond.join(" OR ")
    );
    let mut rows = sqlite(&db.db, &sql)?;
    drop(db);
    let mut password = keychain_password(a)?;
    let key = derive_key(password.as_bytes());
    wipe(&mut password);

    let now = unix_now();
    let mut skipped = 0u64;
    let mut cookies: Vec<Value> = Vec::new();
    let mut values: Vec<String> = Vec::new();
    for row in rows.iter_mut() {
        let host = row["host_key"].as_str().unwrap_or("").to_string();
        if !a.sites.contains(&site_of(&host)) {
            continue;
        }
        let expired = int(&row["is_persistent"]) != 0 && chrome_to_unix(int(&row["expires_utc"])).map(|e| e <= now).unwrap_or(false);
        // Partitioned (CHIPS) cookies belong to one top-level site; skipped.
        let partitioned = !row["tfsk"].as_str().unwrap_or("").is_empty();
        let ev = hex_decode(row["ev"].as_str().unwrap_or("")).unwrap_or_default();
        let value = if ev.is_empty() {
            Some(row["value"].as_str().unwrap_or("").to_string())
        } else {
            decrypt(&key, &ev, version).and_then(|b| String::from_utf8(b).ok())
        };
        // The plaintext column and the hex blob are no longer needed.
        if let Some(Value::String(s)) = row.get_mut("value") {
            wipe(s);
        }
        match value {
            Some(v) if !expired && !partitioned => {
                cookies.push(cookie_param(row, &v));
                values.push(v);
            }
            Some(mut v) => {
                wipe(&mut v);
                skipped += 1;
            }
            None => skipped += 1,
        }
    }
    let mut picked: Vec<String> = a.sites.clone();
    picked.dedup();
    let (imported, helper_skipped) = if cookies.is_empty() {
        (0, 0)
    } else if a.native {
        let r = send_native(app_home, &cookies);
        for c in cookies.iter_mut() {
            if let Some(Value::String(s)) = c.get_mut("value") {
                wipe(s);
            }
        }
        for v in values.iter_mut() {
            wipe(v);
        }
        r?
    } else {
        let mut conn = crate::mcp::Conn::new_ui(app_home.to_path_buf());
        let r = conn.request("import_cookies", &json!({"cookies": cookies})).await;
        for c in cookies.iter_mut() {
            if let Some(Value::String(s)) = c.get_mut("value") {
                wipe(s);
            }
        }
        for v in values.iter_mut() {
            wipe(v);
        }
        let res = r?;
        if res["ok"] != true {
            return Err(res["error"].as_str().unwrap_or("the helper refused the import").to_string());
        }
        (res["data"]["imported"].as_u64().unwrap_or(0), res["data"]["skipped"].as_u64().unwrap_or(0))
    };
    Ok(json!({"imported": imported, "skipped": skipped + helper_skipped, "sites": picked}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_grouping() {
        assert_eq!(site_of(".mail.google.com"), "google.com");
        assert_eq!(site_of("google.com"), "google.com");
        assert_eq!(site_of("www.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(site_of(".shop.example.com.au"), "example.com.au");
        assert_eq!(site_of("a.b.svt.se"), "svt.se");
        assert_eq!(site_of("localhost"), "localhost");
        assert_eq!(site_of("127.0.0.1"), "127.0.0.1");
        assert_eq!(site_of("::1"), "::1");
        assert_eq!(site_of(".Example.TEST"), "example.test");
    }

    #[test]
    fn expires_conversion() {
        assert_eq!(chrome_to_unix(0), None);
        // 2026-01-01T00:00:00Z = 1767225600 Unix.
        let chrome = (1_767_225_600i64 + 11_644_473_600) * 1_000_000;
        assert_eq!(chrome_to_unix(chrome), Some(1_767_225_600.0));
    }

    #[test]
    fn pbkdf2_sha1_matches_rfc6070() {
        // RFC 6070 test vector 2 ("password", "salt", 2 rounds), first 16 bytes.
        let mut k = [0u8; 20];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"password", b"salt", 2, &mut k);
        assert_eq!(k.iter().map(|b| format!("{b:02x}")).collect::<String>(), "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957");
    }

    #[test]
    fn decrypts_an_openssl_made_blob() {
        // Made independently: key = PBKDF2-HMAC-SHA1("peanuts", "saltysalt", 1003, 16);
        // printf 'hello-cookie' | openssl enc -aes-128-cbc -K <key> -iv 20202020202020202020202020202020
        let key = derive_key(b"peanuts");
        assert_eq!(key.iter().map(|b| format!("{b:02x}")).collect::<String>(), "d9a09d499b4e1b7461f28e67972c6dbd");
        let mut blob = b"v10".to_vec();
        blob.extend(hex_decode("6dca7d6b5cbca13a61d36f60543066a6").unwrap());
        assert_eq!(decrypt(&key, &blob, 23).as_deref(), Some(&b"hello-cookie"[..]));
    }

    #[test]
    fn decrypt_round_trips_with_and_without_the_hash_prefix() {
        let key = derive_key(b"fixture password");
        let v24 = encrypt(&key, ".example.com", b"s3cret=value;", 24);
        assert!(v24.starts_with(b"v10"));
        assert_eq!(decrypt(&key, &v24, 24).as_deref(), Some(&b"s3cret=value;"[..]));
        // Version 24 plaintext carries SHA-256(host_key) first.
        use sha2::Digest;
        let raw = decrypt(&key, &v24, 23).unwrap();
        assert_eq!(&raw[..32], &sha2::Sha256::digest(b".example.com")[..]);
        let v23 = encrypt(&key, ".example.com", b"plain", 23);
        assert_eq!(decrypt(&key, &v23, 23).as_deref(), Some(&b"plain"[..]));
        // Wrong key or prefix: no value.
        assert_eq!(decrypt(&derive_key(b"other"), &v24, 24), None);
        assert_eq!(decrypt(&key, b"v11abc", 24), None);
    }

    #[test]
    fn cookie_params() {
        let exp = (2_000_000_000i64 + CHROME_EPOCH_OFFSET) * 1_000_000;
        let row = json!({"host_key": "localhost", "name": "a", "path": "/x", "is_secure": 0, "is_httponly": 1, "samesite": 1, "is_persistent": 1, "expires_utc": exp});
        let c = cookie_param(&row, "v");
        assert_eq!(c["url"], "http://localhost/x");
        assert!(c.get("domain").is_none());
        assert_eq!(c["httpOnly"], true);
        assert_eq!(c["sameSite"], "Lax");
        assert_eq!(c["expires"], 2_000_000_000.0);
        let row = json!({"host_key": ".example.com", "name": "b", "path": "/", "is_secure": 1, "is_httponly": 0, "samesite": -1, "is_persistent": 0, "expires_utc": 0});
        let c = cookie_param(&row, "v");
        assert_eq!(c["domain"], ".example.com");
        assert!(c.get("sameSite").is_none());
        assert!(c.get("expires").is_none());
        // It is a valid CDP CookieParam.
        let p: chromiumoxide::cdp::browser_protocol::network::CookieParam = serde_json::from_value(c).unwrap();
        assert_eq!(p.domain.as_deref(), Some(".example.com"));
    }

    #[test]
    fn site_names_are_checked() {
        assert!(valid_site("example.com"));
        assert!(valid_site("127.0.0.1"));
        assert!(!valid_site("a'b.com"));
        assert!(!valid_site("a%.com"));
        assert!(!valid_site(""));
    }
}
