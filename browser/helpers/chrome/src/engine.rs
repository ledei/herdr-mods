//! The engine: owns Chrome, tabs, per-tab input queues, screencast and Select element.
//! Every client (WebSocket or in-process selftest) talks to it through `Cmd` messages.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use chromiumoxide::cdp::browser_protocol::{dom, emulation, inspector, input, overlay, page, target};
use chromiumoxide::cdp::js_protocol::runtime;
use chromiumoxide::error::CdpError;
use chromiumoxide::{Browser, BrowserConfig, Command, Page};
use futures::stream::BoxStream;
use futures::StreamExt;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};

use crate::agent;
use crate::keys::{self, KeyAction};
use crate::proto::{normalize_url, Button, ClientMsg, GroupInfo, MouseKind, MouseMsg, Mods, StateMsg, ServerMsg, TabInfo, TabOp, View};
use crate::select;

pub const CDP_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound for one Page.navigate wait (chromiumoxide's own navigation timeout is 30 s).
const NAV_TIMEOUT: Duration = Duration::from_secs(35);
/// Per tab group.
const MAX_TABS: usize = 9;
/// The panel's own tab group; agents get one each (see `agent_group_key`).
pub const USER_GROUP: &str = "user";
const KEEP_FRAMES: u64 = 30;
const MOVE_INTERVAL: Duration = Duration::from_millis(16);
/// Screencast pacing (A.2). While "active" every frame is acked at once (Chrome's full rate);
/// otherwise acks are paced so at most IDLE_FPS frames a second reach the panel. Active means: any
/// panel or agent input in the last ACTIVE_INPUT, a load in progress on the cast tab, or a
/// viewport change in the last ACTIVE_VIEW.
const IDLE_FPS: u64 = 12;
const ACTIVE_INPUT: Duration = Duration::from_millis(1500);
const ACTIVE_VIEW: Duration = Duration::from_millis(500);
/// A.4: tabs the panel has not shown for this long are frozen (no JS, no rendering).
pub const FREEZE_AFTER: Duration = Duration::from_secs(30);
/// Agent tab groups kept at most (each tab is a headless window that keeps rendering): over this,
/// the least recently used group that is not shown, has no connected agent and no request in
/// flight is closed.
pub const MAX_AGENT_GROUPS: usize = 8;
/// An agent group with no connected agent is closed after this long unused.
pub const AGENT_GROUP_IDLE: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Headless {
    New,
    Old,
    Head,
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Paths sent to the panel are relative to this (herdr's appHome).
    pub app_home: PathBuf,
    /// `<app_home>/data/herdr-browser`
    pub data_dir: PathBuf,
    pub profile_dir: PathBuf,
    pub chrome: PathBuf,
    pub headless: Headless,
    /// Use pbcopy/pbpaste. Off in selftests so the user's clipboard is untouched.
    pub clipboard: bool,
    /// Exit when no client has been connected for this long.
    pub idle_exit: Option<Duration>,
    /// Record Chrome's pid in `<data_dir>/chrome.pid` (server mode).
    pub chrome_pid_file: bool,
    pub verbose: bool,
    /// Freeze background-able tabs this long after the panel stops showing them (A.4).
    pub freeze_after: Duration,
    /// See MAX_AGENT_GROUPS and AGENT_GROUP_IDLE (smaller in selftests).
    pub max_agent_groups: usize,
    pub agent_group_idle: Duration,
}

impl Config {
    /// A throwaway config under `tmp` (selftests and the bench): no clipboard, no idle exit.
    pub fn for_test(tmp: &Path, chrome: PathBuf, headless: Headless) -> Config {
        Config {
            app_home: tmp.to_path_buf(),
            data_dir: tmp.join("data").join("herdr-browser"),
            profile_dir: tmp.join("selftest-profile"),
            chrome,
            headless,
            clipboard: false,
            idle_exit: None,
            chrome_pid_file: false,
            verbose: std::env::var_os("HERDR_BROWSER_VERBOSE").is_some(),
            freeze_after: FREEZE_AFTER,
            max_agent_groups: MAX_AGENT_GROUPS,
            agent_group_idle: AGENT_GROUP_IDLE,
        }
    }

    pub fn rel(&self, p: &Path) -> String {
        match p.strip_prefix(&self.app_home) {
            Ok(r) => r.to_string_lossy().into_owned(),
            Err(_) => p.to_string_lossy().into_owned(),
        }
    }
}

macro_rules! log {
    ($cfg:expr, $($a:tt)*) => { if $cfg.verbose { eprintln!("[herdr-browser] {}", format!($($a)*)); } };
}

// ---------------------------------------------------------------- client channel

/// Sending half handed to the engine for one client. Control messages are queued in order;
/// frames are latest-only (a watch channel), so a slow client never builds a frame backlog.
#[derive(Clone)]
pub struct ClientOut {
    ctrl: mpsc::UnboundedSender<String>,
    frame: Arc<watch::Sender<Option<String>>>,
}

pub struct ClientRx {
    pub ctrl: mpsc::UnboundedReceiver<String>,
    pub frame: watch::Receiver<Option<String>>,
}

pub fn client_channel() -> (ClientOut, ClientRx) {
    let (ctx, crx) = mpsc::unbounded_channel();
    let (ftx, frx) = watch::channel(None);
    (ClientOut { ctrl: ctx, frame: Arc::new(ftx) }, ClientRx { ctrl: crx, frame: frx })
}

impl ClientOut {
    pub fn send(&self, m: &ServerMsg) {
        let s = m.to_json();
        match m {
            ServerMsg::Frame { .. } => {
                let _ = self.frame.send(Some(s));
            }
            _ => {
                let _ = self.ctrl.send(s);
            }
        }
    }
}

type Outbox = Arc<Mutex<Option<(u64, ClientOut)>>>;

fn emit(outbox: &Outbox, m: &ServerMsg) {
    let out = outbox.lock().ok().and_then(|g| g.as_ref().map(|(_, o)| o.clone()));
    if let Some(o) = out {
        o.send(m);
    }
}

// ---------------------------------------------------------------- commands

pub enum Cmd {
    Connect { id: u64, out: ClientOut },
    Disconnect { id: u64 },
    Client { id: u64, msg: ClientMsg },
    BadMessage { id: u64, err: String },
    Probe(Probe),
    Shutdown,
}

/// In-process hooks used by the selftests (never reachable from the socket).
pub enum Probe {
    Eval { expr: String, reply: oneshot::Sender<Result<serde_json::Value, String>> },
    BoxCenter { selector: String, reply: oneshot::Sender<Result<(f64, f64), String>> },
    Flush { reply: oneshot::Sender<()> },
    Stats { reply: oneshot::Sender<Stats> },
    /// Crash the active tab's renderer (Page.crash); replies once the command is sent.
    Crash { reply: oneshot::Sender<()> },
    /// Every tab as (group id, tab id, Chrome window id).
    Windows { reply: oneshot::Sender<Vec<(String, u32, i64)>> },
    /// How many page targets Chrome itself reports (Target.getTargets), tracked or not.
    PageTargets { reply: oneshot::Sender<usize> },
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub frames_received: u64,
    pub frames_acked: u64,
    pub frames_written: u64,
    pub frames_dropped: u64,
    pub chrome_pid: Option<u32>,
    pub launches: u64,
}

/// What the cast's ack pacing needs to know, shared with the screencast task.
pub(crate) struct Activity {
    origin: Instant,
    /// ms since `origin`, +1 (0 = never)
    input: AtomicU64,
    view: AtomicU64,
    loading: AtomicBool,
    /// Wakes a cast that holds a frame (a permit is kept if nobody waits, so none is lost).
    wake: tokio::sync::Notify,
}

impl Activity {
    fn new() -> Activity {
        Activity { origin: Instant::now(), input: AtomicU64::new(0), view: AtomicU64::new(0), loading: AtomicBool::new(false), wake: tokio::sync::Notify::new() }
    }

    fn stamp(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64 + 1
    }

    fn input(&self) {
        self.input.store(self.stamp(), Ordering::Relaxed);
        self.wake.notify_one();
    }

    fn viewport(&self) {
        self.view.store(self.stamp(), Ordering::Relaxed);
        self.wake.notify_one();
    }

    fn set_loading(&self, on: bool) {
        if self.loading.swap(on, Ordering::Relaxed) != on && on {
            self.wake.notify_one();
        }
    }

    fn is_active(&self) -> bool {
        let now = self.stamp();
        let within = |at: u64, d: Duration| at != 0 && now.saturating_sub(at) < d.as_millis() as u64;
        self.loading.load(Ordering::Relaxed) || within(self.input.load(Ordering::Relaxed), ACTIVE_INPUT) || within(self.view.load(Ordering::Relaxed), ACTIVE_VIEW)
    }
}

#[derive(Default)]
struct Counters {
    received: AtomicU64,
    acked: AtomicU64,
    written: AtomicU64,
    dropped: AtomicU64,
}

struct PendingFrame {
    data: String,
    w: f64,
    h: f64,
    ts: f64,
    /// Bench trace only: Chrome's scrollOffsetY (NaN for a still frame) and when the helper got it.
    sy: f64,
    rx: f64,
}

/// Bench-only trace of frames and wheel dispatches. Off unless the in-process bench turns it on,
/// so the live helper never records anything.
pub(crate) mod trace {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    static ON: AtomicBool = AtomicBool::new(false);

    #[derive(Clone, Debug)]
    pub struct FrameT {
        pub seq: u64,
        /// Chrome frame swap time, helper receipt, write start and end: ms since the epoch.
        pub ts: f64,
        pub rx: f64,
        pub w0: f64,
        pub w1: f64,
        pub sy: f64,
        pub bytes: usize,
    }

    #[derive(Clone, Debug)]
    pub struct WheelT {
        /// Input.dispatchMouseEvent sent and answered, ms since the epoch.
        pub t0: f64,
        pub t1: f64,
        pub dy: f64,
    }

    pub static FRAMES: Mutex<Vec<FrameT>> = Mutex::new(Vec::new());
    pub static WHEELS: Mutex<Vec<WheelT>> = Mutex::new(Vec::new());

    pub fn enable() {
        ON.store(true, Ordering::Relaxed);
    }

    pub fn on() -> bool {
        ON.load(Ordering::Relaxed)
    }

    pub fn now_ms() -> f64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
    }

    pub fn take() -> (Vec<FrameT>, Vec<WheelT>) {
        (std::mem::take(&mut *FRAMES.lock().unwrap()), std::mem::take(&mut *WHEELS.lock().unwrap()))
    }
}

/// A numeric tuning knob from the environment (bench variants); `default` when unset or invalid.
fn env_num(name: &str, default: f64) -> f64 {
    std::env::var(name).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(default)
}

/// Writes screencast frames: at most one write at a time, and while one runs only the newest
/// frame waits in `slot`. When a write ends the slot is written next, so the last frame of a
/// change is never lost (Chrome sends no more frames once the page is still).
#[derive(Clone)]
struct FrameWriter {
    outbox: Outbox,
    counters: Arc<Counters>,
    busy: Arc<AtomicBool>,
    slot: Arc<Mutex<Option<PendingFrame>>>,
    seq: Arc<AtomicU64>,
    dir: PathBuf,
    cfg: Config,
}

impl FrameWriter {
    fn offer(&self, f: PendingFrame) {
        let replaced = self.slot.lock().map(|mut g| g.replace(f).is_some()).unwrap_or(false);
        if replaced {
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
        }
        if !self.busy.swap(true, Ordering::AcqRel) {
            tokio::spawn(self.clone().drain());
        }
    }

    async fn drain(self) {
        loop {
            let next = self.slot.lock().ok().and_then(|mut g| g.take());
            let Some(f) = next else {
                self.busy.store(false, Ordering::Release);
                // A frame may have arrived between take() and the store above.
                let more = self.slot.lock().map(|g| g.is_some()).unwrap_or(false);
                if more && !self.busy.swap(true, Ordering::AcqRel) {
                    continue;
                }
                return;
            };
            let n = self.seq.fetch_add(1, Ordering::Relaxed);
            let path = self.dir.join(format!("{n}.jpg"));
            let p2 = path.clone();
            let w0 = trace::now_ms();
            let (ts, sy, rx, bytes) = (f.ts, f.sy, f.rx, f.data.len());
            let wrote = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(f.data.as_bytes())
                    .map_err(|e| e.to_string())?;
                select::write_atomic(&p2, &bytes)?;
                if n >= KEEP_FRAMES {
                    let _ = std::fs::remove_file(p2.with_file_name(format!("{}.jpg", n - KEEP_FRAMES)));
                }
                Ok(())
            })
            .await;
            match wrote {
                Ok(Ok(())) => {
                    self.counters.written.fetch_add(1, Ordering::Relaxed);
                    if trace::on() {
                        let t = trace::FrameT { seq: n, ts, rx, w0, w1: trace::now_ms(), sy, bytes };
                        trace::FRAMES.lock().unwrap().push(t);
                    }
                    emit(&self.outbox, &ServerMsg::Frame { path: self.cfg.rel(&path), seq: n, w: f.w, h: f.h, ts: f.ts, sy: if f.sy.is_finite() { f.sy } else { -1.0 } });
                }
                Ok(Err(e)) => eprintln!("[herdr-browser] frame write: {e}"),
                Err(e) => eprintln!("[herdr-browser] frame task: {e}"),
            }
        }
    }
}

/// A screenshot in the screencast's format, as a frame (see the pacing loop).
async fn still_frame(page: &Page, v: View) -> Option<PendingFrame> {
    let p = page::CaptureScreenshotParams { format: Some(page::CaptureScreenshotFormat::Jpeg), quality: Some(80), ..Default::default() };
    let shot = run(page, p).await.ok()?;
    let ts = trace::now_ms();
    Some(PendingFrame { data: AsRef::<str>::as_ref(&shot.data).to_string(), w: v.w, h: v.h, ts, sy: f64::NAN, rx: ts })
}

async fn ack_one(page: &Page, w: &FrameWriter, sid: i64) {
    if run(page, page::ScreencastFrameAckParams::new(sid)).await.is_ok() {
        w.counters.acked.fetch_add(1, Ordering::Relaxed);
    }
}

async fn ack_all(page: &Page, w: &FrameWriter, held: &mut std::collections::VecDeque<i64>) {
    while let Some(sid) = held.pop_front() {
        ack_one(page, w, sid).await;
    }
}

/// Storage.setCookies one cookie at a time, so one Chrome rejects (say SameSite=None without
/// Secure) is counted as skipped instead of failing the rest. Values are wiped afterwards.
async fn import_cookies(b: &Browser, args: &mut serde_json::Value) -> Result<serde_json::Value, String> {
    use chromiumoxide::cdp::browser_protocol::{network, storage};
    let Some(list) = args["cookies"].as_array_mut() else { return Err("cookies must be a list".into()) };
    let (mut imported, mut skipped) = (0u64, 0u64);
    for c in list.iter_mut() {
        match serde_json::from_value::<network::CookieParam>(c.clone()) {
            Ok(p) => {
                let cmd = storage::SetCookiesParams { cookies: vec![p], browser_context_id: None };
                match run_b(b, cmd).await {
                    Ok(_) => imported += 1,
                    Err(_) => skipped += 1,
                }
            }
            Err(_) => skipped += 1,
        }
        if let Some(serde_json::Value::String(v)) = c.get_mut("value") {
            crate::cookies::wipe(v);
        }
    }
    Ok(serde_json::json!({ "imported": imported, "skipped": skipped }))
}

enum Ev {
    Died(u64),
    Health(u64, bool),
    Relaunch,
    /// A page target Chrome opened; the second id is its opener (a popup's page), if any.
    TargetCreated(u64, target::TargetId, Option<target::TargetId>),
    PageReady(u64, Page, Option<target::TargetId>),
    TargetInfo(u64, target::TargetId, String, String),
    TargetGone(u64, target::TargetId),
    Loading(u64, u32, bool),
    NavChanged(u64, u32),
    History { gen: u64, tab: u32, url: String, title: String, back: bool, fwd: bool },
    Inspect(u64, u32, dom::BackendNodeId),
    /// A pick made in group `.0`.
    Selected(String, Result<select::Selection, String>),
    /// An agent request finished (its reply is already sent).
    /// An agent request ended: (agent name, group id).
    ReqDone(String, String),
    /// Nobody picked an element for an agent's select_element in time.
    SelectGiveUp,
    /// A tab's renderer died (Inspector.targetCrashed or Target.targetCrashed).
    Crashed(u64, target::TargetId),
}

pub(crate) enum InputOp {
    Mouse(MouseMsg),
    /// `agent`: sent by an AI client. Agent keys never touch the system clipboard (no pbpaste on
    /// paste, no pbcopy on copy/cut), so a page cannot steer an agent into reading or replacing it.
    Key { key: String, ch: Option<String>, mods: Mods, agent: bool },
    Text(String),
    Navigate(String),
    Back,
    Forward,
    Reload,
    Flush(oneshot::Sender<()>),
}

// ---------------------------------------------------------------- CDP helpers

/// Run one CDP command with a hard timeout. Nothing is kept per command.
pub async fn run<C: Command>(page: &Page, cmd: C) -> Result<C::Response, String> {
    match tokio::time::timeout(CDP_TIMEOUT, page.execute(cmd)).await {
        Ok(Ok(r)) => Ok(r.result),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("CDP timeout".into()),
    }
}

async fn run_b<C: Command>(b: &Browser, cmd: C) -> Result<C::Response, String> {
    match tokio::time::timeout(CDP_TIMEOUT, b.execute(cmd)).await {
        Ok(Ok(r)) => Ok(r.result),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("CDP timeout".into()),
    }
}

pub async fn pbcopy(text: &str) {
    use tokio::io::AsyncWriteExt;
    // Absolute path, and a UTF-8 locale: launched via nohup the sidecar may have no LANG, and
    // pbcopy/pbpaste then mangle non-ASCII text.
    let child = tokio::process::Command::new("/usr/bin/pbcopy")
        .env("LANG", "en_US.UTF-8")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    if let Ok(mut c) = child {
        if let Some(mut stdin) = c.stdin.take() {
            let _ = stdin.write_all(text.as_bytes()).await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), c.wait()).await;
    }
}

async fn pbpaste() -> Option<String> {
    let fut = tokio::process::Command::new("/usr/bin/pbpaste")
        .env("LANG", "en_US.UTF-8")
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(2), fut).await {
        Ok(Ok(o)) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        _ => None,
    }
}

fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Height of headless Chrome's hidden browser bar: the screencast draws the window's content
/// area, which is the window height minus this. -1 until measured.
static CHROME_BAR: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);

/// Headless screencast frames show the *window*, not the emulated viewport: a 1024x768 window
/// gives 1024x625 frames whatever the override says, so the panel scaled a short strip and
/// clicks landed off target. Size the window so its content area is exactly the viewport.
async fn fit_window(page: &Page, v: View) -> Result<(), String> {
    use chromiumoxide::cdp::browser_protocol::browser;
    use std::sync::atomic::Ordering;
    let mut bar = CHROME_BAR.load(Ordering::Relaxed);
    if bar < 0 {
        let _ = run(page, emulation::ClearDeviceMetricsOverrideParams::default()).await;
        let eval = runtime::EvaluateParams::builder()
            .expression("outerHeight - innerHeight")
            .return_by_value(true)
            .build()
            .map_err(|e| e.to_string())?;
        bar = run(page, eval)
            .await
            .ok()
            .and_then(|r| r.result.value.and_then(|v| v.as_i64()))
            .filter(|b| (0..=400).contains(b))
            .unwrap_or(143);
        CHROME_BAR.store(bar, Ordering::Relaxed);
    }
    let win = run(page, browser::GetWindowForTargetParams { target_id: Some(page.target_id().clone()) }).await?;
    let bounds = browser::Bounds {
        width: Some(v.w as i64),
        height: Some(v.h as i64 + bar),
        window_state: Some(browser::WindowState::Normal),
        ..Default::default()
    };
    run(page, browser::SetWindowBoundsParams::new(win.window_id, bounds)).await.map(|_| ())
}

async fn set_metrics(page: &Page, v: View) -> Result<(), String> {
    if let Err(e) = fit_window(page, v).await {
        eprintln!("[herdr-browser] fit window: {e}");
    }
    run(page, emulation::SetDeviceMetricsOverrideParams::new(v.w as i64, v.h as i64, v.scale, false))
        .await
        .map(|_| ())
}

async fn insert_text(page: &Page, text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    run(page, input::InsertTextParams::new(text)).await.map(|_| ())
}

fn key_event(
    ty: input::DispatchKeyEventType,
    key: &str,
    code: &str,
    vk: i64,
    mods: i64,
    text: Option<&str>,
    commands: Vec<String>,
) -> input::DispatchKeyEventParams {
    input::DispatchKeyEventParams {
        r#type: ty,
        modifiers: Some(mods),
        timestamp: None,
        text: text.map(String::from),
        unmodified_text: text.map(String::from),
        key_identifier: None,
        code: Some(code.to_string()),
        key: Some(key.to_string()),
        windows_virtual_key_code: Some(vk),
        native_virtual_key_code: Some(vk),
        auto_repeat: None,
        is_keypad: None,
        is_system_key: None,
        location: None,
        commands: if commands.is_empty() { None } else { Some(commands) },
    }
}

async fn press(page: &Page, key: &str, code: &str, vk: i64, mods: i64, text: Option<&str>, commands: Vec<String>) -> Result<(), String> {
    use input::DispatchKeyEventType as T;
    let down = if text.is_some() { T::KeyDown } else { T::RawKeyDown };
    run(page, key_event(down, key, code, vk, mods, text, commands)).await?;
    run(page, key_event(T::KeyUp, key, code, vk, mods, None, vec![])).await?;
    Ok(())
}

/// The text cmd-c/cmd-x copies. Value slices only for text-like fields; any other INPUT (password
/// above all) copies nothing, as Chrome itself refuses to copy from a password field.
pub(crate) const SELECTION_JS: &str = r#"(() => { const a = document.activeElement;
  if (a && a.tagName === 'TEXTAREA') return a.value.slice(a.selectionStart, a.selectionEnd);
  if (a && a.tagName === 'INPUT') {
    if (!['text', 'search', 'url', 'email', 'tel'].includes(a.type)) return '';
    return a.selectionStart == null ? '' : a.value.slice(a.selectionStart, a.selectionEnd);
  }
  return String(getSelection() || ''); })()"#;

/// Runtime.evaluate in the page. Only called with fixed expressions (SELECTION_JS) or from the
/// in-process selftest probe; nothing from the socket reaches it.
async fn eval(page: &Page, expr: &str) -> Result<serde_json::Value, String> {
    let p = runtime::EvaluateParams {
        return_by_value: Some(true),
        await_promise: Some(true),
        ..runtime::EvaluateParams::new(expr)
    };
    let r = run(page, p).await?;
    if let Some(ex) = r.exception_details {
        return Err(format!("exception: {}", ex.text));
    }
    Ok(r.result.value.unwrap_or(serde_json::Value::Null))
}

fn cdp_button(b: Button) -> input::MouseButton {
    match b {
        Button::Left => input::MouseButton::Left,
        Button::Right => input::MouseButton::Right,
        Button::Middle => input::MouseButton::Middle,
    }
}

fn button_bit(b: Button) -> i64 {
    match b {
        Button::Left => 1,
        Button::Right => 2,
        Button::Middle => 4,
    }
}

fn mouse_params(ty: input::DispatchMouseEventType, x: f64, y: f64) -> input::DispatchMouseEventParams {
    input::DispatchMouseEventParams::new(ty, x, y)
}

async fn do_mouse(page: &Page, m: &MouseMsg, pressed: &mut Option<Button>) -> Result<(), String> {
    use input::DispatchMouseEventType as T;
    let mods = m.mods.unwrap_or_default().cdp_bits();
    let mut p;
    match m.kind {
        MouseKind::Down => {
            let b = m.button.unwrap_or_default();
            p = mouse_params(T::MousePressed, m.x, m.y);
            p.button = Some(cdp_button(b));
            p.buttons = Some(button_bit(b));
            p.click_count = Some(m.clicks.unwrap_or(1).max(1));
            *pressed = Some(b);
        }
        MouseKind::Up => {
            let b = m.button.or(*pressed).unwrap_or_default();
            p = mouse_params(T::MouseReleased, m.x, m.y);
            p.button = Some(cdp_button(b));
            p.buttons = Some(0);
            p.click_count = Some(m.clicks.unwrap_or(1).max(1));
            *pressed = None;
        }
        MouseKind::Move => {
            p = mouse_params(T::MouseMoved, m.x, m.y);
            p.button = Some(pressed.map(cdp_button).unwrap_or(input::MouseButton::None));
            p.buttons = Some(pressed.map(button_bit).unwrap_or(0));
        }
        MouseKind::Wheel => {
            p = mouse_params(T::MouseWheel, m.x, m.y);
            p.button = Some(input::MouseButton::None);
            p.delta_x = Some(m.dx.unwrap_or(0.0));
            p.delta_y = Some(m.dy.unwrap_or(0.0));
        }
    }
    p.modifiers = Some(mods);
    if m.kind == MouseKind::Wheel && trace::on() {
        let t0 = trace::now_ms();
        let r = run(page, p).await.map(|_| ());
        trace::WHEELS.lock().unwrap().push(trace::WheelT { t0, t1: trace::now_ms(), dy: m.dy.unwrap_or(0.0) });
        return r;
    }
    run(page, p).await.map(|_| ())
}

/// Whether a key may use pbcopy/pbpaste: only the panel's own keys, and only when enabled.
pub(crate) fn key_clipboard(enabled: bool, agent: bool) -> bool {
    enabled && !agent
}

async fn do_key(page: &Page, key: &str, ch: Option<&str>, mods: Mods, clipboard: bool) -> Result<(), String> {
    let bits = mods.cdp_bits();
    match keys::classify(key, ch, &mods) {
        KeyAction::Text(t) => insert_text(page, &t).await,
        KeyAction::Named(d) => {
            let cmds = d.commands.iter().map(|s| s.to_string()).collect();
            press(page, d.key, d.code, d.vk, bits, d.text, cmds).await
        }
        KeyAction::Command { command, key, code, vk } => {
            if clipboard && (command == "copy" || command == "cut") {
                if let Ok(serde_json::Value::String(s)) = eval(page, SELECTION_JS).await {
                    if !s.is_empty() {
                        pbcopy(&s).await;
                    }
                }
            }
            press(page, &key, &code, vk, bits, None, vec![command.to_string()]).await
        }
        KeyAction::Paste => {
            if clipboard {
                if let Some(t) = pbpaste().await {
                    return insert_text(page, &t).await;
                }
            }
            press(page, "v", "KeyV", 86, bits, None, vec!["paste".into()]).await
        }
        KeyAction::Chord { key, code, vk } => press(page, &key, &code, vk, bits, None, vec![]).await,
        KeyAction::Ignore => Ok(()),
    }
}

async fn history_step(page: &Page, delta: i64) -> Result<(), String> {
    let h = run(page, page::GetNavigationHistoryParams::default()).await?;
    let i = h.current_index + delta;
    if i < 0 || i as usize >= h.entries.len() {
        return Ok(());
    }
    run(page, page::NavigateToHistoryEntryParams::new(h.entries[i as usize].id)).await.map(|_| ())
}

/// Page.navigate through chromiumoxide only returns once the page has loaded (or after its own
/// 30 s navigation timeout), so it runs in its own task: input queued behind it is never held up.
/// A newer navigation aborts the wait for the older one.
fn spawn_navigate(page: &Page, url: String, outbox: &Outbox, nav: &mut Option<JoinHandle<()>>, verbose: bool) {
    // chromiumoxide runs one navigation per page at a time and sends the next Page.navigate only
    // once the previous document fired `load` (or after 30 s). A page still loading would hold
    // the new URL back, so replace it with about:blank first: that loads at once, completes the
    // old navigation, and the queued Page.navigate goes out. location.replace overwrites the
    // stalled page's history entry, so Back from the new page shows about:blank.
    let superseded = match nav.take() {
        Some(h) => {
            let running = !h.is_finished();
            h.abort();
            running
        }
        None => false,
    };
    let (page, outbox) = (page.clone(), outbox.clone());
    *nav = Some(tokio::spawn(async move {
        if superseded {
            let _ = eval(&page, "location.replace('about:blank')").await;
        }
        let r = tokio::time::timeout(NAV_TIMEOUT, page.execute(page::NavigateParams::new(url.clone()))).await;
        match r {
            Ok(Ok(r)) => match r.result.error_text {
                Some(e) if !e.is_empty() && e != "net::ERR_ABORTED" => {
                    emit(&outbox, &ServerMsg::Error { message: format!("{e} ({url})") });
                }
                _ => {}
            },
            // A slow page: the navigation is still running in Chrome; nothing to report.
            Ok(Err(CdpError::Timeout)) => {}
            Ok(Err(e)) => emit(&outbox, &ServerMsg::Error { message: format!("{e} ({url})") }),
            Err(_) => {}
        }
        if verbose {
            eprintln!("[herdr-browser] navigate done: {url}");
        }
    }));
}

/// One ordered input queue per tab. Moves are coalesced (latest pending wins) and sent at most
/// every 16 ms; everything else keeps its order.
async fn input_worker(page: Page, mut rx: mpsc::UnboundedReceiver<InputOp>, clipboard: bool, outbox: Outbox, verbose: bool) {
    let mut nav: Option<JoinHandle<()>> = None;
    let mut pressed: Option<Button> = None;
    let mut last_move = Instant::now() - Duration::from_secs(1);
    let mut pending: Option<InputOp> = None;
    // Helper-side smooth scrolling (Chrome does not animate CDP wheel events, so a mouse notch was one
    // 80 px jump; on by default at 70 ms ease-out, HERDR_BROWSER_WHEEL_SMOOTH_MS=0 turns it off):
    // a wheel event of at least HERDR_BROWSER_WHEEL_SMOOTH_MIN px (a mouse notch, not a trackpad
    // step) is spread over that many ms, one wheel event per tick (HERDR_BROWSER_WHEEL_SMOOTH_TICK,
    // shaped by HERDR_BROWSER_WHEEL_SMOOTH_POW). A new notch adds to
    // what is left and restarts the time, so a burst becomes one steady glide.
    let smooth = Duration::from_millis(env_num("HERDR_BROWSER_WHEEL_SMOOTH_MS", 70.0).max(0.0) as u64);
    let smooth_min = env_num("HERDR_BROWSER_WHEEL_SMOOTH_MIN", 40.0);
    let tick = Duration::from_millis(env_num("HERDR_BROWSER_WHEEL_SMOOTH_TICK", 16.0).max(1.0) as u64);
    let smooth_pow = env_num("HERDR_BROWSER_WHEEL_SMOOTH_POW", 2.0).clamp(1.0, 4.0);
    struct Glide {
        m: MouseMsg,
        left_x: f64,
        left_y: f64,
        end: Instant,
        next: Instant,
        /// Glide time left (s) at the point the previous step aimed for (one tick ahead).
        aim: f64,
    }
    let mut glide: Option<Glide> = None;
    loop {
        let due = glide.as_ref().map(|g| g.next);
        let op = match (pending.take(), due) {
            (Some(o), _) => o,
            (None, None) => match rx.recv().await {
                Some(o) => o,
                None => break,
            },
            (None, Some(due)) => tokio::select! {
                o = rx.recv() => match o {
                    Some(o) => o,
                    None => break,
                },
                _ = tokio::time::sleep_until(due.into()) => {
                    let Some(g) = glide.as_mut() else { continue };
                    // Share of what is left to send now: the curve 1-(1-u)^pow over the glide's
                    // time u (pow 1 = even steps, 2 = ease-out), from where the previous step
                    // aimed to one tick ahead, so a late step (Chrome answers a wheel event about
                    // a frame later) catches up instead of leaving a jump for the end.
                    let now = Instant::now();
                    let a2 = (g.end.saturating_duration_since(now).as_secs_f64() - tick.as_secs_f64()).max(0.0);
                    let last = a2 <= 0.0;
                    let share = if last { 1.0 } else { (1.0 - (a2 / g.aim.max(a2)).powf(smooth_pow)).clamp(0.0, 1.0) };
                    g.aim = a2;
                    let (sx, sy) = (g.left_x * share, g.left_y * share);
                    g.left_x -= sx;
                    g.left_y -= sy;
                    g.next = (g.next + tick).max(now);
                    let mut m = g.m.clone();
                    m.dx = Some(sx);
                    m.dy = Some(sy);
                    if last {
                        glide = None;
                    }
                    let _ = do_mouse(&page, &m, &mut pressed).await;
                    continue;
                }
            },
        };
        // Anything but a move or another wheel event lands after the whole glide.
        let keeps_glide = matches!(&op, InputOp::Mouse(m) if m.kind == MouseKind::Move || m.kind == MouseKind::Wheel);
        if !keeps_glide {
            if let Some(g) = glide.take() {
                let mut m = g.m;
                m.dx = Some(g.left_x);
                m.dy = Some(g.left_y);
                let _ = do_mouse(&page, &m, &mut pressed).await;
            }
        }
        let res = match op {
            InputOp::Mouse(m)
                if m.kind == MouseKind::Wheel
                    && !smooth.is_zero()
                    && (glide.is_some() || m.dy.unwrap_or(0.0).abs() >= smooth_min || m.dx.unwrap_or(0.0).abs() >= smooth_min) =>
            {
                let now = Instant::now();
                let (dx, dy) = (m.dx.unwrap_or(0.0), m.dy.unwrap_or(0.0));
                match glide.as_mut() {
                    Some(g) if g.m.mods == m.mods => {
                        g.left_x += dx;
                        g.left_y += dy;
                        g.m.x = m.x;
                        g.m.y = m.y;
                        g.end = now + smooth;
                        g.aim = smooth.as_secs_f64();
                    }
                    _ => {
                        if let Some(g) = glide.take() {
                            let mut m0 = g.m;
                            m0.dx = Some(g.left_x);
                            m0.dy = Some(g.left_y);
                            let _ = do_mouse(&page, &m0, &mut pressed).await;
                        }
                        glide = Some(Glide { m, left_x: dx, left_y: dy, end: now + smooth, next: now, aim: smooth.as_secs_f64() });
                    }
                }
                Ok(())
            }
            InputOp::Mouse(m) if m.kind == MouseKind::Move => {
                let since = last_move.elapsed();
                if since < MOVE_INTERVAL {
                    tokio::time::sleep(MOVE_INTERVAL - since).await;
                }
                let mut latest = m;
                loop {
                    match rx.try_recv() {
                        Ok(InputOp::Mouse(m2)) if m2.kind == MouseKind::Move => latest = m2,
                        Ok(other) => {
                            pending = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                last_move = Instant::now();
                do_mouse(&page, &latest, &mut pressed).await
            }
            // Chrome answers each wheel event about a frame later while a trackpad sends one every
            // ~8 ms, so wheel events queued meanwhile are merged into one (deltas summed, latest
            // position): the page stays with the finger instead of trailing a backlog.
            InputOp::Mouse(mut m) if m.kind == MouseKind::Wheel => {
                loop {
                    match rx.try_recv() {
                        Ok(InputOp::Mouse(m2)) if m2.kind == MouseKind::Wheel && m2.mods == m.mods => {
                            m.dx = Some(m.dx.unwrap_or(0.0) + m2.dx.unwrap_or(0.0));
                            m.dy = Some(m.dy.unwrap_or(0.0) + m2.dy.unwrap_or(0.0));
                            m.x = m2.x;
                            m.y = m2.y;
                        }
                        Ok(other) => {
                            pending = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                do_mouse(&page, &m, &mut pressed).await
            }
            InputOp::Mouse(m) => do_mouse(&page, &m, &mut pressed).await,
            InputOp::Key { key, ch, mods, agent } => do_key(&page, &key, ch.as_deref(), mods, key_clipboard(clipboard, agent)).await,
            InputOp::Text(t) => insert_text(&page, &t).await,
            InputOp::Navigate(url) => {
                spawn_navigate(&page, url, &outbox, &mut nav, verbose);
                Ok(())
            }
            InputOp::Back => history_step(&page, -1).await,
            InputOp::Forward => history_step(&page, 1).await,
            InputOp::Reload => run(&page, page::ReloadParams::default()).await.map(|_| ()),
            InputOp::Flush(reply) => {
                let _ = reply.send(());
                Ok(())
            }
        };
        if let Err(e) = res {
            if verbose {
                eprintln!("[herdr-browser] input: {e}");
            }
        }
    }
    if let Some(h) = nav {
        h.abort();
    }
}

enum PEv {
    Crashed,
    Start(page::FrameId),
    Stop(page::FrameId),
    Nav(bool),
    WithinDoc,
    Inspect(dom::BackendNodeId),
}

async fn page_events(page: Page, gen: u64, tab: u32, ev: mpsc::UnboundedSender<Ev>) {
    let mut streams: Vec<BoxStream<'static, PEv>> = Vec::new();
    if let Ok(s) = page.event_listener::<page::EventFrameStartedLoading>().await {
        streams.push(s.map(|e| PEv::Start(e.frame_id.clone())).boxed());
    }
    if let Ok(s) = page.event_listener::<page::EventFrameStoppedLoading>().await {
        streams.push(s.map(|e| PEv::Stop(e.frame_id.clone())).boxed());
    }
    if let Ok(s) = page.event_listener::<page::EventFrameNavigated>().await {
        streams.push(s.map(|e| PEv::Nav(e.frame.parent_id.is_none())).boxed());
    }
    if let Ok(s) = page.event_listener::<page::EventNavigatedWithinDocument>().await {
        streams.push(s.map(|_| PEv::WithinDoc).boxed());
    }
    if let Ok(s) = page.event_listener::<overlay::EventInspectNodeRequested>().await {
        streams.push(s.map(|e| PEv::Inspect(e.backend_node_id)).boxed());
    }
    if let Ok(s) = page.event_listener::<inspector::EventTargetCrashed>().await {
        streams.push(s.map(|_| PEv::Crashed).boxed());
    }
    let mut all = futures::stream::select_all(streams);
    while let Some(e) = all.next().await {
        let is_main = |f: page::FrameId| {
            let page = page.clone();
            async move { page.mainframe().await.ok().flatten().map(|m| m == f).unwrap_or(true) }
        };
        let msg = match e {
            PEv::Crashed => Ev::Crashed(gen, page.target_id().clone()),
            PEv::Start(f) => {
                if !is_main(f).await {
                    continue;
                }
                Ev::Loading(gen, tab, true)
            }
            PEv::Stop(f) => {
                if !is_main(f).await {
                    continue;
                }
                let _ = ev.send(Ev::Loading(gen, tab, false));
                Ev::NavChanged(gen, tab)
            }
            PEv::Nav(true) | PEv::WithinDoc => Ev::NavChanged(gen, tab),
            PEv::Nav(false) => continue,
            PEv::Inspect(b) => Ev::Inspect(gen, tab, b),
        };
        if ev.send(msg).is_err() {
            break;
        }
    }
}

// ---------------------------------------------------------------- engine state

struct Tab {
    id: u32,
    target: Option<target::TargetId>,
    page: Option<Page>,
    url: String,
    title: String,
    loading: bool,
    can_back: bool,
    can_forward: bool,
    input: Option<mpsc::UnboundedSender<InputOp>>,
    tasks: Vec<JoinHandle<()>>,
    crashed_at: Option<Instant>,
    /// Opened at about:blank and then sent to its URL (restore after a relaunch or crash):
    /// restart the screencast once that first load ends, as one started on the blank page can
    /// stay silent for the new document.
    recast_on_load: bool,
    /// Page.setWebLifecycleState frozen (A.4): set while nobody looks at the browser.
    frozen: bool,
    console: agent::Ring,
    net: agent::Ring,
    refs_doc: Arc<Mutex<Option<String>>>,
}

impl Tab {
    fn new(id: u32, url: &str) -> Tab {
        Tab {
            id,
            target: None,
            page: None,
            url: url.to_string(),
            title: String::new(),
            loading: false,
            can_back: false,
            can_forward: false,
            input: None,
            tasks: Vec::new(),
            crashed_at: None,
            recast_on_load: false,
            frozen: false,
            console: Default::default(),
            net: Default::default(),
            refs_doc: Default::default(),
        }
    }
    fn detach(&mut self) {
        for t in self.tasks.drain(..) {
            t.abort();
        }
        self.input = None;
        self.page = None;
        self.target = None;
        self.loading = false;
    }
    fn info(&self, active: bool) -> TabInfo {
        TabInfo { id: self.id, title: self.title.clone(), url: self.url.clone(), active }
    }
}

/// A set of tabs with its own active tab: the panel's ("user") or one agent terminal's. Every tab
/// has its own headless window (Chrome cannot open a tab in a chosen window), so each group's
/// active tab keeps rendering and an agent's screenshots work while the panel shows another group.
/// All groups share the one profile, so sign-ins work everywhere.
struct Group {
    id: String,
    terminal: Option<String>,
    /// The last agent name seen for this group.
    name: Option<String>,
    tabs: Vec<Tab>,
    active: Option<u32>,
    used: Instant,
    /// Agent requests in flight (their spawned ops hold this group's pages).
    inflight: u32,
}

impl Group {
    fn new(id: &str, terminal: Option<String>, name: Option<String>) -> Group {
        Group { id: id.to_string(), terminal, name, tabs: Vec::new(), active: None, used: Instant::now(), inflight: 0 }
    }
    fn info(&self) -> GroupInfo {
        GroupInfo {
            id: self.id.clone(),
            owner: if self.id == USER_GROUP { "user" } else { "agent" }.into(),
            terminal: self.terminal.clone(),
            name: self.name.clone(),
            tabs: self.tabs.iter().map(|t| t.info(Some(t.id) == self.active)).collect(),
        }
    }
}

/// An agent's group: its terminal (`HC_TERMINAL_ID`), else its name. Ids are namespaced, so no
/// agent can ever land in the user's group. Returns (group id, terminal).
/// localhost, 127.x and [::1] URLs (dev servers): never frozen.
pub(crate) fn is_local_url(url: &str) -> bool {
    let Some((_, rest)) = url.split_once("://") else { return false };
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = auth.rsplit_once('@').map(|(_, h)| h).unwrap_or(auth);
    let host = if host.starts_with('[') { host.split(']').next().map(|h| &h[1..]).unwrap_or("") } else { host.split(':').next().unwrap_or("") };
    let host = host.to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost") || host == "::1" || host.parse::<std::net::Ipv4Addr>().map(|a| a.is_loopback()).unwrap_or(false)
}

pub(crate) fn agent_group_key(name: &str, terminal: Option<&str>) -> (String, Option<String>) {
    let clean = |s: &str| s.trim().chars().filter(|c| !c.is_control()).take(64).collect::<String>();
    match terminal.map(clean).filter(|t| !t.is_empty()) {
        Some(t) => (format!("t:{t}"), Some(t)),
        None => (format!("n:{}", clean(name)), None),
    }
}

/// One group as `evict_pick` sees it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct GroupAge {
    /// An agent group (the user's is never closed).
    agent: bool,
    idle: Duration,
    /// Shown or with a request in flight: never closed.
    pinned: bool,
    /// An agent is still connected to it: closed only to stay under the cap, after every group
    /// nobody is connected to (that agent's next request gets a fresh blank group).
    connected: bool,
}

/// The group to close next: an agent group nobody is connected to and idle for `ttl` or longer;
/// else, while more than `keep` agent groups exist, the one idle longest, disconnected ones
/// first. Never the user's or a pinned one. None when nothing must go.
pub(crate) fn evict_pick(groups: &[GroupAge], keep: usize, ttl: Duration) -> Option<usize> {
    let free = |want_conn: bool| groups.iter().enumerate().filter(move |(_, g)| g.agent && !g.pinned && g.connected == want_conn).max_by_key(|(_, g)| g.idle);
    if let Some((i, g)) = free(false) {
        if g.idle >= ttl {
            return Some(i);
        }
    }
    if groups.iter().filter(|g| g.agent).count() <= keep {
        return None;
    }
    free(false).or_else(|| free(true)).map(|(i, _)| i)
}

struct Chrome {
    browser: Option<Arc<Browser>>,
    pid: Option<u32>,
    handler: JoinHandle<()>,
    bg: JoinSet<()>,
}

pub struct Engine {
    cfg: Config,
    ev_tx: mpsc::UnboundedSender<Ev>,
    ev_rx: mpsc::UnboundedReceiver<Ev>,
    chrome: Option<Chrome>,
    gen: u64,
    launches: u64,
    backoff: Duration,
    relaunch_pending: bool,
    health_inflight: bool,
    health_fail: u32,
    /// "user" first (always index 0), then agent groups in creation order. Agent groups are
    /// removed only by `evict_groups`, so an index is valid until the next call to it.
    groups: Vec<Group>,
    /// The group the panel shows (its active tab is the one screencast).
    shown: String,
    next_tab: u32,
    view: View,
    visible: bool,
    selecting: bool,
    outbox: Outbox,
    last_client: Instant,
    screencast: Option<(u32, JoinHandle<()>)>,
    /// The last Page.stopScreencast in flight, by page: a restart on the same page waits for it.
    stopping: Option<(target::TargetId, JoinHandle<()>)>,
    /// The Emulation.setDeviceMetricsOverride pass for the latest view.
    metrics: Option<JoinHandle<()>>,
    seq: Arc<AtomicU64>,
    busy: Arc<AtomicBool>,
    /// The newest frame not yet written (latest-only: a newer frame replaces it).
    slot: Arc<Mutex<Option<PendingFrame>>>,
    counters: Arc<Counters>,
    act: Arc<Activity>,
    /// When to freeze the tabs (A.4): armed while no panel shows the browser and no agent is
    /// connected.
    freeze_at: Option<Instant>,
    last_state: Option<StateMsg>,
    /// Pages Chrome opened by itself at launch (closed by us; never adopted as tabs).
    ignore_targets: Vec<target::TargetId>,
    /// Clients that are not the panel: undecided (no first message yet) or agents.
    peers: HashMap<u64, Peer>,
    /// Requests in flight per agent name, and the last agent that sent one.
    agent_busy: HashMap<String, u32>,
    agent_last: Option<(String, Instant)>,
    /// Agents waiting in select_element for the user's pick, with their group id: a pick goes only
    /// to waiters of the group it was made in.
    select_waiters: Vec<(String, oneshot::Sender<Result<String, String>>)>,
    /// The group whose pick is being captured (Ev::Inspect → Ev::Selected).
    capturing: Option<String>,
}

/// Who sent a request: the role decides which ops it may run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    Agent,
    Ui,
}

/// Agents (MCP, call) may run every op but import_cookies; `ui` (the user's import dialog via
/// `cookies import`) only import_cookies and reload.
pub(crate) fn op_allowed(role: Role, op: &str) -> bool {
    match role {
        Role::Agent => op != "import_cookies",
        Role::Ui => matches!(op, "import_cookies" | "reload"),
    }
}

struct Peer {
    out: ClientOut,
    /// A `ui` client (sent `{t:"ui"}` first).
    ui: bool,
    /// None until the first message; then the agent's name.
    agent: Option<String>,
    /// The agent's tab group id and terminal (set with `agent`).
    group: String,
    terminal: Option<String>,
}

const AGENT_SHOWN: Duration = Duration::from_secs(20);

fn reply(out: &ClientOut, id: serde_json::Value, r: Result<serde_json::Value, String>) {
    let m = match r {
        Ok(data) => ServerMsg::Res { id, ok: true, data: Some(data), error: None },
        Err(e) => ServerMsg::Res { id, ok: false, data: None, error: Some(e) },
    };
    out.send(&m);
}

impl Engine {
    pub fn new(cfg: Config) -> Engine {
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(1);
        Engine {
            cfg,
            ev_tx,
            ev_rx,
            chrome: None,
            gen: 0,
            launches: 0,
            backoff: Duration::from_millis(500),
            relaunch_pending: false,
            health_inflight: false,
            health_fail: 0,
            groups: vec![Group::new(USER_GROUP, None, None)],
            shown: USER_GROUP.into(),
            next_tab: 1,
            view: View::default(),
            visible: false,
            selecting: false,
            outbox: Arc::new(Mutex::new(None)),
            last_client: Instant::now(),
            screencast: None,
            stopping: None,
            metrics: None,
            slot: Arc::new(Mutex::new(None)),
            // Unique across restarts so the panel never sees a reused frame path.
            seq: Arc::new(AtomicU64::new(start)),
            busy: Arc::new(AtomicBool::new(false)),
            counters: Arc::new(Counters::default()),
            act: Arc::new(Activity::new()),
            freeze_at: None,
            last_state: None,
            ignore_targets: Vec::new(),
            peers: HashMap::new(),
            agent_busy: HashMap::new(),
            agent_last: None,
            select_waiters: Vec::new(),
            capturing: None,
        }
    }

    fn frames_dir(&self) -> PathBuf {
        self.cfg.data_dir.join("frames")
    }

    pub async fn run(mut self, mut cmd_rx: mpsc::UnboundedReceiver<Cmd>) {
        let _ = std::fs::create_dir_all(self.frames_dir());
        let _ = std::fs::create_dir_all(self.cfg.data_dir.join("selections"));
        if let Ok(rd) = std::fs::read_dir(self.frames_dir()) {
            for e in rd.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
        if let Err(e) = self.launch().await {
            eprintln!("[herdr-browser] launch failed: {e}");
            self.schedule_relaunch();
        }
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                c = cmd_rx.recv() => match c {
                    None | Some(Cmd::Shutdown) => break,
                    Some(c) => self.on_cmd(c).await,
                },
                Some(e) = self.ev_rx.recv() => self.on_ev(e).await,
                _ = async { match self.freeze_at { Some(t) => tokio::time::sleep_until(t.into()).await, None => std::future::pending().await } } => {
                    self.freeze_at = None;
                    self.set_frozen(true).await;
                }
                _ = tick.tick() => {
                    if let Some(idle) = self.cfg.idle_exit {
                        let none = self.outbox.lock().map(|g| g.is_none()).unwrap_or(true) && self.peers.is_empty();
                        if none && self.last_client.elapsed() >= idle {
                            log!(self.cfg, "idle for {:?}, exiting", idle);
                            break;
                        }
                    }
                    self.health_check();
                    self.evict_groups(usize::MAX).await;
                    // Clears state.agent once the last agent has been quiet for 20 s.
                    self.push_state(false);
                }
            }
        }
        self.stop_screencast();
        self.kill_chrome().await;
    }

    // ------------------------------------------------------------ chrome lifecycle

    async fn launch(&mut self) -> Result<(), String> {
        self.launches += 1;
        let _ = std::fs::create_dir_all(&self.cfg.profile_dir);
        let mut b = BrowserConfig::builder()
            .chrome_executable(&self.cfg.chrome)
            .port(0)
            .user_data_dir(&self.cfg.profile_dir)
            .viewport(None)
            // Our own wrappers time each call (5 s for the panel's); this is only the outer bound,
            // so an agent's javascript or AX-tree call may take longer.
            .request_timeout(Duration::from_secs(30))
            .launch_timeout(Duration::from_secs(20))
            .window_size(self.view.w as u32, self.view.h as u32)
            .arg("no-default-browser-check")
            // Headless Chrome jumps a wheel notch in one step; this gives Chrome's own eased scroll
            // (measured 2026-11-20: first move 19 ms vs 44-80, settles in 96 ms vs 139, steady 60 fps frames).
            .arg("enable-smooth-scrolling")
            // Retina frames need BOTH this and deviceScaleFactor 2 in the metrics override; either
            // alone gives 1x frames (measured 2026-11-19). A dsf-1 override still gets 1x frames.
            .arg("force-device-scale-factor=2"); // chromiumoxide adds the leading --
        // Bench variants: extra Chrome switches, comma separated, without the leading --
        // (e.g. HERDR_BROWSER_CHROME_ARGS=disable-smooth-scrolling). Unset by default.
        for a in std::env::var("HERDR_BROWSER_CHROME_ARGS").unwrap_or_default().split(',').map(str::trim).filter(|a| !a.is_empty()) {
            b = b.arg(a.trim_start_matches('-').to_string());
        }
        b = match self.cfg.headless {
            Headless::New => b.new_headless_mode(),
            Headless::Old => b,
            Headless::Head => b.with_head(),
        };
        let config = b.build()?;
        let launched = tokio::time::timeout(Duration::from_secs(25), Browser::launch(config))
            .await
            .map_err(|_| "Chrome launch timed out".to_string())?
            .map_err(|e| format!("Chrome launch failed: {e}"))?;
        let (mut browser, mut handler) = launched;
        let pid = browser.get_mut_child().and_then(|c| c.as_mut_inner().id());
        if self.cfg.chrome_pid_file {
            if let Some(pid) = pid {
                let _ = select::write_atomic(&self.cfg.data_dir.join("chrome.pid"), pid.to_string().as_bytes());
            }
        }
        self.gen += 1;
        let gen = self.gen;
        let ev = self.ev_tx.clone();
        let verbose = self.cfg.verbose;
        let handler_task = tokio::spawn(async move {
            while let Some(r) = handler.next().await {
                match r {
                    Ok(()) => {}
                    Err(CdpError::Ws(e)) => {
                        if verbose {
                            eprintln!("[herdr-browser] CDP socket error: {e}");
                        }
                        break;
                    }
                    Err(e) => {
                        if verbose {
                            eprintln!("[herdr-browser] CDP: {e}");
                        }
                    }
                }
            }
            let _ = ev.send(Ev::Died(gen));
        });

        let mut bg = JoinSet::new();
        // Target events (popups, title changes, closed tabs).
        let created = browser.event_listener::<target::EventTargetCreated>().await;
        let changed = browser.event_listener::<target::EventTargetInfoChanged>().await;
        let destroyed = browser.event_listener::<target::EventTargetDestroyed>().await;
        let crashed = browser.event_listener::<target::EventTargetCrashed>().await;
        if let (Ok(created), Ok(changed), Ok(destroyed), Ok(crashed)) = (created, changed, destroyed, crashed) {
            let ev = self.ev_tx.clone();
            bg.spawn(async move {
                let a = created
                    .filter_map(move |e| {
                        let i = &e.target_info;
                        let m = (i.r#type == "page").then(|| Ev::TargetCreated(gen, i.target_id.clone(), i.opener_id.clone()));
                        async move { m }
                    })
                    .boxed();
                let b = changed
                    .filter_map(move |e| {
                        let i = &e.target_info;
                        let m = (i.r#type == "page")
                            .then(|| Ev::TargetInfo(gen, i.target_id.clone(), i.url.clone(), i.title.clone()));
                        async move { m }
                    })
                    .boxed();
                let c = destroyed.map(move |e| Ev::TargetGone(gen, e.target_id.clone())).boxed();
                let d = crashed.map(move |e| Ev::Crashed(gen, e.target_id.clone())).boxed();
                let mut all = futures::stream::select_all(vec![a, b, c, d]);
                while let Some(m) = all.next().await {
                    if ev.send(m).is_err() {
                        break;
                    }
                }
            });
        }

        // Pages Chrome opened by itself; closed once our tabs exist.
        let initial: Vec<target::TargetId> = run_b(&browser, target::GetTargetsParams::default())
            .await
            .map(|r| r.target_infos.into_iter().filter(|t| t.r#type == "page").map(|t| t.target_id).collect())
            .unwrap_or_default();

        self.chrome = Some(Chrome { browser: Some(Arc::new(browser)), pid, handler: handler_task, bg });
        self.health_fail = 0;
        log!(self.cfg, "chrome up (pid {:?}, gen {gen})", pid);

        if self.groups[0].tabs.is_empty() {
            let id = self.alloc_tab();
            self.groups[0].tabs.push(Tab::new(id, "about:blank"));
            self.groups[0].active = Some(id);
        }
        let ids: Vec<u32> = self.all_tabs().map(|t| t.id).collect();
        for id in ids {
            if let Err(e) = self.open_tab_page(id).await {
                eprintln!("[herdr-browser] restore tab {id}: {e}");
            }
        }
        self.ignore_targets = initial.clone();
        if let Some(c) = &self.chrome {
            if let Some(b) = &c.browser {
                for t in initial {
                    if !self.all_tabs().any(|x| x.target.as_ref() == Some(&t)) {
                        let _ = run_b(b, target::CloseTargetParams::new(t)).await;
                    }
                }
            }
        }
        self.backoff = Duration::from_millis(500);
        self.start_screencast();
        self.push_state(true);
        // Fresh pages are awake; re-arm the freeze if nobody is looking.
        self.freeze_at = None;
        self.sleep_check().await;
        Ok(())
    }

    fn alloc_tab(&mut self) -> u32 {
        let id = self.next_tab;
        self.next_tab += 1;
        id
    }

    fn browser(&self) -> Option<&Browser> {
        self.chrome.as_ref().and_then(|c| c.browser.as_deref())
    }

    // ------------------------------------------------------------ groups and tabs lookup

    fn all_tabs(&self) -> impl Iterator<Item = &Tab> {
        self.groups.iter().flat_map(|g| g.tabs.iter())
    }

    fn tab(&self, id: u32) -> Option<&Tab> {
        self.all_tabs().find(|t| t.id == id)
    }

    fn tab_mut(&mut self, id: u32) -> Option<&mut Tab> {
        self.groups.iter_mut().flat_map(|g| g.tabs.iter_mut()).find(|t| t.id == id)
    }

    fn tab_by_target(&self, tid: &target::TargetId) -> Option<&Tab> {
        self.all_tabs().find(|t| t.target.as_ref() == Some(tid))
    }

    fn group_index(&self, gid: &str) -> Option<usize> {
        self.groups.iter().position(|g| g.id == gid)
    }

    /// The group holding tab `id`.
    fn group_of(&self, id: u32) -> Option<usize> {
        self.groups.iter().position(|g| g.tabs.iter().any(|t| t.id == id))
    }

    fn shown_idx(&self) -> usize {
        self.group_index(&self.shown).unwrap_or(0)
    }

    /// The shown group's active tab: the one the panel sees and that is screencast.
    fn active(&self) -> Option<u32> {
        self.groups[self.shown_idx()].active
    }

    /// Create a Chrome page for an existing tab entry and navigate it to the tab's URL.
    async fn open_tab_page(&mut self, id: u32) -> Result<(), String> {
        let b = self.browser().ok_or("browser down")?;
        // Every tab in a window of its own: a background tab in new headless draws no frames and
        // its screenshots can stall, and Chrome cannot place a new tab in a chosen window.
        let params = target::CreateTargetParams { new_window: Some(true), ..target::CreateTargetParams::new("about:blank") };
        let page = tokio::time::timeout(CDP_TIMEOUT, b.new_page(params))
            .await
            .map_err(|_| "new_page timeout".to_string())?
            .map_err(|e| e.to_string())?;
        self.attach(id, page).await;
        let url = self.tab(id).map(|t| t.url.clone()).unwrap_or_default();
        if !url.is_empty() && url != "about:blank" {
            if let Some(t) = self.tab_mut(id) {
                t.recast_on_load = true;
            }
            self.queue(id, InputOp::Navigate(url));
        }
        Ok(())
    }

    async fn attach(&mut self, id: u32, page: Page) {
        let view = self.view;
        let setup = async {
            run(&page, page::EnableParams::default()).await?;
            run(&page, runtime::EnableParams::default()).await?;
            run(&page, inspector::EnableParams::default()).await?;
            // For the agents' network ring; never worth skipping the metrics below.
            if let Err(e) = agent::cdp(&page, "Network.enable", serde_json::json!({})).await {
                eprintln!("[herdr-browser] Network.enable: {e}");
            }
            run(&page, emulation::SetFocusEmulationEnabledParams::new(true)).await?;
            set_metrics(&page, view).await
        };
        if let Err(e) = setup.await {
            eprintln!("[herdr-browser] page setup: {e}");
        }
        let rings = self.tab(id).map(|t| (t.console.clone(), t.net.clone()));
        let rings = match rings {
            Some((c, n)) => Some(agent::listen(&page, c, n).await),
            None => None,
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(input_worker(
            page.clone(),
            rx,
            self.cfg.clipboard,
            self.outbox.clone(),
            self.cfg.verbose,
        ));
        let events = tokio::spawn(page_events(page.clone(), self.gen, id, self.ev_tx.clone()));
        if let Some(t) = self.tab_mut(id) {
            t.detach();
            t.target = Some(page.target_id().clone());
            t.frozen = false;
            t.page = Some(page);
            t.input = Some(tx);
            t.tasks = vec![worker, events];
            t.tasks.extend(rings);
        }
    }

    async fn kill_chrome(&mut self) {
        let Some(mut c) = self.chrome.take() else { return };
        for t in self.groups.iter_mut().flat_map(|g| g.tabs.iter_mut()) {
            t.detach();
        }
        c.bg.abort_all();
        while c.bg.join_next().await.is_some() {}
        if let Some(arc) = c.browser.take() {
            // All tasks holding a clone were joined above, so this is normally the last reference.
            if let Ok(mut b) = Arc::try_unwrap(arc) {
                let _ = tokio::time::timeout(Duration::from_secs(2), b.close()).await;
                let exited = matches!(tokio::time::timeout(Duration::from_secs(3), b.wait()).await, Ok(Ok(_)));
                if !exited {
                    let _ = tokio::time::timeout(Duration::from_secs(3), b.kill()).await;
                }
            }
        }
        c.handler.abort();
        if let Some(pid) = c.pid {
            // Belt and braces: the pid is the Chrome we spawned.
            for _ in 0..30 {
                if !pid_alive(pid) {
                    break;
                }
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGKILL);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        if self.cfg.chrome_pid_file {
            let _ = std::fs::remove_file(self.cfg.data_dir.join("chrome.pid"));
        }
    }

    async fn on_died(&mut self) {
        eprintln!("[herdr-browser] Chrome/CDP died; relaunching");
        self.stop_screencast();
        self.cancel_select("the browser restarted before a pick");
        self.kill_chrome().await;
        self.push_state(true);
        self.schedule_relaunch();
    }

    fn schedule_relaunch(&mut self) {
        if self.relaunch_pending {
            return;
        }
        self.relaunch_pending = true;
        let d = self.backoff;
        self.backoff = (self.backoff * 2).min(Duration::from_secs(10));
        let ev = self.ev_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(d).await;
            let _ = ev.send(Ev::Relaunch);
        });
    }

    fn health_check(&mut self) {
        if self.health_inflight {
            return;
        }
        let gen = self.gen;
        let ev = self.ev_tx.clone();
        let Some(c) = self.chrome.as_mut() else { return };
        let Some(b) = c.browser.clone() else { return };
        self.health_inflight = true;
        c.bg.spawn(async move {
            let ok = matches!(tokio::time::timeout(Duration::from_secs(4), b.version()).await, Ok(Ok(_)));
            let _ = ev.send(Ev::Health(gen, ok));
        });
    }

    // ------------------------------------------------------------ state

    fn active_tab(&self) -> Option<&Tab> {
        self.active().and_then(|id| self.tab(id))
    }

    /// The panel's state: the shown group's tabs plus every group.
    fn state(&self) -> StateMsg {
        self.state_for(&self.shown, true)
    }

    /// State as seen from group `gid`. `all` (the panel) lists every group and the acting agent;
    /// an agent sees only its own group.
    fn state_for(&self, gid: &str, all: bool) -> StateMsg {
        let g = self.group_index(gid).map(|i| &self.groups[i]);
        let a = g.and_then(|g| g.active).and_then(|id| self.tab(id));
        let mut groups: Vec<&Group> = self.groups.iter().filter(|x| all || Some(x.id.as_str()) == g.map(|g| g.id.as_str())).collect();
        // "user" first, then the most recently active agent group first.
        groups.sort_by(|x, y| (x.id != USER_GROUP).cmp(&(y.id != USER_GROUP)).then(y.used.cmp(&x.used)));
        StateMsg {
            connected: self.chrome.is_some(),
            url: a.map(|t| t.url.clone()).unwrap_or_default(),
            title: a.map(|t| t.title.clone()).unwrap_or_default(),
            loading: a.map(|t| t.loading).unwrap_or(false),
            can_back: a.map(|t| t.can_back).unwrap_or(false),
            can_forward: a.map(|t| t.can_forward).unwrap_or(false),
            tabs: g.map(|g| g.info().tabs).unwrap_or_default(),
            selecting: self.selecting && gid == self.shown,
            agent: if all { self.agent_now() } else { None },
            group: gid.to_string(),
            groups: groups.into_iter().map(|g| g.info()).collect(),
        }
    }

    fn push_state(&mut self, force: bool) {
        let s = self.state();
        if !force && self.last_state.as_ref() == Some(&s) {
            return;
        }
        self.last_state = Some(s.clone());
        emit(&self.outbox, &ServerMsg::State(s));
        // Agents never see other groups' tabs, so each gets its own group's view.
        for p in self.peers.values().filter(|p| p.agent.is_some()) {
            p.out.send(&ServerMsg::State(self.state_for(&p.group, false)));
        }
    }

    fn agent_now(&self) -> Option<String> {
        // The last agent to act while busy or within 20 s, else any agent still mid-request.
        let last = self.agent_last.as_ref().filter(|(n, t)| t.elapsed() < AGENT_SHOWN || self.agent_busy.contains_key(n));
        last.map(|(n, _)| n.clone()).or_else(|| self.agent_busy.keys().next().cloned())
    }

    fn req_done(&mut self, name: &str, gid: &str) {
        if let Some(gi) = self.group_index(gid) {
            let g = &mut self.groups[gi];
            g.inflight = g.inflight.saturating_sub(1);
            g.used = Instant::now();
        }
        self.agent_mark(name, -1);
    }

    fn agent_mark(&mut self, name: &str, delta: i32) {
        self.act.input();
        let n = self.agent_busy.entry(name.to_string()).or_insert(0);
        *n = (*n as i32 + delta).max(0) as u32;
        if *n == 0 {
            self.agent_busy.remove(name);
        }
        self.agent_last = Some((name.to_string(), Instant::now()));
        self.push_state(false);
    }

    fn error(&self, message: impl Into<String>) {
        emit(&self.outbox, &ServerMsg::Error { message: message.into() });
    }

    fn queue(&self, id: u32, op: InputOp) {
        if let Some(tx) = self.tab(id).and_then(|t| t.input.as_ref()) {
            let _ = tx.send(op);
        }
    }

    fn queue_active(&self, op: InputOp) {
        if let Some(id) = self.active() {
            self.queue(id, op);
        }
    }

    // ------------------------------------------------------------ hidden = asleep (A.4)

    /// Somebody may be looking: a visible panel, or an agent connection.
    fn watched(&self) -> bool {
        let panel = self.visible && self.outbox.lock().map(|g| g.is_some()).unwrap_or(false);
        panel || self.peers.values().any(|p| p.agent.is_some())
    }

    /// After any change to the panel or the agents: wake frozen tabs if watched, else arm the
    /// freeze timer.
    async fn sleep_check(&mut self) {
        if self.watched() {
            self.freeze_at = None;
            self.set_frozen(false).await;
        } else if self.freeze_at.is_none() && !self.all_tabs().any(|t| t.frozen) {
            self.freeze_at = Some(Instant::now() + self.cfg.freeze_after);
        }
    }

    /// Freeze (or wake) every tab. Dev servers on localhost are never frozen, so their HMR
    /// sockets keep working; the stopped screencast is all they lose.
    async fn set_frozen(&mut self, on: bool) {
        let state = if on { page::SetWebLifecycleStateState::Frozen } else { page::SetWebLifecycleStateState::Active };
        let pages: Vec<(u32, Page)> = self
            .all_tabs()
            .filter(|t| t.frozen != on && !(on && is_local_url(&t.url)))
            .filter_map(|t| t.page.clone().map(|p| (t.id, p)))
            .collect();
        for (id, p) in pages {
            // Focus emulation (set on every page so pages act focused) counts as a capturer, and
            // a captured page never becomes hidden, so Chrome would ignore the freeze (measured:
            // timers kept running). Drop it while frozen.
            let focus = emulation::SetFocusEmulationEnabledParams::new(!on);
            let r = if on {
                let _ = run(&p, focus).await;
                run(&p, page::SetWebLifecycleStateParams::new(state.clone())).await
            } else {
                let r = run(&p, page::SetWebLifecycleStateParams::new(state.clone())).await;
                let _ = run(&p, focus).await;
                r
            };
            match r {
                Ok(_) => {
                    if let Some(t) = self.tab_mut(id) {
                        t.frozen = on;
                    }
                    log!(self.cfg, "tab {id} {}", if on { "frozen" } else { "active" });
                }
                Err(e) => eprintln!("[herdr-browser] setWebLifecycleState: {e}"),
            }
        }
    }

    // ------------------------------------------------------------ screencast

    fn stop_screencast(&mut self) {
        if let Some((id, h)) = self.screencast.take() {
            h.abort();
            if let Some(page) = self.tab(id).and_then(|t| t.page.clone()) {
                let tid = page.target_id().clone();
                // Keep stops on one page in order.
                let prev = self.stopping.take().filter(|(t, _)| *t == tid).map(|(_, h)| h);
                let h = tokio::spawn(async move {
                    if let Some(p) = prev {
                        let _ = p.await;
                    }
                    let _ = run(&page, page::StopScreencastParams::default()).await;
                });
                self.stopping = Some((tid, h));
            }
        }
    }

    fn start_screencast(&mut self) {
        self.stop_screencast();
        let has_client = self.outbox.lock().map(|g| g.is_some()).unwrap_or(false);
        if !self.visible || !has_client {
            return;
        }
        let Some(tab) = self.active_tab() else { return };
        let Some(page) = tab.page.clone() else { return };
        let id = tab.id;
        let loading = tab.loading;
        // A stop sent to this same page must reach Chrome before the new start, or Chrome ends
        // the new screencast and the panel freezes. A stop for another page can run detached.
        let prev_stop = self
            .stopping
            .take()
            .and_then(|(t, h)| if &t == page.target_id() { Some(h) } else { None });
        if let Ok(mut g) = self.slot.lock() {
            *g = None;
        }
        let v = self.view;
        let act = self.act.clone();
        act.set_loading(loading);
        let w = FrameWriter {
            outbox: self.outbox.clone(),
            counters: self.counters.clone(),
            busy: self.busy.clone(),
            slot: self.slot.clone(),
            seq: self.seq.clone(),
            dir: self.frames_dir(),
            cfg: self.cfg.clone(),
        };
        let h = tokio::spawn(async move {
            if let Some(p) = prev_stop {
                let _ = p.await;
            }
            let mut frames = match page.event_listener::<page::EventScreencastFrame>().await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[herdr-browser] screencast listener: {e}");
                    return;
                }
            };
            // A background tab in new headless draws no frames: bring this one to the front
            // however it became active (select, close, popup, relaunch, crash).
            let _ = run(&page, page::BringToFrontParams::default()).await;
            // The cast keeps the pixel density it started with: apply the view first, in order.
            let _ = set_metrics(&page, v).await;
            // Bench variants (defaults are the shipped settings): JPEG quality, a factor on the
            // frame size cap, and Chrome's everyNthFrame.
            let cast_scale = env_num("HERDR_BROWSER_CAST_SCALE", 1.0).clamp(0.1, 1.0);
            let params = page::StartScreencastParams {
                format: Some(page::StartScreencastFormat::Jpeg),
                quality: Some(env_num("HERDR_BROWSER_JPEG_QUALITY", 80.0).clamp(1.0, 100.0) as i64),
                max_width: Some((v.w * v.scale * cast_scale).round() as i64),
                max_height: Some((v.h * v.scale * cast_scale).round() as i64),
                every_nth_frame: Some(env_num("HERDR_BROWSER_EVERY_NTH", 1.0).max(1.0) as i64),
            };
            if let Err(e) = run(&page, params).await {
                eprintln!("[herdr-browser] startScreencast: {e}");
                return;
            }
            if w.cfg.verbose {
                eprintln!("[herdr-browser] screencast started on {:?}", page.target_id());
            }
            // Ack pacing. Chrome keeps up to 2 frames in flight (unacked) and encodes the next one
            // as soon as one is acked, so while idle one held ack is released per period: Chrome
            // then encodes about IDLE_FPS frames a second (releasing every frame within one period
            // would still let it encode 2 per period). Each frame is shown when it arrives unless
            // one was shown less than 3/4 of a period ago; then it waits for the next period.
            // A paint made while Chrome is at its in-flight limit is never sent, and a still page
            // makes no more: so once frames stop after the limit was hit, everything is acked and
            // one screenshot stands in for the missed last frame.
            let gap = Duration::from_millis(1000 / IDLE_FPS);
            let mut held: std::collections::VecDeque<i64> = Default::default();
            let mut stash: Option<PendingFrame> = None;
            let mut shown_at = Instant::now() - gap;
            let mut next_tick = Instant::now() + gap;
            let mut limit_hit = false;
            let mut last_frame = Instant::now();
            loop {
                let due = (!held.is_empty() || stash.is_some()).then_some(next_tick);
                let quiet = limit_hit.then_some(last_frame + gap * 2);
                tokio::select! {
                    f = frames.next() => {
                        let Some(f) = f else { break };
                        w.counters.received.fetch_add(1, Ordering::Relaxed);
                        last_frame = Instant::now();
                        held.push_back(f.session_id);
                        let fr = PendingFrame {
                            data: AsRef::<str>::as_ref(&f.data).to_string(),
                            w: f.metadata.device_width,
                            h: f.metadata.device_height,
                            ts: f.metadata.timestamp.as_ref().map(|t| *t.inner() * 1000.0).unwrap_or(0.0),
                            sy: f.metadata.scroll_offset_y,
                            rx: trace::now_ms(),
                        };
                        if act.is_active() {
                            stash = None;
                            w.offer(fr);
                            shown_at = Instant::now();
                            ack_all(&page, &w, &mut held).await;
                            next_tick = Instant::now() + gap;
                        } else {
                            limit_hit |= held.len() >= 2;
                            if shown_at.elapsed() >= gap * 3 / 4 {
                                stash = None;
                                w.offer(fr);
                                shown_at = Instant::now();
                            } else {
                                stash = Some(fr);
                            }
                        }
                    }
                    _ = async { match due { Some(d) => tokio::time::sleep_until(d.into()).await, None => std::future::pending().await } } => {
                        // One idle period ended: show a waiting frame, release the oldest ack.
                        if let Some(fr) = stash.take() {
                            w.offer(fr);
                            shown_at = Instant::now();
                        }
                        if let Some(sid) = held.pop_front() {
                            ack_one(&page, &w, sid).await;
                        }
                        next_tick = Instant::now() + gap;
                    }
                    _ = async { match quiet { Some(d) => tokio::time::sleep_until(d.into()).await, None => std::future::pending().await } } => {
                        limit_hit = false;
                        stash = None;
                        ack_all(&page, &w, &mut held).await;
                        if let Some(fr) = still_frame(&page, v).await {
                            w.offer(fr);
                            shown_at = Instant::now();
                        }
                    }
                    _ = act.wake.notified() => {
                        // First input after idle: show and release everything held at once.
                        if act.is_active() {
                            if let Some(fr) = stash.take() {
                                w.offer(fr);
                                shown_at = Instant::now();
                            }
                            ack_all(&page, &w, &mut held).await;
                            next_tick = Instant::now() + gap;
                        }
                    }
                }
            }
        });
        self.screencast = Some((id, h));
    }

    // ------------------------------------------------------------ select element

    async fn set_select(&mut self, on: bool) {
        let Some(page) = self.active_tab().and_then(|t| t.page.clone()) else {
            self.cancel_select("the page is not ready");
            self.push_state(false);
            return;
        };
        if on {
            let r = async {
                run(&page, dom::EnableParams::default()).await?;
                run(&page, chromiumoxide::cdp::browser_protocol::css::EnableParams::default()).await?;
                run(&page, overlay::EnableParams::default()).await?;
                run(&page, select::inspect_on_params()).await
            }
            .await;
            match r {
                Ok(_) => self.selecting = true,
                Err(e) => {
                    self.cancel_select("Select element could not start");
                    self.error(format!("Select element failed: {e}"));
                }
            }
        } else {
            let _ = run(&page, select::inspect_off_params()).await;
            // See select::capture: a left-enabled Overlay breaks mouse input after navigation.
            let _ = run(&page, overlay::DisableParams::default()).await;
            self.cancel_select("Select element was turned off before a pick");
        }
        self.push_state(false);
    }

    /// Leave select mode and fail every waiting select_element, except those whose pick is being
    /// captured right now (Ev::Selected answers them). Every path that ends select mode without a
    /// pick goes through here, so no waiter outlives its pick and gets another group's element.
    fn cancel_select(&mut self, why: &str) {
        self.selecting = false;
        let keep = self.capturing.clone();
        let (kept, failed): (Vec<_>, Vec<_>) = self.select_waiters.drain(..).partition(|(g, _)| Some(g) == keep.as_ref());
        self.select_waiters = kept;
        for (_, w) in failed {
            let _ = w.send(Err(why.to_string()));
        }
    }

    // ------------------------------------------------------------ crashed renderer

    /// Replace a tab whose renderer died with a fresh page at its last URL (a blank page if it
    /// crashed again within 30 s, so a page that always crashes cannot loop).
    async fn on_crashed(&mut self, tid: target::TargetId) {
        // Keyed by target: the second report of one crash (Inspector + Target) finds no tab.
        let Some(id) = self.tab_by_target(&tid).map(|t| t.id) else { return };
        let was_active = self.active() == Some(id);
        eprintln!("[herdr-browser] tab {id} renderer crashed");
        if was_active {
            // The dead page cannot answer; just drop the screencast and inspect mode.
            if let Some((_, h)) = self.screencast.take() {
                h.abort();
            }
            self.cancel_select("the page crashed before a pick");
        }
        let Some(tab) = self.tab_mut(id) else { return };
        let again = tab.crashed_at.map(|t| t.elapsed() < Duration::from_secs(30)).unwrap_or(false);
        tab.detach();
        tab.crashed_at = Some(Instant::now());
        if again {
            tab.url = "about:blank".into();
            tab.title.clear();
        }
        if let Some(c) = self.chrome.as_mut() {
            if let Some(b) = c.browser.clone() {
                let t = tid.clone();
                c.bg.spawn(async move {
                    let _ = run_b(&b, target::CloseTargetParams::new(t)).await;
                });
            }
        }
        match self.open_tab_page(id).await {
            Ok(()) if again => self.error("Page crashed again; opened a blank page"),
            Ok(()) => self.error("Page crashed; reloaded"),
            Err(e) => self.error(format!("Page crashed; reload failed: {e}")),
        }
        if was_active {
            self.start_screencast();
        }
        self.push_state(false);
    }

    // ------------------------------------------------------------ tabs

    /// Open a tab in group `gi` and make it that group's active tab.
    async fn tab_new(&mut self, gi: usize, url: Option<String>) -> Result<u32, String> {
        if self.groups[gi].tabs.len() >= MAX_TABS {
            return Err(format!("At most {MAX_TABS} tabs"));
        }
        let shown = gi == self.shown_idx();
        if shown && self.selecting {
            self.set_select(false).await;
        }
        let id = self.alloc_tab();
        let url = url.map(|u| normalize_url(&u)).unwrap_or_else(|| "about:blank".into());
        self.groups[gi].tabs.push(Tab::new(id, &url));
        self.groups[gi].active = Some(id);
        let mut r = Ok(id);
        if self.chrome.is_some() {
            if let Err(e) = self.open_tab_page(id).await {
                r = Err(format!("New tab failed: {e}"));
            }
        }
        if shown {
            self.start_screencast();
        }
        self.push_state(false);
        r
    }

    async fn tab_select(&mut self, id: u32) {
        let Some(gi) = self.group_of(id) else { return };
        if self.groups[gi].active == Some(id) {
            return;
        }
        let shown = gi == self.shown_idx();
        if shown && self.selecting {
            self.set_select(false).await;
        }
        self.groups[gi].active = Some(id);
        if shown {
            self.start_screencast();
        }
        self.push_state(false);
    }

    async fn tab_remove(&mut self, id: u32, close_target: bool) {
        let Some(gi) = self.group_of(id) else { return };
        let Some(idx) = self.groups[gi].tabs.iter().position(|t| t.id == id) else { return };
        let was_active = self.groups[gi].active == Some(id);
        let shown = gi == self.shown_idx();
        if shown && was_active {
            if self.selecting {
                self.set_select(false).await;
            }
            self.stop_screencast();
        }
        let mut tab = self.groups[gi].tabs.remove(idx);
        let target = tab.target.clone();
        tab.detach();
        if close_target {
            if let (Some(t), Some(b)) = (target, self.browser()) {
                let _ = run_b(b, target::CloseTargetParams::new(t)).await;
            }
        }
        if self.groups[gi].tabs.is_empty() {
            // A group always keeps one tab.
            if let Err(e) = self.tab_new(gi, None).await {
                if shown {
                    self.error(e);
                }
            }
            return;
        }
        if was_active {
            let g = &mut self.groups[gi];
            let i = idx.min(g.tabs.len() - 1);
            g.active = Some(g.tabs[i].id);
            if shown {
                self.start_screencast();
            }
        }
        self.push_state(false);
    }

    /// Tab `id` is about to load `url`. A screencast started on a blank tab can stay silent for
    /// its first real document, so recast once that load ends (as for restored tabs).
    fn note_navigate(&mut self, id: u32, url: &str) {
        if let Some(t) = self.tab_mut(id) {
            if t.url == "about:blank" && url != "about:blank" {
                t.recast_on_load = true;
            }
            t.url = url.to_string();
        }
    }

    /// Show group `gid` in the panel (an unknown id shows "user"); recasts on its active tab.
    async fn show(&mut self, gid: &str) {
        let gid = if self.group_index(gid).is_some() { gid.to_string() } else { USER_GROUP.to_string() };
        if gid == self.shown {
            return;
        }
        if self.selecting {
            self.set_select(false).await;
        }
        // Even when select mode already ended (crash, relaunch): no waiter may see the next group.
        self.cancel_select("the panel switched to another browser before a pick");
        // The group being left was just in use: keep it off the eviction list for a while.
        let old = self.shown_idx();
        self.groups[old].used = Instant::now();
        self.shown = gid;
        self.start_screencast();
        self.push_state(false);
    }

    // ------------------------------------------------------------ agent requests

    /// The tab an agent op acts on: `args.tab` (only a tab of the agent's own group), else the
    /// group's active tab.
    fn op_ctx(&self, gi: usize, args: &serde_json::Value) -> Result<agent::Ctx, String> {
        let g = &self.groups[gi];
        let id = match &args["tab"] {
            serde_json::Value::Null => g.active.ok_or("no tab is open")?,
            v => v.as_u64().ok_or("tab must be a tab id from tabs")? as u32,
        };
        let t = g.tabs.iter().find(|t| t.id == id).ok_or_else(|| format!("no tab {id}; call tabs to list them"))?;
        let starting = || "the browser is starting; try again in a moment".to_string();
        Ok(agent::Ctx {
            page: t.page.clone().ok_or_else(starting)?,
            input: t.input.clone().ok_or_else(starting)?,
            view: self.view,
            front: g.active == Some(id),
            console: t.console.clone(),
            net: t.net.clone(),
            refs_doc: t.refs_doc.clone(),
        })
    }

    async fn op_tabs(&mut self, gi: usize, args: &serde_json::Value) -> Result<serde_json::Value, String> {
        let id_arg = || args["id"].as_u64().map(|i| i as u32);
        let known = |s: &Self, id: u32| if s.groups[gi].tabs.iter().any(|t| t.id == id) { Ok(id) } else { Err(format!("no tab {id}")) };
        match args["action"].as_str().unwrap_or("list") {
            "list" => {}
            "new" => {
                if let Some(u) = args["url"].as_str() {
                    if !crate::proto::agent_url_ok(&normalize_url(u)) {
                        return Err("agents may open http, https, about: and data: pages only".into());
                    }
                }
                self.tab_new(gi, args["url"].as_str().map(String::from)).await?;
            }
            "close" => {
                let id = known(self, id_arg().or(self.groups[gi].active).ok_or("no tab is open")?)?;
                self.tab_remove(id, true).await;
            }
            "select" => {
                let id = known(self, id_arg().ok_or("id is required")?)?;
                self.tab_select(id).await;
            }
            a => return Err(format!("action must be list, new, close or select, not \"{a}\"")),
        }
        serde_json::to_value(self.groups[gi].info().tabs).map_err(|e| e.to_string())
    }

    /// The agent's group, created with one blank tab on its first request.
    async fn agent_group(&mut self, gid: &str, terminal: Option<String>, name: &str) -> usize {
        let gi = match self.group_index(gid) {
            Some(gi) => gi,
            None => {
                // Make room first (indexes change here, before any is handed out).
                self.evict_groups(self.cfg.max_agent_groups.saturating_sub(1)).await;
                log!(self.cfg, "new tab group {gid}");
                self.groups.push(Group::new(gid, terminal, None));
                let gi = self.groups.len() - 1;
                if let Err(e) = self.tab_new(gi, None).await {
                    eprintln!("[herdr-browser] group {gid}: {e}");
                }
                gi
            }
        };
        let g = &mut self.groups[gi];
        g.name = Some(name.to_string());
        g.used = Instant::now();
        gi
    }

    /// Close agent groups until at most `keep` remain, least recently used first, and any group
    /// nobody is connected to and unused for agent_group_idle. Never the user's, the shown one or
    /// one with a request in flight (over the cap then, rather than failing a request).
    async fn evict_groups(&mut self, keep: usize) {
        loop {
            let now = Instant::now();
            let cands: Vec<GroupAge> = self
                .groups
                .iter()
                .map(|g| GroupAge {
                    agent: g.id != USER_GROUP,
                    idle: now.saturating_duration_since(g.used),
                    pinned: g.id == self.shown || g.inflight > 0,
                    connected: self.peers.values().any(|p| p.agent.is_some() && p.group == g.id),
                })
                .collect();
            let Some(gi) = evict_pick(&cands, keep, self.cfg.agent_group_idle) else { return };
            let mut g = self.groups.remove(gi);
            log!(self.cfg, "closing tab group {} ({} tabs)", g.id, g.tabs.len());
            let targets: Vec<target::TargetId> = g.tabs.iter_mut().filter_map(|t| {
                let tid = t.target.clone();
                t.detach();
                tid
            }).collect();
            // Its waiters (none should be left: it is not shown) must not wait for 120 s.
            let gid = g.id.clone();
            let (gone, kept): (Vec<_>, Vec<_>) = self.select_waiters.drain(..).partition(|(w, _)| *w == gid);
            self.select_waiters = kept;
            for (_, w) in gone {
                let _ = w.send(Err("this browser was closed".into()));
            }
            if let Some(c) = self.chrome.as_mut() {
                if let Some(b) = c.browser.clone() {
                    c.bg.spawn(async move {
                        for t in targets {
                            let _ = run_b(&b, target::CloseTargetParams::new(t)).await;
                        }
                    });
                }
            }
            self.push_state(false);
        }
    }

    async fn on_req(&mut self, cid: u64, name: String, rid: serde_json::Value, op: String, args: serde_json::Value) {
        let Some((out, gid, terminal)) = self.peers.get(&cid).map(|p| (p.out.clone(), p.group.clone(), p.terminal.clone())) else { return };
        if !op_allowed(Role::Agent, &op) {
            return reply(&out, rid, Err(format!("{op} is not allowed for agents")));
        }
        // A frozen page would not answer: wake every tab before the op runs.
        self.sleep_check().await;
        let gi = self.agent_group(&gid, terminal, &name).await;
        self.groups[gi].inflight += 1;
        self.agent_mark(&name, 1);
        let done = |s: &mut Self, r: Result<serde_json::Value, String>| {
            reply(&out, rid.clone(), r);
            s.req_done(&name, &gid);
        };
        match op.as_str() {
            "tabs" => {
                let r = self.op_tabs(gi, &args).await;
                done(self, r);
            }
            "select_element" => {
                if self.outbox.lock().map(|g| g.is_none()).unwrap_or(true) {
                    return done(self, Err("select_element needs the herdr Browser panel open: the user picks the element there".into()));
                }
                if gi != self.shown_idx() {
                    return done(self, Err("select_element needs the herdr Browser panel to show your tabs; it shows another browser now (it follows the herdr tab the user looks at)".into()));
                }
                if !self.selecting {
                    self.set_select(true).await;
                }
                if !self.selecting {
                    return done(self, Err("Select element could not start".into()));
                }
                let (tx, rx) = oneshot::channel();
                self.select_waiters.retain(|(_, w)| !w.is_closed());
                self.select_waiters.push((gid.clone(), tx));
                let ev = self.ev_tx.clone();
                tokio::spawn(async move {
                    let r = match tokio::time::timeout(agent::timeout_for("select_element"), rx).await {
                        Ok(Ok(r)) => r.map(|xml| serde_json::json!({ "xml": xml })),
                        Ok(Err(_)) => Err("Select element was cancelled".into()),
                        Err(_) => {
                            let _ = ev.send(Ev::SelectGiveUp);
                            Err("no element was picked within 120 s".into())
                        }
                    };
                    reply(&out, rid, r);
                    let _ = ev.send(Ev::ReqDone(name, gid));
                });
            }
            _ => {
                let ctx = match self.op_ctx(gi, &args) {
                    Ok(c) => c,
                    Err(e) => return done(self, Err(e)),
                };
                if let (true, Some(u)) = (op == "navigate", args["url"].as_str()) {
                    let id = args["tab"].as_u64().map(|i| i as u32).or(self.groups[gi].active);
                    if let Some(id) = id {
                        self.note_navigate(id, &normalize_url(u));
                        self.push_state(false);
                    }
                }
                let ev = self.ev_tx.clone();
                tokio::spawn(async move {
                    let t = agent::timeout_for(&op);
                    let r = match tokio::time::timeout(t, agent::run(ctx, &op, args)).await {
                        Ok(r) => r,
                        Err(_) => Err(format!("{op} timed out after {} s", t.as_secs())),
                    };
                    reply(&out, rid, r);
                    let _ = ev.send(Ev::ReqDone(name, gid));
                });
            }
        }
    }

    /// A request from a `ui` client. `args` of import_cookies carry cookie values: never logged.
    async fn on_ui_req(&mut self, out: ClientOut, rid: serde_json::Value, op: String, args: serde_json::Value) {
        if !op_allowed(Role::Ui, &op) {
            return reply(&out, rid, Err(format!("{op} is not allowed for this client")));
        }
        match op.as_str() {
            "reload" => {
                let gi = self.group_index(USER_GROUP).unwrap_or(0);
                match self.groups[gi].active {
                    Some(id) => {
                        self.act.input();
                        self.queue(id, InputOp::Reload);
                        reply(&out, rid, Ok(serde_json::json!({})));
                    }
                    None => reply(&out, rid, Err("no tab is open".into())),
                }
            }
            _ => {
                let Some(b) = self.chrome.as_ref().and_then(|c| c.browser.clone()) else {
                    return reply(&out, rid, Err("the browser is starting; try again in a moment".into()));
                };
                tokio::spawn(async move {
                    let mut args = args;
                    let r = import_cookies(&b, &mut args).await;
                    reply(&out, rid, r);
                });
            }
        }
    }

    // ------------------------------------------------------------ dispatch

    async fn on_cmd(&mut self, c: Cmd) {
        match c {
            Cmd::Connect { id, out } => {
                // The role comes with the first message: `hello` = panel, `agent` = agent.
                self.peers.insert(id, Peer { out, ui: false, agent: None, group: String::new(), terminal: None });
                self.last_client = Instant::now();
                log!(self.cfg, "client {id} connected");
            }
            Cmd::Disconnect { id } => {
                let was = self
                    .outbox
                    .lock()
                    .map(|mut g| {
                        if g.as_ref().map(|(i, _)| *i) == Some(id) {
                            *g = None;
                            true
                        } else {
                            false
                        }
                    })
                    .unwrap_or(false);
                if self.peers.remove(&id).is_some() {
                    log!(self.cfg, "client {id} disconnected");
                    self.last_client = Instant::now();
                }
                if was {
                    log!(self.cfg, "client {id} disconnected");
                    self.last_client = Instant::now();
                    self.stop_screencast();
                    if self.selecting {
                        self.set_select(false).await;
                    }
                    self.cancel_select("the Browser panel closed before a pick");
                }
                self.sleep_check().await;
            }
            Cmd::BadMessage { id, err } => {
                if self.is_current(id) {
                    self.error(err);
                } else if let Some(p) = self.peers.get(&id) {
                    p.out.send(&ServerMsg::Error { message: err });
                }
            }
            Cmd::Client { id, msg } => {
                if self.is_current(id) {
                    match msg {
                        ClientMsg::Agent { .. } | ClientMsg::Req { .. } | ClientMsg::Ui { .. } => self.error("the panel cannot send agent messages"),
                        m => self.on_client(m).await,
                    }
                    return;
                }
                let Some(p) = self.peers.get_mut(&id) else { return };
                if p.ui {
                    let out = p.out.clone();
                    match msg {
                        ClientMsg::Req { id: rid, op, args } => self.on_ui_req(out, rid, op, args).await,
                        _ => out.send(&ServerMsg::Error { message: "ui clients send {t:\"req\", id, op, args}".into() }),
                    }
                    return;
                }
                match (msg, p.agent.clone()) {
                    // `hello` makes a panel; so does any other panel message sent before it (the
                    // panel may send navigate/visible before it knows its size).
                    (ClientMsg::Ui { .. }, None) => {
                        p.ui = true;
                        let out = p.out.clone();
                        out.send(&ServerMsg::State(self.state_for(USER_GROUP, true)));
                    }
                    (m, None) if !matches!(m, ClientMsg::Agent { .. } | ClientMsg::Req { .. }) => {
                        // A new panel replaces only the old panel; dropping its sender closes it.
                        let Some(p) = self.peers.remove(&id) else { return };
                        if let Ok(mut g) = self.outbox.lock() {
                            *g = Some((id, p.out));
                        }
                        self.on_client(m).await;
                    }
                    (ClientMsg::Agent { name, terminal, .. }, None) => {
                        let name = name.map(|n| n.trim().chars().take(64).collect::<String>()).filter(|n| !n.is_empty());
                        let name = name.unwrap_or_else(|| "agent".into());
                        let (group, terminal) = agent_group_key(&name, terminal.as_deref());
                        p.agent = Some(name);
                        p.group = group.clone();
                        p.terminal = terminal;
                        let out = p.out.clone();
                        out.send(&ServerMsg::State(self.state_for(&group, false)));
                        self.sleep_check().await;
                    }
                    (ClientMsg::Req { id: rid, op, args }, Some(name)) => self.on_req(id, name, rid, op, args).await,
                    (_, None) => p.out.send(&ServerMsg::Error { message: "send {t:\"agent\", v:1, name} before requests".into() }),
                    (_, Some(_)) => p.out.send(&ServerMsg::Error { message: "agents send {t:\"req\", id, op, args}".into() }),
                }
            }
            Cmd::Probe(p) => self.on_probe(p).await,
            Cmd::Shutdown => {}
        }
    }

    fn is_current(&self, id: u64) -> bool {
        self.outbox.lock().map(|g| g.as_ref().map(|(i, _)| *i) == Some(id)).unwrap_or(false)
    }

    async fn apply_view(&mut self, v: View) {
        let changed = v != self.view;
        self.view = v;
        if changed {
            self.act.viewport();
            // One task, newest view wins: detached per-change tasks could land out of order and
            // leave a page at an older size.
            if let Some(h) = self.metrics.take() {
                h.abort();
            }
            let pages: Vec<Page> = self.all_tabs().filter_map(|t| t.page.clone()).collect();
            self.metrics = Some(tokio::spawn(async move {
                for p in pages {
                    let _ = set_metrics(&p, v).await;
                }
            }));
        }
    }

    async fn on_client(&mut self, msg: ClientMsg) {
        if matches!(
            msg,
            ClientMsg::Navigate { .. } | ClientMsg::Back | ClientMsg::Forward | ClientMsg::Reload | ClientMsg::Mouse(_) | ClientMsg::Key { .. } | ClientMsg::Text { .. } | ClientMsg::Tab { .. } | ClientMsg::Select { .. } | ClientMsg::Show { .. }
        ) {
            self.act.input();
        }
        match msg {
            ClientMsg::Hello { w, h, scale } => {
                let v = View::from_parts(w, h, scale, self.view);
                self.apply_view(v).await;
                self.visible = true;
                // Wake frozen tabs before the cast starts on one.
                self.sleep_check().await;
                self.start_screencast();
                self.push_state(true);
            }
            ClientMsg::Viewport { w, h, scale } => {
                let v = View::from_parts(w, h, scale, self.view);
                if v != self.view {
                    self.apply_view(v).await;
                    self.start_screencast();
                }
            }
            ClientMsg::Visible { on } => {
                // Already showing: a restart here races Stop against Start and can end the cast.
                if on && self.visible {
                    return;
                }
                self.visible = on;
                if on {
                    self.sleep_check().await;
                    self.start_screencast();
                } else {
                    self.stop_screencast();
                    self.sleep_check().await;
                }
            }
            ClientMsg::Navigate { url } => {
                let url = normalize_url(&url);
                if let Some(id) = self.active() {
                    self.note_navigate(id, &url);
                }
                self.queue_active(InputOp::Navigate(url));
                self.push_state(false);
            }
            ClientMsg::Back => self.queue_active(InputOp::Back),
            ClientMsg::Forward => self.queue_active(InputOp::Forward),
            ClientMsg::Reload => self.queue_active(InputOp::Reload),
            ClientMsg::Mouse(m) => self.queue_active(InputOp::Mouse(m)),
            ClientMsg::Key { key, char, mods } => {
                self.queue_active(InputOp::Key { key, ch: char, mods: mods.unwrap_or_default(), agent: false })
            }
            ClientMsg::Text { text } => self.queue_active(InputOp::Text(text)),
            // Tab ops apply to the shown group only.
            ClientMsg::Tab { op, id, url } => {
                let gi = self.shown_idx();
                let mine = |s: &Self, id: u32| s.group_of(id) == Some(gi);
                match op {
                    TabOp::New => {
                        if let Err(e) = self.tab_new(gi, url).await {
                            self.error(e);
                        }
                    }
                    TabOp::Close => {
                        if let Some(id) = id.or(self.active()).filter(|&i| mine(self, i)) {
                            self.tab_remove(id, true).await;
                        }
                    }
                    TabOp::Select => {
                        if let Some(id) = id.filter(|&i| mine(self, i)) {
                            self.tab_select(id).await;
                        }
                    }
                }
            }
            ClientMsg::Select { on } => self.set_select(on).await,
            ClientMsg::Show { group } => self.show(&group).await,
            ClientMsg::Agent { .. } | ClientMsg::Req { .. } | ClientMsg::Ui { .. } => {}
        }
    }

    async fn on_probe(&mut self, p: Probe) {
        let page = self.active_tab().and_then(|t| t.page.clone());
        match p {
            Probe::Eval { expr, reply } => {
                let r = match page {
                    Some(p) => eval(&p, &expr).await,
                    None => Err("no page".into()),
                };
                let _ = reply.send(r);
            }
            Probe::BoxCenter { selector, reply } => {
                let r = match page {
                    Some(p) => box_center(&p, &selector).await,
                    None => Err("no page".into()),
                };
                let _ = reply.send(r);
            }
            Probe::Flush { reply } => match self.active_tab().and_then(|t| t.input.as_ref()) {
                Some(tx) => {
                    let _ = tx.send(InputOp::Flush(reply));
                }
                None => {
                    let _ = reply.send(());
                }
            },
            Probe::Crash { reply } => {
                if let Some(p) = page {
                    tokio::spawn(async move {
                        let _ = tokio::time::timeout(CDP_TIMEOUT, p.execute(page::CrashParams::default())).await;
                    });
                }
                let _ = reply.send(());
            }
            Probe::PageTargets { reply } => {
                let n = match self.browser() {
                    Some(b) => run_b(b, target::GetTargetsParams::default())
                        .await
                        .map(|r| r.target_infos.iter().filter(|t| t.r#type == "page").count())
                        .unwrap_or(usize::MAX),
                    None => usize::MAX,
                };
                let _ = reply.send(n);
            }
            Probe::Windows { reply } => {
                use chromiumoxide::cdp::browser_protocol::browser;
                let mut out = Vec::new();
                for g in &self.groups {
                    for t in &g.tabs {
                        let Some(p) = &t.page else { continue };
                        if let Ok(w) = run(p, browser::GetWindowForTargetParams { target_id: Some(p.target_id().clone()) }).await {
                            out.push((g.id.clone(), t.id, *w.window_id.inner()));
                        }
                    }
                }
                let _ = reply.send(out);
            }
            Probe::Stats { reply } => {
                let _ = reply.send(Stats {
                    frames_received: self.counters.received.load(Ordering::Relaxed),
                    frames_acked: self.counters.acked.load(Ordering::Relaxed),
                    frames_written: self.counters.written.load(Ordering::Relaxed),
                    frames_dropped: self.counters.dropped.load(Ordering::Relaxed),
                    chrome_pid: self.chrome.as_ref().and_then(|c| c.pid),
                    launches: self.launches,
                });
            }
        }
    }

    async fn on_ev(&mut self, e: Ev) {
        let cur = self.gen;
        match e {
            Ev::Died(g) => {
                if g == cur && self.chrome.is_some() {
                    self.on_died().await;
                }
            }
            Ev::Health(g, ok) => {
                self.health_inflight = false;
                if g != cur || self.chrome.is_none() {
                    return;
                }
                if ok {
                    self.health_fail = 0;
                } else {
                    self.health_fail += 1;
                    if self.health_fail >= 2 {
                        self.on_died().await;
                    }
                }
            }
            Ev::Relaunch => {
                self.relaunch_pending = false;
                if self.chrome.is_some() {
                    return;
                }
                if let Err(e) = self.launch().await {
                    eprintln!("[herdr-browser] relaunch failed: {e}");
                    self.error(format!("Browser restart failed: {e}"));
                    self.schedule_relaunch();
                }
            }
            Ev::TargetCreated(g, tid, opener) => {
                if g != cur || self.ignore_targets.contains(&tid) || self.tab_by_target(&tid).is_some() {
                    return;
                }
                let ev = self.ev_tx.clone();
                let Some(c) = self.chrome.as_mut() else { return };
                let Some(b) = c.browser.clone() else { return };
                // The handler attaches to new targets asynchronously; retry briefly off the loop.
                c.bg.spawn(async move {
                    for _ in 0..20 {
                        if let Ok(Ok(p)) = tokio::time::timeout(Duration::from_millis(500), b.get_page(tid.clone())).await {
                            let _ = ev.send(Ev::PageReady(g, p, opener));
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                });
            }
            Ev::PageReady(g, p, opener) => {
                if g != cur || self.ignore_targets.contains(p.target_id()) || self.tab_by_target(p.target_id()).is_some() {
                    return;
                }
                // A popup joins its opener's group, so an agent's popups stay its own.
                let gi = opener
                    .as_ref()
                    .and_then(|o| self.tab_by_target(o))
                    .and_then(|t| self.group_of(t.id))
                    .unwrap_or_else(|| self.shown_idx());
                let shown = gi == self.shown_idx();
                log!(self.cfg, "adopting new page target {:?} as a tab of {}", p.target_id(), self.groups[gi].id);
                if self.groups[gi].tabs.len() >= MAX_TABS {
                    if let Some(b) = self.browser() {
                        let _ = run_b(b, target::CloseTargetParams::new(p.target_id().clone())).await;
                    }
                    if shown {
                        self.error(format!("At most {MAX_TABS} tabs; popup closed"));
                    }
                    return;
                }
                if shown && self.selecting {
                    self.set_select(false).await;
                }
                let id = self.alloc_tab();
                let url = p.url().await.ok().flatten().unwrap_or_default();
                self.groups[gi].tabs.push(Tab::new(id, &url));
                self.attach(id, p).await;
                self.groups[gi].active = Some(id);
                if shown {
                    self.start_screencast();
                }
                self.push_state(false);
            }
            Ev::TargetInfo(g, tid, url, title) => {
                if g != cur {
                    return;
                }
                if let Some(t) = self.groups.iter_mut().flat_map(|g| g.tabs.iter_mut()).find(|t| t.target.as_ref() == Some(&tid)) {
                    t.url = url;
                    t.title = title;
                }
                self.push_state(false);
            }
            Ev::TargetGone(g, tid) => {
                if g != cur {
                    return;
                }
                if let Some(id) = self.tab_by_target(&tid).map(|t| t.id) {
                    self.tab_remove(id, false).await;
                }
            }
            Ev::Loading(g, id, on) => {
                if g != cur {
                    return;
                }
                let mut recast = false;
                if let Some(t) = self.tab_mut(id) {
                    t.loading = on;
                    if !on && t.recast_on_load {
                        t.recast_on_load = false;
                        recast = true;
                    }
                }
                if recast && self.active() == Some(id) {
                    self.start_screencast();
                }
                if self.active() == Some(id) {
                    self.act.set_loading(on);
                }
                self.push_state(false);
            }
            Ev::NavChanged(g, id) => {
                if g != cur {
                    return;
                }
                let Some(page) = self.tab(id).and_then(|t| t.page.clone()) else { return };
                let ev = self.ev_tx.clone();
                if let Some(c) = self.chrome.as_mut() {
                    c.bg.spawn(async move {
                        if let Ok(h) = run(&page, page::GetNavigationHistoryParams::default()).await {
                            let i = h.current_index.max(0) as usize;
                            let cur = h.entries.get(i);
                            let _ = ev.send(Ev::History {
                                gen: g,
                                tab: id,
                                url: cur.map(|e| e.url.clone()).unwrap_or_default(),
                                title: cur.map(|e| e.title.clone()).unwrap_or_default(),
                                back: i > 0,
                                fwd: i + 1 < h.entries.len(),
                            });
                        }
                    });
                }
            }
            Ev::History { gen, tab, url, title, back, fwd } => {
                if gen != cur {
                    return;
                }
                if let Some(t) = self.tab_mut(tab) {
                    if !url.is_empty() {
                        t.url = url;
                    }
                    if !title.is_empty() {
                        t.title = title;
                    }
                    t.can_back = back;
                    t.can_forward = fwd;
                }
                self.push_state(false);
            }
            Ev::Inspect(g, id, backend) => {
                if g != cur || !self.selecting || self.active() != Some(id) {
                    return;
                }
                let Some(tab) = self.active_tab() else { return };
                let Some(page) = tab.page.clone() else { return };
                let url = tab.url.clone();
                let cfg = self.cfg.clone();
                let ev = self.ev_tx.clone();
                // Not cancel_select: this group's waiters are owed the capture's result.
                self.selecting = false;
                let gid = self.shown.clone();
                self.capturing = Some(gid.clone());
                self.push_state(false);
                tokio::spawn(async move {
                    let r = select::capture(&page, backend, &url, &cfg).await;
                    let _ = ev.send(Ev::Selected(gid, r));
                });
            }
            Ev::Crashed(g, tid) => {
                if g == cur {
                    self.on_crashed(tid).await;
                }
            }
            Ev::Selected(gid, r) => {
                if self.capturing.as_deref() == Some(gid.as_str()) {
                    self.capturing = None;
                }
                let for_agents = match &r {
                    Ok(s) => std::fs::read_to_string(self.cfg.app_home.join(&s.xml_rel)).map_err(|e| e.to_string()),
                    Err(e) => Err(e.clone()),
                };
                // Only the agents of the group the pick was made in: another group's agent never
                // sees this page.
                let (mine, rest): (Vec<_>, Vec<_>) = self.select_waiters.drain(..).partition(|(g, _)| *g == gid);
                self.select_waiters = rest;
                for (_, w) in mine {
                    let _ = w.send(for_agents.clone());
                }
                match r {
                    Ok(s) => emit(
                        &self.outbox,
                        &ServerMsg::Selected { xml: s.xml_rel, png: s.png_rel, summary: s.summary },
                    ),
                    Err(e) => self.error(format!("Select element: {e}")),
                }
            }
            Ev::ReqDone(name, gid) => self.req_done(&name, &gid),
            Ev::SelectGiveUp => {
                if self.selecting && self.select_waiters.iter().all(|(_, w)| w.is_closed()) {
                    self.set_select(false).await;
                }
            }
        }
    }
}

async fn box_center(page: &Page, selector: &str) -> Result<(f64, f64), String> {
    let doc = run(page, dom::GetDocumentParams { depth: Some(0), ..Default::default() }).await?;
    let node = run(page, dom::QuerySelectorParams::new(doc.root.node_id, selector)).await?;
    let m = run(page, dom::GetBoxModelParams { node_id: Some(node.node_id), ..Default::default() }).await?;
    let q = m.model.content.inner();
    if q.len() < 8 {
        return Err("bad quad".into());
    }
    Ok(((q[0] + q[2] + q[4] + q[6]) / 4.0, (q[1] + q[3] + q[5] + q[7]) / 4.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_cookies_is_for_the_ui_role_only() {
        assert!(!op_allowed(Role::Agent, "import_cookies"));
        assert!(op_allowed(Role::Agent, "navigate"));
        assert!(op_allowed(Role::Agent, "reload"));
        assert!(op_allowed(Role::Ui, "import_cookies"));
        assert!(op_allowed(Role::Ui, "reload"));
        assert!(!op_allowed(Role::Ui, "navigate"));
        assert!(!op_allowed(Role::Ui, "javascript"));
        assert!(!op_allowed(Role::Ui, "tabs"));
    }

    #[test]
    fn local_urls_are_never_frozen() {
        assert!(is_local_url("http://localhost:3000/x"));
        assert!(is_local_url("http://127.0.0.1:5173"));
        assert!(is_local_url("http://[::1]:8080/"));
        assert!(is_local_url("http://app.localhost/"));
        assert!(is_local_url("http://user@LOCALHOST/"));
        assert!(!is_local_url("https://example.com/localhost"));
        assert!(!is_local_url("data:text/html,localhost"));
        assert!(!is_local_url("about:blank"));
        assert!(!is_local_url("https://127.example.com/"));
    }

    #[test]
    fn eviction_picks_the_least_recently_used_free_agent_group() {
        let g = |agent, secs, pinned| GroupAge { agent, idle: Duration::from_secs(secs), pinned, connected: false };
        let c = |secs| GroupAge { agent: true, idle: Duration::from_secs(secs), pinned: false, connected: true };
        let ttl = Duration::from_secs(1800);
        // Over the cap: a disconnected group goes before an older connected one; with only
        // connected ones left, the oldest of those.
        assert_eq!(evict_pick(&[g(false, 0, false), c(500), g(true, 10, false)], 1, ttl), Some(2));
        assert_eq!(evict_pick(&[g(false, 0, false), c(500), c(10)], 1, ttl), Some(1));
        // The TTL never closes a group an agent is connected to.
        assert_eq!(evict_pick(&[g(false, 0, false), c(4000)], 8, ttl), None);
        // Under the cap and nothing idle past the TTL: keep everything.
        assert_eq!(evict_pick(&[g(false, 9999, false), g(true, 10, false), g(true, 20, false)], 2, ttl), None);
        // Over the cap: the oldest free agent group, never the user's however old.
        assert_eq!(evict_pick(&[g(false, 9999, false), g(true, 10, false), g(true, 20, false)], 1, ttl), Some(2));
        // Shown or busy (pinned) groups are skipped; all pinned → over the cap.
        assert_eq!(evict_pick(&[g(false, 0, false), g(true, 10, false), g(true, 20, true)], 1, ttl), Some(1));
        assert_eq!(evict_pick(&[g(false, 0, false), g(true, 10, true), g(true, 20, true)], 1, ttl), None);
        // Past the TTL: closed even under the cap, unless pinned.
        assert_eq!(evict_pick(&[g(false, 0, false), g(true, 1800, false)], 8, ttl), Some(1));
        assert_eq!(evict_pick(&[g(false, 0, false), g(true, 4000, true)], 8, ttl), None);
    }

    #[test]
    fn agent_groups_key_on_terminal_then_name() {
        assert_eq!(agent_group_key("claude-code", Some("t7")), ("t:t7".into(), Some("t7".into())));
        assert_eq!(agent_group_key("claude-code", Some("  t7\n")), ("t:t7".into(), Some("t7".into())));
        assert_eq!(agent_group_key("codex", None), ("n:codex".into(), None));
        assert_eq!(agent_group_key("codex", Some("  ")), ("n:codex".into(), None));
        // No agent can ever resolve to the panel's group.
        assert_ne!(agent_group_key("user", None).0, USER_GROUP);
        assert_ne!(agent_group_key("x", Some("user")).0, USER_GROUP);
        assert_eq!(agent_group_key("x", Some(&"t".repeat(200))).1.map(|t| t.len()), Some(64));
    }
}
