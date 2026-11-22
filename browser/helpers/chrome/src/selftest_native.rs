//! `herdr-browser --selftest-native <herdr-web>`: herdr-web end to end through the MCP door.
//! Starts its own herdr-web (a temp home, a `sleep 600` as the fake Herdr pid, `--ephemeral`) and
//! a local page server, drives all 16 tools for two agent terminals through `Mcp::handle`, and
//! prints ALL PASS. It kills everything it started, and puts the pasteboard back if it changed
//! (it never prints pasteboard contents, only whether changeCount stayed the same).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::agent::{png_size, PAGE_NOTE};
use crate::mcp::{Conn, Mcp, TOOLS};

const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Selftest</title></head>
<body style="margin:0;font:16px sans-serif">
<h1>Selftest page</h1>
<input id=name aria-label="Name">
<input id=pw type=password aria-label="Password" value="hunter2-secret">
<input id=plain aria-label="Plain" value="plain-visible">
<button id=btn style="width:120px;height:40px">Press me</button>
<select id=sel aria-label="Color"><option value=r>Red</option><option value=g>Green</option></select>
<label><input type=checkbox id=cb> Agree</label>
<p id=api>api-pending</p>
<div style="height:3000px"></div>
<button id=bottom>Bottom button</button>
<script>
window.clicks = 0; window.dbl = 0; window.ctx = 0; window.mid = 0; window.trusted = []; window.keys = [];
const b = document.getElementById('btn');
b.addEventListener('click', e => { clicks++; trusted.push('click:' + e.isTrusted) });
b.addEventListener('dblclick', () => dbl++);
b.addEventListener('auxclick', e => { if (e.button === 1) mid++ });
b.addEventListener('contextmenu', e => { ctx++; trusted.push('ctx:' + e.isTrusted) });
document.getElementById('name').addEventListener('input', e => trusted.push('input:' + e.isTrusted));
document.addEventListener('keydown', e => keys.push(e.key + ':' + e.isTrusted));
console.log('selftest-console-' + location.search.slice(1));
fetch('/api').then(r => r.json()).then(j => { document.getElementById('api').textContent = 'api-done ' + j.n });
</script></body></html>"#;

const PAGE_TWO: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Two</title></head><body><p>Second page</p></body></html>"#;

const PAGE_CSP: &str = r#"<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>Csp</title></head><body><p>No scripts here</p></body></html>"#;

// ---------------------------------------------------------------- pasteboard (objc runtime)

/// A pasteboard's items, held in memory (retained) and put back on drop if the pasteboard
/// changed. AppKit is loaded at run time, so the `mcp` and `call` doors never load it.
mod pasteboard {
    use std::ffi::{c_char, c_void, CStr};

    pub type Id = *mut c_void;

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Id;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(p: *mut c_void);
    }

    unsafe fn cls(n: &CStr) -> Id {
        objc_getClass(n.as_ptr())
    }
    unsafe fn id0(o: Id, s: &CStr) -> Id {
        let f: unsafe extern "C" fn(Id, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(o, sel_registerName(s.as_ptr()))
    }
    unsafe fn int0(o: Id, s: &CStr) -> isize {
        let f: unsafe extern "C" fn(Id, Id) -> isize = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(o, sel_registerName(s.as_ptr()))
    }
    unsafe fn id1(o: Id, s: &CStr, a: Id) -> Id {
        let f: unsafe extern "C" fn(Id, Id, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(o, sel_registerName(s.as_ptr()), a)
    }
    unsafe fn at(o: Id, i: usize) -> Id {
        let f: unsafe extern "C" fn(Id, Id, usize) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(o, sel_registerName(c"objectAtIndex:".as_ptr()), i)
    }
    unsafe fn set_data(item: Id, data: Id, ty: Id) {
        let f: unsafe extern "C" fn(Id, Id, Id, Id) -> i8 = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(item, sel_registerName(c"setData:forType:".as_ptr()), data, ty);
    }
    unsafe fn array(a: Id) -> Vec<Id> {
        if a.is_null() {
            return Vec::new();
        }
        (0..int0(a, c"count") as usize).map(|i| at(a, i)).collect()
    }

    fn appkit() -> Result<(), String> {
        let h = unsafe { libc::dlopen(c"/System/Library/Frameworks/AppKit.framework/AppKit".as_ptr(), libc::RTLD_LAZY) };
        if h.is_null() || unsafe { cls(c"NSPasteboard") }.is_null() {
            return Err("AppKit's NSPasteboard is not available".into());
        }
        Ok(())
    }

    /// NSPasteboard.general.
    pub fn general() -> Result<Id, String> {
        appkit()?;
        let pb = unsafe { id0(cls(c"NSPasteboard"), c"generalPasteboard") };
        if pb.is_null() {
            return Err("no general pasteboard".into());
        }
        Ok(pb)
    }

    pub struct Saved {
        pb: Id,
        items: Vec<Vec<(Id, Id)>>,
        count: isize,
    }

    impl Saved {
        pub fn save(pb: Id) -> Saved {
            unsafe {
                let pool = objc_autoreleasePoolPush();
                let count = int0(pb, c"changeCount");
                let items = array(id0(pb, c"pasteboardItems"))
                    .into_iter()
                    .map(|it| {
                        array(id0(it, c"types"))
                            .into_iter()
                            .filter_map(|t| {
                                let d = id1(it, c"dataForType:", t);
                                (!d.is_null()).then(|| (id0(t, c"retain"), id0(d, c"retain")))
                            })
                            .collect()
                    })
                    .collect();
                objc_autoreleasePoolPop(pool);
                Saved { pb, items, count }
            }
        }

        pub fn changed(&self) -> bool {
            unsafe { int0(self.pb, c"changeCount") != self.count }
        }
    }

    impl Drop for Saved {
        /// Put the saved items back, only when the pasteboard changed.
        fn drop(&mut self) {
            if !self.changed() {
                return;
            }
            unsafe {
                let pool = objc_autoreleasePoolPush();
                int0(self.pb, c"clearContents");
                let arr = id0(cls(c"NSMutableArray"), c"array");
                for kept in &self.items {
                    let it = id0(id0(cls(c"NSPasteboardItem"), c"alloc"), c"init");
                    for (t, d) in kept {
                        set_data(it, *d, *t);
                    }
                    id1(arr, c"addObject:", it);
                    id0(it, c"release");
                }
                id1(self.pb, c"writeObjects:", arr);
                objc_autoreleasePoolPop(pool);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// On a private pasteboard, never the general one.
        #[test]
        fn saved_items_come_back_after_a_change() {
            appkit().unwrap();
            unsafe {
                let pb = id0(cls(c"NSPasteboard"), c"pasteboardWithUniqueName");
                assert!(!pb.is_null());
                let ty = id1(cls(c"NSString"), c"stringWithUTF8String:", c"org.herdr.selftest.private".as_ptr() as Id);
                let mk: unsafe extern "C" fn(Id, Id, *const u8, usize) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                let data = mk(cls(c"NSData"), sel_registerName(c"dataWithBytes:length:".as_ptr()), b"kept".as_ptr(), 4);
                int0(pb, c"clearContents");
                let it = id0(id0(cls(c"NSPasteboardItem"), c"alloc"), c"init");
                set_data(it, data, ty);
                let arr = id0(cls(c"NSMutableArray"), c"array");
                id1(arr, c"addObject:", it);
                id1(pb, c"writeObjects:", arr);

                let saved = Saved::save(pb);
                assert!(!saved.changed());
                int0(pb, c"clearContents");
                assert!(saved.changed());
                assert!(id1(pb, c"dataForType:", ty).is_null());
                drop(saved);
                let back = id1(pb, c"dataForType:", ty);
                let eq: unsafe extern "C" fn(Id, Id, Id) -> i8 = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                let same = !back.is_null() && eq(back, sel_registerName(c"isEqualToData:".as_ptr()), data) != 0;
                id0(pb, c"releaseGlobally");
                assert!(same);
            }
        }
    }
}

// ---------------------------------------------------------------- what the selftest started

/// herdr-web and the fake Herdr pid: killed and reaped on drop, whatever happened.
struct Started {
    kids: Vec<Child>,
}

impl Drop for Started {
    fn drop(&mut self) {
        for k in self.kids.iter_mut().rev() {
            let _ = k.kill();
            let _ = k.wait();
        }
    }
}

struct Checks {
    run: usize,
    failed: Vec<String>,
}

impl Checks {
    fn check(&mut self, name: &str, ok: bool, detail: impl std::fmt::Display) {
        self.run += 1;
        if ok {
            println!("ok    {name}");
        } else {
            let d = detail.to_string();
            let d: String = d.chars().take(400).collect();
            println!("FAIL  {name}: {d}");
            self.failed.push(name.to_string());
        }
    }
}

/// One agent terminal: its MCP handler and the tools it called.
struct Agent {
    m: Mcp,
    tag: &'static str,
    called: HashSet<String>,
    rpc: u64,
}

/// A tool result: (ok, text of every text part, the raw result).
struct Res {
    ok: bool,
    text: String,
    raw: Value,
}

impl Res {
    /// The JSON after the page-content marker line.
    fn json(&self) -> Value {
        let body = self.text.strip_prefix(PAGE_NOTE).unwrap_or(&self.text).trim_start();
        serde_json::from_str(body).unwrap_or_else(|_| json!(self.text))
    }
}

impl Agent {
    async fn new(home: &Path, tag: &'static str) -> Agent {
        let mut conn = Conn::new(home.to_path_buf(), "selftest");
        // Never the real Herdr: no spawn, and the terminal is set here, not from the env.
        (conn.spawn, conn.terminal) = (None, Some(format!("selftest-{tag}")));
        let mut a = Agent { m: Mcp { conn }, tag, called: HashSet::new(), rpc: 0 };
        a.rpc("initialize", json!({"protocolVersion": "2025-06-18", "clientInfo": {"name": format!("selftest-{tag}")}})).await;
        a
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.rpc += 1;
        self.m.handle(&json!({"jsonrpc": "2.0", "id": self.rpc, "method": method, "params": params})).await.unwrap_or_default()
    }

    async fn tool(&mut self, name: &str, args: Value) -> Res {
        self.called.insert(name.to_string());
        let r = self.rpc("tools/call", json!({"name": name, "arguments": args})).await;
        let raw = r["result"].clone();
        let text = raw["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
        Res { ok: raw["isError"] != true && r.get("error").is_none(), text, raw }
    }

    async fn js(&mut self, code: &str) -> Value {
        let r = self.tool("browser_javascript", json!({"code": code})).await;
        if r.ok {
            r.json()
        } else {
            json!(format!("ERR {}", r.text))
        }
    }

    /// Re-run `code` until it returns `want` (3 s); the last value.
    async fn js_until(&mut self, code: &str, want: &Value) -> Value {
        let end = Instant::now() + Duration::from_secs(3);
        loop {
            let v = self.js(code).await;
            if &v == want || Instant::now() > end {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn tab_ids(&mut self) -> Vec<i64> {
        let r = self.tool("browser_tabs", json!({})).await;
        r.json().as_array().into_iter().flatten().filter_map(|t| t["id"].as_i64()).collect()
    }
}

/// The ref (`e12`) on the first line of a read_page text that contains `needle`.
fn ref_of(text: &str, needle: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains(needle))?;
    let rest = &line[line.find("[ref=")? + 5..];
    Some(rest[..rest.find(']')?].to_string())
}

// ---------------------------------------------------------------- page server

async fn serve_pages(l: tokio::net::TcpListener) {
    loop {
        let Ok((mut s, _)) = l.accept().await else { return };
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 2048];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 65536 {
                match s.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let head = String::from_utf8_lossy(&buf);
            let path = head.split_whitespace().nth(1).unwrap_or("/");
            let (status, kind, body) = match path.split('?').next().unwrap_or("/") {
                "/" => ("200 OK", "text/html; charset=utf-8", PAGE.to_string()),
                "/two" => ("200 OK", "text/html; charset=utf-8", PAGE_TWO.to_string()),
                "/csp" => ("200 OK", "text/html; charset=utf-8", PAGE_CSP.to_string()),
                "/api" => ("200 OK", "application/json", "{\"n\":7}".to_string()),
                _ => ("404 Not Found", "text/plain", "no".to_string()),
            };
            let resp = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = s.write_all(resp.as_bytes()).await;
            let _ = s.shutdown().await;
        });
    }
}

// ---------------------------------------------------------------- the run

pub async fn run(web: PathBuf) -> ExitCode {
    if !web.is_file() {
        eprintln!("--selftest-native: no herdr-web at {}", web.display());
        return ExitCode::from(2);
    }
    let pb = match pasteboard::general() {
        Ok(pb) => pb,
        Err(e) => {
            eprintln!("--selftest-native: {e}");
            return ExitCode::FAILURE;
        }
    };
    let saved = pasteboard::Saved::save(pb);
    let home = std::env::temp_dir().join(format!("herdr-selftest-native-{}", std::process::id()));
    let mut c = Checks { run: 0, failed: Vec::new() };
    let res = {
        let mut started = Started { kids: Vec::new() };
        let r = body(&web, &home, &mut started, &mut c).await;
        drop(started);
        r
    };
    if let Err(e) = res {
        c.check("setup", false, e);
    }
    let changed = saved.changed();
    drop(saved); // puts the saved items back if it changed
    c.check("pasteboard changeCount unchanged by the run", !changed, "it changed; the saved items were put back");
    if c.failed.is_empty() {
        let _ = std::fs::remove_dir_all(&home);
        println!("ALL PASS ({} checks)", c.run);
        ExitCode::SUCCESS
    } else {
        println!("{} of {} checks FAILED: {}", c.failed.len(), c.run, c.failed.join(", "));
        println!("herdr-web log: {}", home.join("data/herdr-web/helper.log").display());
        ExitCode::from(1)
    }
}

async fn body(web: &Path, home: &Path, started: &mut Started, c: &mut Checks) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    let dir = crate::native::dir(home);
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| format!("temp home: {e}"))?;

    let fake = Command::new("/bin/sleep").arg("600").stdin(Stdio::null()).spawn().map_err(|e| format!("sleep: {e}"))?;
    let pid = fake.id();
    started.kids.push(fake);
    let port_file = dir.join(format!("port-{pid}"));
    let log = std::fs::File::create(dir.join("helper.log")).map_err(|e| format!("log: {e}"))?;
    let err = log.try_clone().map_err(|e| format!("log: {e}"))?;
    let child = Command::new(web)
        .arg("--herdr-pid")
        .arg(pid.to_string())
        .arg("--port-file")
        .arg(&port_file)
        .arg("--ephemeral")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err)
        .spawn()
        .map_err(|e| format!("start herdr-web: {e}"))?;
    started.kids.push(child);
    let end = Instant::now() + Duration::from_secs(10);
    while !port_file.is_file() {
        if Instant::now() > end {
            return Err("herdr-web wrote no port file in 10 s".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("page server: {e}"))?;
    let base = format!("http://127.0.0.1:{}", l.local_addr().map_err(|e| e.to_string())?.port());
    let server = tokio::spawn(serve_pages(l));

    let mut a = Agent::new(home, "a").await;
    let mut b = Agent::new(home, "b").await;
    drive(&mut a, &base, c).await;
    drive(&mut b, &base, c).await;
    isolation(&mut a, &mut b, c).await;
    urls(&mut a, &base, c).await;
    js_once(&mut a, &base, c).await;
    tab_limit(&mut a, c).await;
    select_shown(home, &mut a, &mut b, c).await;

    let all: HashSet<String> = TOOLS.iter().map(|t| t.name.to_string()).collect();
    for ag in [&a, &b] {
        let missing: Vec<&String> = all.difference(&ag.called).collect();
        c.check(&format!("[{}] all 16 tools were called", ag.tag), all.len() == 16 && missing.is_empty(), format!("missing {missing:?}"));
    }

    // quit: herdr-web removes its port file and exits.
    match crate::native::find(home, &json!({"op": "hello", "v": 2, "role": "panel"}), None).await {
        Ok(mut p) => {
            let _ = p.send(&json!({"op": "quit"})).await;
            let web = started.kids.last_mut().expect("herdr-web was started");
            let end = Instant::now() + Duration::from_secs(5);
            let mut exited = false;
            while Instant::now() < end {
                if let Ok(Some(_)) = web.try_wait() {
                    exited = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            c.check("quit: herdr-web exits and removes its port file", exited && !port_file.exists(), format!("exited {exited}, port file left {}", port_file.exists()));
        }
        Err(e) => c.check("quit: panel connects", false, e),
    }
    server.abort();
    Ok(())
}

/// Every tool on the test page, for one agent terminal.
async fn drive(a: &mut Agent, base: &str, c: &mut Checks) {
    let t = a.tag;
    let ck = |c: &mut Checks, name: &str, ok: bool, d: &dyn std::fmt::Display| c.check(&format!("[{t}] {name}"), ok, d);

    let ids = a.tab_ids().await;
    ck(c, "tabs: a new group has one tab", ids.len() == 1, &format!("{ids:?}"));
    let url = format!("{base}/?{t}");
    let r = a.tool("browser_navigate", json!({"url": url})).await;
    let v = r.json();
    ck(c, "navigate: loads the page", r.ok && v["title"] == "Selftest" && v["url"] == url.as_str(), &r.text);
    let r = a.tool("browser_wait", json!({"text": "api-done"})).await;
    ck(c, "wait text: found", r.ok && r.json()["found"] == true, &r.text);
    let r = a.tool("browser_wait", json!({"ms": 50})).await;
    ck(c, "wait ms", r.ok && r.json()["waited_ms"] == 50, &r.text);
    let r = a.tool("browser_wait", json!({"text": "never-on-the-page", "timeout_ms": 400})).await;
    ck(c, "wait text: times out", !r.ok && r.text.contains("text not on the page after 400 ms"), &r.text);

    let r = a.tool("browser_get_page_text", json!({})).await;
    ck(c, "get_page_text", r.ok && r.text.starts_with(PAGE_NOTE) && r.text.contains("Title: Selftest") && r.text.contains("Selftest page") && r.text.contains("api-done 7"), &r.text);

    // javascript
    let v = a.js(&format!("(window.tag = '{t}', 1 + 2)")).await;
    ck(c, "javascript: expression", v == json!(3), &v);
    let v = a.js("Promise.resolve({x: [1, 'y']})").await;
    ck(c, "javascript: promise awaited", v == json!({"x": [1, "y"]}), &v);
    let v = a.js("undefined").await;
    ck(c, "javascript: undefined is null", v == Value::Null, &v);
    let r = a.tool("browser_javascript", json!({"code": "(() => { throw new Error('boom') })()"})).await;
    ck(c, "javascript: exception", !r.ok && r.text.starts_with(PAGE_NOTE) && r.text.contains("boom"), &r.text);
    let v = a.js("var q = 5; q * 2").await;
    ck(c, "javascript: statements", v == json!(10), &v);

    // read_page, refs, passwords
    let r = a.tool("browser_read_page", json!({})).await;
    let text = r.text.clone();
    ck(c, "read_page: tree", r.ok && text.starts_with(PAGE_NOTE) && text.contains("button \"Press me\"") && text.contains("heading \"Selftest page\""), &text);
    ck(c, "read_page: a plain value is shown", text.contains("value=\"plain-visible\""), &text);
    ck(c, "read_page: the password is hidden", !text.contains("hunter2") && text.contains("value=<hidden>"), &text);
    let btn = ref_of(&text, "button \"Press me\"").unwrap_or_default();
    let name = ref_of(&text, "textbox \"Name\"").unwrap_or_default();
    let pw = ref_of(&text, "\"Password\"").unwrap_or_default();
    let sel = ref_of(&text, "\"Color\"").unwrap_or_default();
    let cb = ref_of(&text, "checkbox").unwrap_or_default();
    let bottom = ref_of(&text, "button \"Bottom button\"").unwrap_or_default();
    ck(c, "read_page: refs", [&btn, &name, &pw, &sel, &cb, &bottom].iter().all(|r| r.starts_with('e')), &text);
    let r2 = a.tool("browser_read_page", json!({"filter": "interactive"})).await;
    ck(c, "read_page: refs are stable", ref_of(&r2.text, "button \"Press me\"").as_ref() == Some(&btn), &r2.text);
    ck(c, "read_page: interactive drops text", r2.ok && !r2.text.contains("api-done"), &r2.text);
    let r3 = a.tool("browser_read_page", json!({"ref": btn})).await;
    ck(c, "read_page: subtree", r3.ok && r3.text.contains("Press me") && !r3.text.contains("Selftest page"), &r3.text);

    let r = a.tool("browser_find", json!({"query": "press"})).await;
    let hits = r.json();
    let h = &hits[0];
    ck(c, "find: ref, role and box", r.ok && h["ref"] == btn.as_str() && h["role"] == "button" && h["box"]["w"].as_f64().unwrap_or(0.0) > 100.0, &r.text);
    let r = a.tool("browser_find", json!({"query": "password"})).await;
    ck(c, "find: the password is hidden", r.ok && r.text.contains(pw.as_str()) && !r.text.contains("hunter2"), &r.text);

    // trusted clicks
    let r = a.tool("browser_click", json!({"ref": btn})).await;
    ck(c, "click ref", r.ok && r.json()["x"].is_number(), &r.text);
    let (bx, by) = (h["box"]["x"].as_f64().unwrap_or(0.0) + 10.0, h["box"]["y"].as_f64().unwrap_or(0.0) + 10.0);
    let r = a.tool("browser_click", json!({"x": bx, "y": by})).await;
    ck(c, "click x,y", r.ok, &r.text);
    let r = a.tool("browser_click", json!({"ref": btn, "clicks": 2})).await;
    ck(c, "click double", r.ok, &r.text);
    let r = a.tool("browser_click", json!({"ref": btn, "button": "right"})).await;
    ck(c, "click right", r.ok, &r.text);
    let r = a.tool("browser_click", json!({"ref": btn, "button": "middle"})).await;
    ck(c, "click middle", r.ok, &r.text);
    let v = a.js_until("[clicks, dbl, ctx, mid, trusted.filter(x => x.startsWith('click') || x.startsWith('ctx')).every(x => x.endsWith(':true'))]", &json!([4, 1, 1, 1, true])).await;
    ck(c, "clicks reach the page as trusted events (4 clicks, 1 dblclick, 1 contextmenu, 1 middle)", v == json!([4, 1, 1, 1, true]), &v);

    // type
    let r = a.tool("browser_type", json!({"ref": name, "text": "hello"})).await;
    ck(c, "type: result does not echo", r.ok && r.json()["typed_chars"] == 5 && !r.text.contains("hello"), &r.text);
    let v = a.js("[document.getElementById('name').value, trusted.includes('input:true'), document.activeElement.id]").await;
    ck(c, "type: trusted input in the field", v == json!(["hello", true, "name"]), &v);
    let r = a.tool("browser_type", json!({"ref": name, "text": "world", "clear": true})).await;
    let v = a.js("document.getElementById('name').value").await;
    ck(c, "type: clear", r.ok && v == json!("world"), &v);
    let r = a.tool("browser_type", json!({"ref": pw, "text": "typed-secret", "clear": true})).await;
    let v = a.js("document.getElementById('pw').value").await;
    let rp = a.tool("browser_read_page", json!({})).await;
    ck(c, "type: into the password, still hidden", r.ok && v == json!("typed-secret") && !rp.text.contains("typed-secret"), &format!("{v} {}", rp.text));

    // key
    a.tool("browser_click", json!({"ref": name})).await;
    let r = a.tool("browser_key", json!({"keys": "cmd+a Backspace"})).await;
    let v = a.js("document.getElementById('name').value").await;
    ck(c, "key: cmd+a Backspace empties the field", r.ok && r.json()["pressed"] == 2 && v == json!(""), &format!("{} {v}", r.text));
    let r = a.tool("browser_key", json!({"keys": "h i shift+a Enter"})).await;
    let v = a.js("[document.getElementById('name').value, keys.includes('Enter:true'), keys.every(k => k.endsWith(':true'))]").await;
    ck(c, "key: letters and Enter reach the page as trusted keys", r.ok && v == json!(["hiA", true, true]), &format!("{} {v}", r.text));
    let r = a.tool("browser_key", json!({"keys": "Tab"})).await;
    let v = a.js("document.activeElement.id").await;
    ck(c, "key: Tab moves focus", r.ok && v == json!("pw"), &v);
    let r = a.tool("browser_key", json!({"keys": "cmd+v"})).await;
    ck(c, "key: paste is refused", !r.ok && r.text.contains("paste, copy or cut"), &r.text);

    // form_input
    let r = a.tool("browser_form_input", json!({"ref": sel, "value": "Green"})).await;
    let r2 = a.tool("browser_form_input", json!({"ref": cb, "value": true})).await;
    let r3 = a.tool("browser_form_input", json!({"ref": name, "value": "direct"})).await;
    let v = a.js("[document.getElementById('sel').value, document.getElementById('cb').checked, document.getElementById('name').value]").await;
    ck(c, "form_input: select, checkbox, text", r.ok && r2.ok && r3.ok && v == json!(["g", true, "direct"]), &format!("{} | {} | {} | {v}", r.text, r2.text, r3.text));

    // scroll
    let r = a.tool("browser_scroll", json!({"dy": 400})).await;
    let y1 = a.js_until("scrollY > 0", &json!(true)).await;
    ck(c, "scroll: wheel", r.ok && y1 == json!(true), &format!("{} {y1}", r.text));
    let r = a.tool("browser_scroll", json!({"ref": bottom})).await;
    ck(c, "scroll: ref into view", r.ok && r.json()["scrollY"].as_f64().unwrap_or(0.0) > 2000.0, &r.text);

    // screenshot
    let r = a.tool("browser_screenshot", json!({})).await;
    let png = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.decode(r.raw["content"][0]["data"].as_str().unwrap_or("")).unwrap_or_default()
    };
    let size = png_size(&png);
    let vp = a.js("[innerWidth, innerHeight]").await;
    let want = format!("Screenshot {}x{} px", vp[0], vp[1]);
    ck(c, "screenshot: PNG size is the viewport in CSS px", r.ok && size.map(|(w, h)| json!([w, h])) == Some(vp.clone()) && r.text.contains(&want), &format!("{size:?} {vp} {}", r.text));

    // console
    a.js(&format!("console.error('err-{t}'), 1")).await;
    let r = a.tool("browser_console", json!({"pattern": "selftest-console-"})).await;
    let e = r.json();
    ck(c, "console: page log", r.ok && e.to_string().contains(&format!("selftest-console-{t}")) && e[0]["level"] == "log", &r.text);
    let r = a.tool("browser_console", json!({"pattern": format!("err-{t}")})).await;
    ck(c, "console: error level", r.ok && r.json()[0]["level"] == "error", &r.text);
    // network
    let r = a.tool("browser_network", json!({"pattern": "/api"})).await;
    let n = r.json();
    ck(c, "network: fetch with method and status", r.ok && n[0]["method"] == "GET" && n[0]["status"] == 200 && n[0]["type"] == "fetch", &r.text);

    // select_element: no panel holds the lease
    let r = a.tool("browser_select_element", json!({})).await;
    ck(c, "select_element: needs the panel open", !r.ok && r.text.contains("needs the herdr Browser panel open"), &r.text);

    // a new document: earlier refs are gone; back works
    let r = a.tool("browser_navigate", json!({"url": format!("{base}/two")})).await;
    ck(c, "navigate: second page", r.ok && r.json()["title"] == "Two", &r.text);
    let r = a.tool("browser_click", json!({"ref": btn})).await;
    ck(c, "refs from an earlier document are gone", !r.ok && r.text.contains("is gone"), &r.text);
    let r = a.tool("browser_navigate", json!({"action": "back"})).await;
    ck(c, "navigate: back", r.ok && r.json()["url"] == url.as_str(), &r.text);
    let r = a.tool("browser_console", json!({"clear": true})).await;
    let r2 = a.tool("browser_console", json!({"pattern": format!("err-{t}")})).await;
    ck(c, "console: clear", r.ok && r2.ok && !r2.text.contains(&format!("err-{t}")), &r2.text);
}

/// Each terminal sees only its own tabs, pages and console.
async fn isolation(a: &mut Agent, b: &mut Agent, c: &mut Checks) {
    let ia = a.tab_ids().await;
    let ib = b.tab_ids().await;
    c.check("isolation: different tab ids", !ia.is_empty() && !ib.is_empty() && ia.iter().all(|i| !ib.contains(i)), format!("{ia:?} {ib:?}"));
    let other = ib.first().copied().unwrap_or(0);
    let r = a.tool("browser_tabs", json!({"action": "select", "id": other})).await;
    c.check("isolation: select another terminal's tab", !r.ok && r.text.contains(&format!("no tab {other}")), &r.text);
    let r = a.tool("browser_javascript", json!({"code": "1", "tab": other})).await;
    c.check("isolation: use another terminal's tab", !r.ok && r.text.contains(&format!("no tab {other}")), &r.text);
    let r = a.tool("browser_tabs", json!({"action": "close", "id": other})).await;
    c.check("isolation: close another terminal's tab", !r.ok && r.text.contains(&format!("no tab {other}")), &r.text);
    let va = a.js("(window.iso = 'iso-a', console.log('iso-log-a'), window.iso)").await;
    let vb = b.js("window.iso ?? null").await;
    c.check("isolation: each page is its own", va == json!("iso-a") && vb == Value::Null, format!("{va} {vb}"));
    let ra = a.tool("browser_console", json!({"pattern": "iso-log-"})).await;
    let rb = b.tool("browser_console", json!({"pattern": "iso-log-"})).await;
    c.check("isolation: console is per tab", ra.text.contains("iso-log-a") && rb.ok && !rb.text.contains("iso-log-a"), format!("{} | {}", ra.text, rb.text));
}

/// Agents open http, https, about:blank and data: only, in Rust and again in herdr-web.
async fn urls(a: &mut Agent, base: &str, c: &mut Checks) {
    // (Not "ftp://x" or "javascript:x": normalize_url makes them https://ftp://x and
    // https://javascript:x, web URLs that fail to load or to parse.)
    for u in ["file:///etc/hosts", "chrome://settings", "view-source:http://example.com/"] {
        let r = a.tool("browser_navigate", json!({"url": u})).await;
        c.check(&format!("url refused: {u}"), !r.ok && r.text.contains("agents may open http, https, about:blank and data: pages only"), &r.text);
    }
    let r = a.tool("browser_tabs", json!({"action": "new", "url": "file:///etc/hosts"})).await;
    c.check("url refused: tabs new file:", !r.ok && r.text.contains("agents may open"), &r.text);
    let r = a.m.conn.request("navigate", "navigate", &json!({"url": "file:///etc/hosts"})).await;
    c.check("url refused by herdr-web itself", r.as_ref().err().map(|e| e.contains("agents may open")).unwrap_or(false), format!("{r:?}"));
    a.js("location.href = 'file:///etc/hosts', 1").await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let v = a.js("location.href").await;
    c.check("url refused: page navigation to file: stays", v == json!(format!("{base}/?a")), &v);
    let r = a.tool("browser_navigate", json!({"url": "data:text/html,<title>D</title><p>data page</p>"})).await;
    c.check("url allowed: data:", r.ok && r.json()["title"] == "D", &r.text);
    let r = a.tool("browser_navigate", json!({"url": "about:blank"})).await;
    c.check("url allowed: about:blank", r.ok, &r.text);
}

/// javascript runs the code once, whatever the page does to the globals the wrapper uses; and a strict CSP page
/// still takes an `await` expression.
async fn js_once(a: &mut Agent, base: &str, c: &mut Checks) {
    let r = a.tool("browser_navigate", json!({"url": format!("{base}/csp")})).await;
    c.check("javascript: CSP page loads", r.ok && r.json()["title"] == "Csp", &r.text);
    let v = a.js("await Promise.resolve(6 * 7)").await;
    c.check("javascript: await expression on a CSP page", v == json!(42), &v);
    // Installed and removed as statements, which use neither global.
    let v = a.js("window.runs = 0; window.keepJ = JSON.stringify; window.keepS = String; JSON.stringify = function () { throw new Error('trap') }; String = function () { throw new SyntaxError('trap') }; 0").await;
    c.check("javascript: trap installed", v == json!(0), &v);
    let r = a.tool("browser_javascript", json!({"code": "window.runs += 1"})).await;
    let v = a.js("JSON.stringify = window.keepJ; String = window.keepS; window.runs").await;
    c.check("javascript: a page that breaks the wrapper cannot run the code twice", v == json!(1), &format!("runs {v}, reply {}", r.text));
    let v = a.js("1 + 1").await;
    c.check("javascript: expression after the trap", v == json!(2), &v);
}

/// At most 9 tabs; closing the last one leaves a new blank one.
async fn tab_limit(a: &mut Agent, c: &mut Checks) {
    let start = a.tab_ids().await;
    let mut ok = true;
    for _ in start.len()..9 {
        ok &= a.tool("browser_tabs", json!({"action": "new"})).await.ok;
    }
    let ids = a.tab_ids().await;
    c.check("tabs: open up to 9", ok && ids.len() == 9, format!("{ids:?}"));
    if ids.is_empty() {
        return;
    }
    let r = a.tool("browser_tabs", json!({"action": "new"})).await;
    c.check("tabs: the 10th is refused", !r.ok && r.text.contains("At most 9 tabs"), &r.text);
    let r = a.tool("browser_tabs", json!({"action": "select", "id": ids[0]})).await;
    let act: Vec<i64> = r.json().as_array().into_iter().flatten().filter(|t| t["active"] == true).filter_map(|t| t["id"].as_i64()).collect();
    c.check("tabs: select", r.ok && act == vec![ids[0]], &r.text);
    for _ in 0..9 {
        a.tool("browser_tabs", json!({"action": "close"})).await;
    }
    let left = a.tab_ids().await;
    c.check("tabs: closing the last leaves one new blank tab", left.len() == 1 && !ids.contains(&left[0]), format!("{left:?} after {ids:?}"));
}

/// With a panel holding the lease and showing the user's tabs, an agent cannot pick.
async fn select_shown(home: &Path, a: &mut Agent, b: &mut Agent, c: &mut Checks) {
    let mut p = match crate::native::find(home, &json!({"op": "hello", "v": 2, "role": "panel"}), None).await {
        Ok(p) => p,
        Err(e) => return c.check("select_element: panel connects", false, e),
    };
    // Select on in an agent tab (not shown, so no pick can reach the pasteboard): that agent's click and key wait.
    let tab = a.tab_ids().await.first().copied().unwrap_or(0);
    let _ = a.tool("browser_navigate", json!({"url": "about:blank", "tab": tab})).await; // loaded: a later commit would end the pick
    let _ = p.send(&json!({"op": "pick", "on": true, "id": format!("a{tab}")})).await;
    tokio::time::sleep(Duration::from_millis(200)).await; // another connection: let the pick land first
    let r = a.tool("browser_click", json!({"x": 5, "y": 5, "tab": tab})).await;
    let r2 = a.tool("browser_key", json!({"keys": "Escape", "tab": tab})).await;
    let refused = |r: &Res| !r.ok && r.text.contains("the user is selecting an element in this tab");
    c.check("[a] click and key are refused while Select is on in the tab", refused(&r) && refused(&r2), &format!("{} | {}", r.text, r2.text));
    let _ = p.send(&json!({"op": "pick", "on": false, "id": format!("a{tab}")})).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let r = a.tool("browser_click", json!({"x": 5, "y": 5, "tab": tab})).await;
    c.check("[a] click works once Select is off", r.ok, &r.text);
    for ag in [a, b] {
        let _ = p.send(&json!({"op": "lease"})).await;
        let r = ag.tool("browser_select_element", json!({})).await;
        c.check(
            &format!("[{}] select_element: refused while the panel shows another group", ag.tag),
            !r.ok && r.text.contains("it shows another browser now"),
            &r.text,
        );
    }
    let _ = p.send(&json!({"op": "hide"})).await;
}

#[cfg(test)]
mod tests {
    #[test]
    fn ref_of_finds_the_first_matching_line() {
        let t = "[note]\n- RootWebArea \"S\" [ref=e1]\n  - button \"Press me\" [ref=e12] (focused)\n  - button \"Press me too\" [ref=e13]\n";
        assert_eq!(super::ref_of(t, "button \"Press me\"").as_deref(), Some("e12"));
        assert_eq!(super::ref_of(t, "textbox"), None);
    }
}
