//! `--bench`: frames/s and CPU of the helper and its Chrome on an animated page, idle and under
//! input, plus input-to-frame latency. Prints one JSON object. Uses a temp app home and a fake
//! panel over the real WebSocket (hello 735x1008 scale 2, as measured live).

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use crate::engine::{trace, Cmd, Config, Probe};
use crate::selftest::headless_from_env;

/// A page that repaints every frame (like an animated streak screen): moving gradient, spinning
/// rings, pulsing bars. A click sets a new background colour and records when it ran.
const ANIM: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>bench-anim</title><style>
body{margin:0;height:100vh;overflow:hidden;font:16px system-ui;background:#123}
.g{position:absolute;inset:0 0 50% 0;background:linear-gradient(90deg,#f80,#08f,#0f8,#f80);background-size:300% 100%;animation:g 3s linear infinite}
@keyframes g{to{background-position:300% 0}}
.r{position:absolute;width:160px;height:160px;border:14px solid #fff;border-top-color:#f0a;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
.b{position:absolute;bottom:40px;width:40px;background:#fd0;animation:p .8s ease-in-out infinite alternate}
@keyframes p{from{height:40px}to{height:300px}}
</style></head><body>
<div class=g></div>
<div class=r style="left:60px;top:560px"></div><div class=r style="left:300px;top:600px;animation-duration:1.4s"></div><div class=r style="left:520px;top:540px;animation-duration:.7s"></div>
<div class=b style="left:80px"></div><div class=b style="left:180px;animation-delay:.2s"></div><div class=b style="left:280px;animation-delay:.4s"></div><div class=b style="left:380px;animation-delay:.6s"></div><div class=b style="left:480px;animation-delay:.1s"></div><div class=b style="left:580px;animation-delay:.3s"></div>
<script>document.addEventListener('mousedown',()=>{document.body.style.background='#'+Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0');window.clickedAt=Date.now();window.clicks=(window.clicks||0)+1});</script>
</body></html>"#;

const STATIC: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>bench-static</title></head>
<body style="margin:0;height:100vh;background:#eee"><h1>static</h1>
<script>document.addEventListener('mousedown',()=>{document.body.style.background='#'+Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0');window.clickedAt=Date.now()});</script>
</body></html>"#;

/// A long page to scroll: many text rows.
const LONG: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>bench-long</title><style>
body{margin:0;font:16px system-ui;background:#fafafa}.row{height:48px;border-bottom:1px solid #ddd;padding:12px}
</style></head><body><script>for(let i=0;i<800;i++){const d=document.createElement('div');d.className='row';d.textContent='Row '+i+' lorem ipsum dolor sit amet';document.body.appendChild(d)}</script></body></html>"#;

/// A heavier long page: gradient cards with shadows and dense text (more paint and JPEG cost).
const HEAVY: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>bench-heavy</title><style>
body{margin:0;font:15px/1.45 Georgia,serif;background:linear-gradient(#f4efe6,#dfe8f4)}
.c{margin:10px 14px;padding:14px 16px;border-radius:10px;box-shadow:0 3px 10px rgba(0,0,0,.25);background:linear-gradient(135deg,hsl(var(--h),70%,86%),#fff 70%)}
.c h3{margin:0 0 6px;font:600 18px system-ui}.c p{margin:0;color:#333}
</style></head><body><script>const w='lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
for(let i=0;i<400;i++){const d=document.createElement('div');d.className='c';d.style.setProperty('--h',(i*37)%360);let t='';for(let j=0;j<60;j++)t+=w[(i*7+j*3)%w.length]+' ';d.innerHTML='<h3>Card '+i+'</h3><p>'+t+'</p>';document.body.appendChild(d)}</script></body></html>"#;

const WINDOW: Duration = Duration::from_secs(6);
const SETTLE: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Rx {
    /// (received at, Chrome draw time ms since epoch)
    frames: Vec<(Instant, f64)>,
    /// seq → when the fake panel got the frame message (ms since the epoch).
    arr: std::collections::HashMap<u64, f64>,
    state: Option<Value>,
}

/// "M:SS.ss" or "H:MM:SS.ss" from `ps -o time=` → seconds.
pub(crate) fn parse_cputime(s: &str) -> Option<f64> {
    let mut total = 0.0;
    for part in s.trim().split(':') {
        total = total * 60.0 + part.trim().parse::<f64>().ok()?;
    }
    Some(total)
}

/// Every process: pid → (ppid, cpu seconds so far, %cpu, Chrome process type).
fn ps_all() -> Vec<(i32, i32, f64, f64, String)> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-axww", "-o", "pid=,ppid=,time=,%cpu=,command="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 5 {
                return None;
            }
            let ty = f[5..].iter().find_map(|a| a.strip_prefix("--type=")).unwrap_or("browser").to_string();
            Some((f[0].parse().ok()?, f[1].parse().ok()?, parse_cputime(f[2])?, f[3].replace(',', ".").parse().ok()?, ty))
        })
        .collect()
}

/// The Chrome root and all its descendants: (cpu seconds, %cpu) summed.
fn chrome_cpu(root: i32) -> (f64, f64) {
    let t = chrome_by_type(root);
    t.iter().fold((0.0, 0.0), |a, (_, c, p)| (a.0 + c, a.1 + p))
}

/// Per Chrome process type (browser, renderer, gpu-process, utility): (type, cpu s, %cpu).
fn chrome_by_type(root: i32) -> Vec<(String, f64, f64)> {
    let all = ps_all();
    let mut set = vec![root];
    loop {
        let more: Vec<i32> = all.iter().filter(|p| set.contains(&p.1) && !set.contains(&p.0)).map(|p| p.0).collect();
        if more.is_empty() {
            break;
        }
        set.extend(more);
    }
    let mut out: Vec<(String, f64, f64)> = Vec::new();
    for p in all.iter().filter(|p| set.contains(&p.0)) {
        match out.iter_mut().find(|o| o.0 == p.4) {
            Some(o) => {
                o.1 += p.2;
                o.2 += p.3;
            }
            None => out.push((p.4.clone(), p.2, p.3)),
        }
    }
    out
}

fn self_cpu() -> f64 {
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    let t = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1e6;
    t(u.ru_utime) + t(u.ru_stime)
}

struct Bench {
    rx: Arc<Mutex<Rx>>,
    sink: futures::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    cmd: tokio::sync::mpsc::UnboundedSender<Cmd>,
    chrome: i32,
}

impl Bench {
    async fn send(&mut self, v: Value) {
        let _ = self.sink.send(Message::text(v.to_string())).await;
    }

    fn frames(&self) -> usize {
        self.rx.lock().unwrap().frames.len()
    }

    /// Frames Chrome has sent so far (Stats.frames_received).
    async fn received(&self) -> u64 {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = self.cmd.send(Cmd::Probe(Probe::Stats { reply: tx }));
        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(st)) => st.frames_received,
            _ => 0,
        }
    }

    async fn eval(&self, expr: &str) -> Value {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = self.cmd.send(Cmd::Probe(Probe::Eval { expr: expr.into(), reply: tx }));
        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(Ok(v))) => v,
            _ => Value::Null,
        }
    }

    /// One measuring window; `input` sends a mouse move every 50 ms.
    async fn window(&mut self, name: &str, input: bool) -> Value {
        tokio::time::sleep(SETTLE).await;
        let f0 = self.frames();
        let r0 = self.received().await;
        let by0 = chrome_by_type(self.chrome);
        let (c0, h0, t0) = (chrome_cpu(self.chrome).0, self_cpu(), Instant::now());
        let mut pct = Vec::new();
        let mut next_sample = t0 + Duration::from_millis(500);
        let mut i = 0u32;
        while t0.elapsed() < WINDOW {
            if input {
                let x = 200.0 + (i % 20) as f64 * 10.0;
                self.send(json!({"t":"mouse","type":"move","x":x,"y":300.0})).await;
                i += 1;
            }
            if Instant::now() >= next_sample {
                pct.push(chrome_cpu(self.chrome).1);
                next_sample += Duration::from_millis(500);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let secs = t0.elapsed().as_secs_f64();
        let fps = (self.frames() - f0) as f64 / secs;
        let recv = (self.received().await - r0) as f64 / secs;
        let chrome = (chrome_cpu(self.chrome).0 - c0) / secs * 100.0;
        let helper = (self_cpu() - h0) / secs * 100.0;
        let by: serde_json::Map<String, Value> = chrome_by_type(self.chrome)
            .into_iter()
            .map(|(ty, c, _)| {
                let c0 = by0.iter().find(|b| b.0 == ty).map(|b| b.1).unwrap_or(0.0);
                (ty, json!(r1((c - c0) / secs * 100.0)))
            })
            .collect();
        let avg_pct = if pct.is_empty() { 0.0 } else { pct.iter().sum::<f64>() / pct.len() as f64 };
        json!({"phase": name, "fps": r1(fps), "chrome_fps": r1(recv), "chrome_cpu": r1(chrome), "chrome_cpu_ps_avg": r1(avg_pct), "helper_cpu": r1(helper), "chrome_by_type": by})
    }

    /// Median over `n` clicks spaced 2 s apart (each starts from idle): ms from the click to
    /// (a) the first frame received after it and (b) the first frame drawn after the page ran
    /// the click handler (the change is visible).
    async fn latency(&mut self, n: usize) -> Value {
        let mut first = Vec::new();
        let mut shown = Vec::new();
        for k in 0..n {
            tokio::time::sleep(SETTLE).await;
            let before = self.frames();
            let x = 300.0 + k as f64;
            self.send(json!({"t":"mouse","type":"move","x":x,"y":200.0})).await;
            let sent = Instant::now();
            self.send(json!({"t":"mouse","type":"down","x":x,"y":200.0,"button":"left","clicks":1})).await;
            self.send(json!({"t":"mouse","type":"up","x":x,"y":200.0,"button":"left","clicks":1})).await;
            let end = sent + Duration::from_secs(3);
            let mut clicked: Option<f64> = None;
            let mut got_first = None;
            let mut got_shown = None;
            while Instant::now() < end && (got_first.is_none() || got_shown.is_none()) {
                if clicked.is_none() {
                    clicked = self.eval("window.clickedAt||null").await.as_f64();
                }
                {
                    let rx = self.rx.lock().unwrap();
                    if got_first.is_none() {
                        got_first = rx.frames.get(before).map(|f| f.0.duration_since(sent).as_secs_f64() * 1000.0);
                    }
                    if let (None, Some(c)) = (got_shown, clicked) {
                        got_shown = rx.frames[before..].iter().find(|f| f.1 >= c).map(|f| f.0.duration_since(sent).as_secs_f64() * 1000.0);
                    }
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            let _ = self.eval("window.clickedAt=null").await;
            first.extend(got_first);
            shown.extend(got_shown);
        }
        json!({"clicks": n, "first_frame_ms": median(&mut first), "change_visible_ms": median(&mut shown), "missed": n - shown.len()})
    }

    /// A trackpad-like flick: one wheel event every 8 ms (120 Hz, macOS trackpad rate), 8 px
    /// each, for 1 s (1000 px). Reports frames/s during the flick, how far the page lags behind
    /// the wheel when the flick ends, and how long after the last wheel event the page settles.
    async fn scroll(&mut self, runs: usize) -> Value {
        let mut fps = Vec::new();
        let mut behind = Vec::new();
        let mut settle = Vec::new();
        for k in 0..runs {
            let _ = self.eval("window.scrollTo(0,0),0").await;
            tokio::time::sleep(SETTLE).await;
            let f0 = self.frames();
            let t0 = Instant::now();
            let n = 125;
            for i in 0..n {
                self.send(json!({"t":"mouse","type":"wheel","x":300.0,"y":400.0,"dx":0.0,"dy":8.0})).await;
                let next = t0 + Duration::from_millis(8 * (i + 1) as u64);
                if let Some(d) = next.checked_duration_since(Instant::now()) {
                    tokio::time::sleep(d).await;
                }
            }
            let sent_end = Instant::now();
            let flick = sent_end.duration_since(t0).as_secs_f64();
            let y_end = self.eval("scrollY").await.as_f64().unwrap_or(0.0);
            fps.push((self.frames() - f0) as f64 / flick);
            behind.push(1000.0 - y_end);
            let end = sent_end + Duration::from_secs(5);
            let mut done = None;
            while Instant::now() < end {
                let y = self.eval("scrollY").await.as_f64().unwrap_or(0.0);
                if y >= 999.0 {
                    done = Some(sent_end.elapsed().as_secs_f64() * 1000.0);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            settle.push(done.unwrap_or(5000.0));
            eprintln!("scroll run {k}: fps {:.1} behind {:.0}px settle {:?}", fps[k], behind[k], done);
        }
        json!({"runs": runs, "fps": median(&mut fps), "px_behind_at_end": median(&mut behind), "settle_ms": median(&mut settle)})
    }

    /// Mouse-notch scrolling as measured live: wheel events of dy 80 in bursts of 3-5 notches
    /// 11-18 ms apart, about 12 notches a second ("burst"), then single notches 2.5 s apart that
    /// each start from idle ack pacing ("single"). Every frame's scroll position comes from
    /// Chrome's screencast metadata (scrollOffsetY). See `analyze` for the numbers.
    async fn notch(&mut self, runs: usize) -> Value {
        trace::enable();
        let mut out = serde_json::Map::new();
        for name in ["burst", "single"] {
            let mut per: Vec<serde_json::Map<String, Value>> = Vec::new();
            for k in 0..runs {
                let plan = if name == "burst" { burst_plan() } else { single_plan() };
                let _ = self.eval("window.scrollTo(0,0),0").await;
                tokio::time::sleep(SETTLE).await;
                let _ = trace::take();
                let t0 = Instant::now();
                let mut sent: Vec<(f64, usize)> = Vec::new();
                for (at_ms, burst) in &plan {
                    let at = t0 + Duration::from_millis(*at_ms);
                    if let Some(d) = at.checked_duration_since(Instant::now()) {
                        tokio::time::sleep(d).await;
                    }
                    sent.push((trace::now_ms(), *burst));
                    self.send(json!({"t":"mouse","type":"wheel","x":300.0,"y":400.0,"dx":0.0,"dy":NOTCH})).await;
                }
                tokio::time::sleep(Duration::from_millis(1500)).await;
                let y_end = self.eval("scrollY").await.as_f64().unwrap_or(-1.0);
                let (frames, wheels) = trace::take();
                let arr = self.rx.lock().unwrap().arr.clone();
                if let Ok(dir) = std::env::var("HERDR_BROWSER_BENCH_DUMP") {
                    // Raw trace per run, for offline metrics: frames [seq, chrome ts, helper rx,
                    // write start, write end, scrollY, panel arrival], wheels [sent, answered, dy],
                    // notches [sent, burst].
                    let fr: Vec<Value> = frames.iter().map(|f| json!([f.seq, f.ts, f.rx, f.w0, f.w1, if f.sy.is_finite() { json!(f.sy) } else { Value::Null }, arr.get(&f.seq)])).collect();
                    let wh: Vec<Value> = wheels.iter().map(|w| json!([w.t0, w.t1, w.dy])).collect();
                    let dump = json!({"variant": variant_env(), "frames": fr, "wheels": wh, "notches": sent});
                    let _ = std::fs::write(std::path::Path::new(&dir).join(format!("{name}-{k}.json")), dump.to_string());
                }
                let mut m = analyze(&frames, &wheels, &arr, &sent);
                let last_sy = frames.iter().rev().find(|f| f.sy.is_finite()).map(|f| f.sy).unwrap_or(-1.0);
                m.insert("scrolly_end".into(), json!(r1(y_end)));
                m.insert("last_frame_sy".into(), json!(r1(last_sy)));
                m.insert("target_end".into(), json!(NOTCH * sent.len() as f64));
                eprintln!("notch {name} run {k}: {}", Value::Object(m.clone()));
                per.push(m);
            }
            out.insert(name.into(), aggregate(&per));
        }
        Value::Object(out)
    }

    async fn navigate(&mut self, html: &str, title: &str) -> bool {
        let url = format!("data:text/html;charset=utf-8,{}", crate::proto::pct_encode(html));
        self.send(json!({"t":"navigate","url":url})).await;
        let end = Instant::now() + Duration::from_secs(15);
        while Instant::now() < end {
            if self.eval("document.title").await == json!(title) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn median(v: &mut [f64]) -> Value {
    if v.is_empty() {
        return Value::Null;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    json!(r1(v[v.len() / 2]))
}

pub async fn run(chrome: PathBuf) -> ExitCode {
    let tmp = std::env::temp_dir().join(format!("herdr-browser-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let mut cfg = Config::for_test(&tmp, chrome, headless_from_env());
    if let Some(s) = std::env::var("HERDR_BROWSER_BENCH_FREEZE_MS").ok().and_then(|s| s.parse().ok()) {
        cfg.freeze_after = Duration::from_millis(s);
    }
    let code = match bench(cfg).await {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("bench: {e}");
            ExitCode::FAILURE
        }
    };
    let _ = std::fs::remove_dir_all(&tmp);
    code
}

async fn bench(cfg: Config) -> Result<Value, String> {
    let h = crate::server::start(cfg, false).await.map_err(|e| e.to_string())?;
    let url = format!("ws://127.0.0.1:{}/?token={}", h.port, h.token);
    let (ws, _) = tokio::time::timeout(Duration::from_secs(5), tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| "connect timed out")?
        .map_err(|e| e.to_string())?;
    let (sink, mut source) = ws.split();
    let rx = Arc::new(Mutex::new(Rx::default()));
    let r2 = rx.clone();
    tokio::spawn(async move {
        while let Some(Ok(Message::Text(t))) = source.next().await {
            let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
            let mut g = r2.lock().unwrap();
            match v["t"].as_str() {
                Some("frame") => {
                    g.frames.push((Instant::now(), v["ts"].as_f64().unwrap_or(0.0)));
                    if let Some(seq) = v["seq"].as_u64() {
                        g.arr.insert(seq, trace::now_ms());
                    }
                }
                Some("state") => g.state = Some(v),
                _ => {}
            }
        }
    });
    let mut b = Bench { rx, sink, cmd: h.cmd_tx.clone(), chrome: 0 };
    b.send(json!({"t":"hello","w":735,"h":1008,"scale":2})).await;
    let end = Instant::now() + Duration::from_secs(30);
    let pid = loop {
        let (tx, r) = tokio::sync::oneshot::channel();
        let _ = h.cmd_tx.send(Cmd::Probe(Probe::Stats { reply: tx }));
        let up = b.rx.lock().unwrap().state.as_ref().map(|s| s["connected"] == true).unwrap_or(false);
        if let (true, Ok(Ok(st))) = (up, tokio::time::timeout(Duration::from_secs(5), r).await) {
            if let Some(p) = st.chrome_pid {
                break p as i32;
            }
        }
        if Instant::now() >= end {
            return Err("Chrome did not come up".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    b.chrome = pid;
    let mut out = Vec::new();
    if std::env::var("HERDR_BROWSER_BENCH_ONLY").as_deref() == Ok("notch") {
        let heavy = std::env::var("HERDR_BROWSER_BENCH_PAGE").as_deref() == Ok("heavy");
        let (html, title) = if heavy { (HEAVY, "bench-heavy") } else { (LONG, "bench-long") };
        let runs = std::env::var("HERDR_BROWSER_BENCH_RUNS").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
        let r = if b.navigate(html, title).await { Ok(b.notch(runs).await) } else { Err("page did not load".to_string()) };
        let _ = h.cmd_tx.send(Cmd::Shutdown);
        let _ = tokio::time::timeout(Duration::from_secs(10), h.done).await;
        return r.map(|s| json!({"page": title, "view": "735x1008@2", "env": variant_env(), "notch": s}));
    }
    if std::env::var("HERDR_BROWSER_BENCH_ONLY").as_deref() == Ok("scroll") {
        let r = if b.navigate(LONG, "bench-long").await { Ok(b.scroll(5).await) } else { Err("long page did not load".to_string()) };
        let _ = h.cmd_tx.send(Cmd::Shutdown);
        let _ = tokio::time::timeout(Duration::from_secs(10), h.done).await;
        return r.map(|s| json!({"scroll": s}));
    }
    let result = async {
        if !b.navigate(ANIM, "bench-anim").await {
            return Err("animated page did not load".to_string());
        }
        out.push(b.window("anim_idle", false).await);
        out.push(b.window("anim_active", true).await);
        let lat = b.latency(10).await;
        if !b.navigate(STATIC, "bench-static").await {
            return Err("static page did not load".to_string());
        }
        out.push(b.window("static_idle", false).await);
        let lat_static = b.latency(5).await;
        if !b.navigate(ANIM, "bench-anim").await {
            return Err("animated page did not reload".to_string());
        }
        b.send(json!({"t":"visible","on":false})).await;
        out.push(b.window("anim_hidden", false).await);
        let (tx, r) = tokio::sync::oneshot::channel();
        let _ = b.cmd.send(Cmd::Probe(Probe::Stats { reply: tx }));
        if let Ok(Ok(st)) = tokio::time::timeout(Duration::from_secs(5), r).await {
            out.push(json!({"phase": "totals", "received": st.frames_received, "acked": st.frames_acked, "written": st.frames_written, "dropped": st.frames_dropped}));
        }
        b.send(json!({"t":"visible","on":true})).await;
        Ok((lat, lat_static))
    }
    .await;
    let _ = h.cmd_tx.send(Cmd::Shutdown);
    let _ = tokio::time::timeout(Duration::from_secs(10), h.done).await;
    let (lat, lat_static) = result?;
    Ok(json!({"view": "735x1008@2", "window_s": WINDOW.as_secs(), "phases": out, "latency_anim": lat, "latency_static": lat_static}))
}

/// One mouse-wheel notch, px (the live panel sends about 80 per notch).
const NOTCH: f64 = 80.0;

/// (ms after start, burst index): 18 bursts of 3-5 notches, 11-18 ms apart inside a burst,
/// paced so the whole run averages 12 notches a second.
fn burst_plan() -> Vec<(u64, usize)> {
    const SIZES: [u64; 7] = [4, 3, 5, 4, 3, 5, 4];
    const GAPS: [u64; 7] = [15, 12, 18, 14, 16, 11, 17];
    let mut plan = Vec::new();
    let mut t = 0u64;
    let mut g = 0;
    for b in 0..18 {
        let n = SIZES[b % SIZES.len()];
        let start = t;
        for i in 0..n {
            plan.push((t, b));
            if i + 1 < n {
                t += GAPS[g % GAPS.len()];
                g += 1;
            }
        }
        t = start + n * 1000 / 12;
    }
    plan
}

/// Single notches 2.5 s apart: each starts after the cast went back to idle pacing.
fn single_plan() -> Vec<(u64, usize)> {
    (0..6).map(|i| (i as u64 * 2500, i)).collect()
}

/// The bench-variant knobs in effect (so every result says what it measured).
fn variant_env() -> Value {
    let keys = ["HERDR_BROWSER_CHROME_ARGS", "HERDR_BROWSER_WHEEL_SMOOTH_MS", "HERDR_BROWSER_WHEEL_SMOOTH_MIN", "HERDR_BROWSER_WHEEL_SMOOTH_TICK", "HERDR_BROWSER_WHEEL_SMOOTH_POW", "HERDR_BROWSER_JPEG_QUALITY", "HERDR_BROWSER_CAST_SCALE", "HERDR_BROWSER_EVERY_NTH", "HERDR_BROWSER_HEADLESS"];
    Value::Object(keys.iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.trim_start_matches("HERDR_BROWSER_").to_lowercase(), json!(v)))).collect())
}

/// (median, p90, max) of `v`; zeros when empty.
fn spread(v: &[f64]) -> (f64, f64, f64) {
    if v.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| s[((s.len() - 1) as f64 * q).round() as usize];
    (at(0.5), at(0.9), s[s.len() - 1])
}

fn mean_sd(v: &[f64]) -> (f64, f64) {
    if v.is_empty() {
        return (0.0, 0.0);
    }
    let m = v.iter().sum::<f64>() / v.len() as f64;
    (m, (v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len() as f64).sqrt())
}

/// Per run, from the helper's frame trace, the fake panel's arrival times and the notches sent.
/// A burst's motion runs from the first frame that moved after its first notch to the first
/// frame at its target (80 px x all notches so far). Inside motions:
/// - chrome_iv / arrive_iv: ms between frames by Chrome's swap time / by panel arrival
/// - px_frame: px moved per frame; zero_mid / back: frames that did not move / moved up
/// - vsync_*: the panel's view sampled every 16.7 ms (latest arrived frame): px per vsync, its
///   stddev and CV, stalls (a vsync with no movement before the target is reached) and jerk
///   (|change of px per vsync| between neighbouring vsyncs: low for a steady or easing glide,
///   high for jumps and stops)
/// - lag_px: target minus shown position at each vsync
/// first_move_ms: first notch sent → first moved frame at the panel (only from rest);
/// settle_ms: last notch sent → frame at target; unsettled: bursts whose target was not reached
/// before the next burst began. Costs per frame: cdp (Chrome swap → helper), queue (helper got
/// it → write starts), write (base64 decode + file), socket (written → panel), e2e (swap → panel).
fn analyze(frames: &[trace::FrameT], wheels: &[trace::WheelT], arr: &std::collections::HashMap<u64, f64>, sent: &[(f64, usize)]) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    let mut put = |k: &str, v: f64| {
        m.insert(k.into(), json!(r1(v)));
    };
    // (chrome ts, arrival, sy) for frames the panel got, in order.
    let mut fr: Vec<(f64, f64, f64)> = frames.iter().filter_map(|f| arr.get(&f.seq).map(|a| (f.ts, *a, f.sy))).filter(|f| f.2.is_finite()).collect();
    fr.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    let nb = sent.iter().map(|s| s.1).max().map(|b| b + 1).unwrap_or(0);
    let (mut civ, mut aiv, mut pxf, mut vstep, mut lag, mut first, mut settle, mut anim) = (vec![], vec![], vec![], vec![], vec![], vec![], vec![], vec![]);
    let mut jerk: Vec<f64> = vec![];
    let (mut zero_mid, mut back, mut stalls, mut unsettled, mut motion_ms, mut motion_frames) = (0, 0, 0, 0, 0.0, 0usize);
    let tol = 0.75;
    for b in 0..nb {
        let ns: Vec<f64> = sent.iter().filter(|s| s.1 == b).map(|s| s.0).collect();
        let (t_first, t_last) = (ns[0], ns[ns.len() - 1]);
        let before = sent.iter().filter(|s| s.1 < b).count() as f64 * NOTCH;
        let target = before + ns.len() as f64 * NOTCH;
        let next_start = sent.iter().find(|s| s.1 == b + 1).map(|s| s.0).unwrap_or(f64::INFINITY);
        let at_rest = fr.iter().rev().find(|f| f.1 <= t_first).map(|f| (f.2 - before).abs() < tol).unwrap_or(before == 0.0);
        let Some(i0) = fr.iter().position(|f| f.1 >= t_first && f.2 > before + tol) else { continue };
        if at_rest {
            first.push(fr[i0].1 - t_first);
        }
        let i1 = fr.iter().position(|f| f.1 >= t_first && f.2 >= target - tol);
        let i1 = match i1 {
            Some(i) if fr[i].1 < next_start => i,
            _ => {
                unsettled += 1;
                continue;
            }
        };
        settle.push(fr[i1].1 - t_last);
        anim.push(fr[i1].1 - fr[i0].1);
        // px from the frame before the motion (at rest) on; intervals only inside the motion.
        let seg = &fr[i0.saturating_sub(1)..=i1];
        for (j, w) in seg.windows(2).enumerate() {
            if j > 0 || i0 == 0 {
                civ.push(w[1].0 - w[0].0);
                aiv.push(w[1].1 - w[0].1);
            }
            let d = w[1].2 - w[0].2;
            pxf.push(d);
            if d.abs() < 0.25 {
                zero_mid += 1;
            } else if d < 0.0 {
                back += 1;
            }
        }
        motion_frames += i1 - i0;
        let (a0, a1) = (fr[i0].1, fr[i1].1);
        motion_ms += a1 - a0;
        let shown = |t: f64| fr.iter().rev().find(|f| f.1 <= t).map(|f| f.2).unwrap_or(0.0);
        let sent_by = |t: f64| sent.iter().filter(|s| s.0 <= t).count() as f64 * NOTCH;
        // Half a vsync out of phase with the first moved frame (a real display's phase is
        // arbitrary; in phase, arrival jitter of a fraction of a ms flips samples), up to the
        // first vsync that shows the target.
        let mut t = a0 - 8.333;
        let mut prev = shown(t);
        let mut prev_d: Option<f64> = None;
        while t < a1 {
            t += 16.667;
            let y = shown(t);
            let d = y - prev;
            vstep.push(d);
            if let Some(p) = prev_d {
                jerk.push((d - p).abs());
            }
            prev_d = Some(d);
            if d.abs() < 0.25 && y < target - tol {
                stalls += 1;
            }
            lag.push(sent_by(t) - y);
            prev = y;
        }
    }
    // The whole gesture, pauses included (first notch → first frame at the final target),
    // sampled per vsync: stop-and-go shows as still vsyncs between moving ones and as jerk.
    if let (Some(s0), Some(end)) = (sent.first(), fr.iter().find(|f| f.2 >= sent.len() as f64 * NOTCH - tol)) {
        let shown = |t: f64| fr.iter().rev().find(|f| f.1 <= t).map(|f| f.2).unwrap_or(0.0);
        let (mut t, mut prev, mut prev_d) = (s0.0 + 8.333, shown(s0.0 + 8.333), None::<f64>);
        let (mut still, mut n, mut jk) = (0usize, 0usize, Vec::new());
        while t < end.1 {
            t += 16.667;
            let y = shown(t);
            let d = y - prev;
            n += 1;
            if d.abs() < 0.25 {
                still += 1;
            }
            if let Some(p) = prev_d {
                jk.push((d - p).abs());
            }
            prev_d = Some(d);
            prev = y;
        }
        put("run_still_pct", if n > 0 { still as f64 * 100.0 / n as f64 } else { 0.0 });
        put("run_jerk_mean", mean_sd(&jk).0);
        put("run_jerk_p90", spread(&jk).1);
        put("run_ms", end.1 - s0.0);
    }
    put("notches", sent.len() as f64);
    put("wheel_events", wheels.len() as f64);
    let wr: Vec<f64> = wheels.iter().map(|w| w.t1 - w.t0).collect();
    put("wheel_dy_mean", mean_sd(&wheels.iter().map(|w| w.dy.abs()).collect::<Vec<_>>()).0);
    put("wheel_rtt_med", spread(&wr).0);
    put("wheel_rtt_p90", spread(&wr).1);
    put("frames", frames.len() as f64);
    put("motion_fps", if motion_ms > 0.0 { motion_frames as f64 / motion_ms * 1000.0 } else { 0.0 });
    for (k, v) in [("chrome_iv", &civ), ("arrive_iv", &aiv)] {
        let (a, b, c) = spread(v);
        put(&format!("{k}_med"), a);
        put(&format!("{k}_p90"), b);
        put(&format!("{k}_max"), c);
        put(&format!("{k}_gt40"), v.iter().filter(|x| **x > 40.0).count() as f64);
    }
    for (k, v) in [("first_move_ms", &first), ("settle_ms", &settle), ("anim_ms", &anim)] {
        let (a, b, c) = spread(v);
        put(&format!("{k}_med"), a);
        put(&format!("{k}_p90"), b);
        put(&format!("{k}_max"), c);
    }
    put("unsettled", unsettled as f64);
    let (pm, ps) = mean_sd(&pxf);
    put("px_frame_mean", pm);
    put("px_frame_sd", ps);
    put("px_frame_max", spread(&pxf).2);
    put("zero_mid", zero_mid as f64);
    put("back", back as f64);
    let (vm, vs) = mean_sd(&vstep);
    put("vsync_px_mean", vm);
    put("vsync_px_sd", vs);
    put("vsync_cv", if vm > 0.0 { vs / vm } else { 0.0 });
    put("vsync_stalls", stalls as f64);
    put("vsync_px_max", spread(&vstep).2);
    put("vsync_jerk_mean", mean_sd(&jerk).0);
    put("vsync_jerk_p90", spread(&jerk).1);
    put("lag_px_med", spread(&lag).0);
    put("lag_px_max", spread(&lag).2);
    let cost = |f: &dyn Fn(&trace::FrameT) -> Option<f64>| -> Vec<f64> { frames.iter().filter_map(f).collect() };
    let cdp = cost(&|f| (f.ts > 0.0 && f.sy.is_finite()).then(|| f.rx - f.ts));
    let queue = cost(&|f| Some(f.w0 - f.rx));
    let write = cost(&|f| Some(f.w1 - f.w0));
    let sock = cost(&|f| arr.get(&f.seq).map(|a| a - f.w1));
    let e2e = cost(&|f| (f.ts > 0.0 && f.sy.is_finite()).then(|| arr.get(&f.seq).map(|a| a - f.ts)).flatten());
    for (k, v) in [("cdp_ms", &cdp), ("queue_ms", &queue), ("write_ms", &write), ("socket_ms", &sock), ("e2e_ms", &e2e)] {
        let (a, b, c) = spread(v);
        put(&format!("{k}_med"), a);
        put(&format!("{k}_p90"), b);
        put(&format!("{k}_max"), c);
    }
    let bytes: Vec<f64> = frames.iter().map(|f| f.bytes as f64 * 0.75 / 1024.0).collect();
    put("jpeg_kb_med", spread(&bytes).0);
    m
}

/// Runs → {metric: [median, min, max]}.
fn aggregate(per: &[serde_json::Map<String, Value>]) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(first) = per.first() {
        for k in first.keys() {
            let v: Vec<f64> = per.iter().filter_map(|m| m.get(k).and_then(|x| x.as_f64())).collect();
            let mut s = v.clone();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            out.insert(k.clone(), json!([r1(s[s.len() / 2]), r1(s[0]), r1(s[s.len() - 1])]));
        }
    }
    Value::Object(out)
}
