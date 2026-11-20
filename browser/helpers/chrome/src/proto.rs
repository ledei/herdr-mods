//! JSON protocol between the herdr panel and the sidecar (text frames over WebSocket).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Mods {
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub platform: bool,
}

impl Mods {
    /// CDP modifier bit field: Alt=1, Ctrl=2, Meta/Command=4, Shift=8.
    pub fn cdp_bits(&self) -> i64 {
        (self.alt as i64) | (self.control as i64) << 1 | (self.platform as i64) << 2 | (self.shift as i64) << 3
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MouseKind {
    Down,
    Up,
    Move,
    Wheel,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MouseMsg {
    #[serde(rename = "type")]
    pub kind: MouseKind,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub button: Option<Button>,
    #[serde(default)]
    pub clicks: Option<i64>,
    #[serde(default)]
    pub dx: Option<f64>,
    #[serde(default)]
    pub dy: Option<f64>,
    #[serde(default)]
    pub mods: Option<Mods>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabOp {
    New,
    Close,
    Select,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientMsg {
    Hello {
        #[serde(default)]
        w: Option<f64>,
        #[serde(default)]
        h: Option<f64>,
        #[serde(default)]
        scale: Option<f64>,
    },
    Viewport {
        #[serde(default)]
        w: Option<f64>,
        #[serde(default)]
        h: Option<f64>,
        #[serde(default)]
        scale: Option<f64>,
    },
    Visible {
        on: bool,
    },
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Mouse(MouseMsg),
    Key {
        key: String,
        #[serde(default)]
        char: Option<String>,
        #[serde(default)]
        mods: Option<Mods>,
    },
    Text {
        text: String,
    },
    Tab {
        op: TabOp,
        #[serde(default)]
        id: Option<u32>,
        #[serde(default)]
        url: Option<String>,
    },
    Select {
        on: bool,
    },
    /// Which tab group the panel shows: "user" (its own) or an agent's group id from `groups`.
    Show {
        group: String,
    },
    /// First message of an agent client (an AI tool); the panel's first message is `hello`.
    Agent {
        #[serde(default)]
        v: Option<u32>,
        #[serde(default)]
        name: Option<String>,
        /// The agent's herdr terminal (`HC_TERMINAL_ID`): its tab group. Absent: the name.
        #[serde(default)]
        terminal: Option<String>,
    },
    /// First message of a `ui` client (the user's own tools, e.g. `cookies import`): it may send
    /// only the `import_cookies` and `reload` requests.
    Ui {
        #[serde(default)]
        v: Option<u32>,
    },
    /// An agent request: answered by exactly one `{t:"res", id, ...}`.
    Req {
        #[serde(default)]
        id: serde_json::Value,
        #[serde(default)]
        op: String,
        #[serde(default)]
        args: serde_json::Value,
    },
}

pub fn parse_client(text: &str) -> Result<ClientMsg, String> {
    serde_json::from_str(text).map_err(|e| format!("bad message: {e}"))
}

/// Viewport in CSS px plus device scale factor, clamped to sane values.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

impl Default for View {
    fn default() -> Self {
        View { w: 1280.0, h: 800.0, scale: 2.0 }
    }
}

impl View {
    pub fn from_parts(w: Option<f64>, h: Option<f64>, scale: Option<f64>, prev: View) -> View {
        let fix = |v: Option<f64>, d: f64, lo: f64, hi: f64| match v {
            Some(v) if v.is_finite() && v > 0.0 => v.clamp(lo, hi),
            _ => d,
        };
        View {
            w: fix(w, prev.w, 64.0, 8192.0).round(),
            h: fix(h, prev.h, 64.0, 8192.0).round(),
            scale: fix(scale, prev.scale, 0.5, 4.0),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TabInfo {
    pub id: u32,
    pub title: String,
    pub url: String,
    pub active: bool,
}

/// One tab group: the panel's own ("user") or one agent terminal's.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GroupInfo {
    pub id: String,
    /// "user" or "agent".
    pub owner: String,
    /// The agent's terminal id (HC_TERMINAL_ID); null for "user" and for agents without one.
    pub terminal: Option<String>,
    /// The last agent name seen for this group; null for "user".
    pub name: Option<String>,
    pub tabs: Vec<TabInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StateMsg {
    pub connected: bool,
    pub url: String,
    pub title: String,
    pub loading: bool,
    #[serde(rename = "canBack")]
    pub can_back: bool,
    #[serde(rename = "canForward")]
    pub can_forward: bool,
    pub tabs: Vec<TabInfo>,
    pub selecting: bool,
    /// Name of the agent acting now or in the last 20 s; null otherwise.
    pub agent: Option<String>,
    /// The group shown (url, title, tabs above are its active tab and its tabs).
    pub group: String,
    /// Every group: "user" first, then agent groups, most recently active first.
    pub groups: Vec<GroupInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerMsg {
    /// `ts`: when Chrome drew the frame (ms since the epoch; 0 if unknown).
    Frame { path: String, seq: u64, w: f64, h: f64, ts: f64, sy: f64 },
    State(StateMsg),
    Selected { xml: String, png: String, summary: String },
    Error { message: String },
    Res {
        id: serde_json::Value,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl ServerMsg {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"t\":\"error\",\"message\":\"encode\"}".into())
    }
}

/// Turn what the user typed in the URL bar into a URL.
pub fn normalize_url(input: &str) -> String {
    let s = input.trim();
    if s.is_empty() {
        return "about:blank".into();
    }
    let lower = s.to_ascii_lowercase();
    for p in ["http://", "https://", "about:", "data:", "file://", "chrome://", "view-source:"] {
        if lower.starts_with(p) {
            return s.to_string();
        }
    }
    let host_like = !s.contains(char::is_whitespace)
        && (s.contains('.') || lower.starts_with("localhost") || s.starts_with("127.") || s.contains(':'));
    if host_like {
        let local = lower.starts_with("localhost") || s.starts_with("127.") || s.starts_with("0.0.0.0");
        return format!("{}{}", if local { "http://" } else { "https://" }, s);
    }
    format!("https://www.google.com/search?q={}", pct_encode(s))
}

pub fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hello_and_viewport() {
        assert_eq!(
            parse_client(r#"{"t":"hello","w":800,"h":600,"scale":2}"#).unwrap(),
            ClientMsg::Hello { w: Some(800.0), h: Some(600.0), scale: Some(2.0) }
        );
        assert!(matches!(parse_client(r#"{"t":"viewport","w":10}"#).unwrap(), ClientMsg::Viewport { .. }));
    }

    #[test]
    fn parses_unit_variants_and_ignores_extra_fields() {
        assert_eq!(parse_client(r#"{"t":"back"}"#).unwrap(), ClientMsg::Back);
        assert_eq!(parse_client(r#"{"t":"forward","junk":1}"#).unwrap(), ClientMsg::Forward);
        assert_eq!(parse_client(r#"{"t":"reload"}"#).unwrap(), ClientMsg::Reload);
    }

    #[test]
    fn parses_mouse() {
        let m = parse_client(
            r#"{"t":"mouse","type":"down","x":10.5,"y":20,"button":"right","clicks":2,"mods":{"shift":true}}"#,
        )
        .unwrap();
        match m {
            ClientMsg::Mouse(m) => {
                assert_eq!(m.kind, MouseKind::Down);
                assert_eq!(m.x, 10.5);
                assert_eq!(m.button, Some(Button::Right));
                assert_eq!(m.clicks, Some(2));
                assert!(m.mods.unwrap().shift);
            }
            other => panic!("{other:?}"),
        }
        let w = parse_client(r#"{"t":"mouse","type":"wheel","x":1,"y":2,"dx":0,"dy":-120,"mods":null}"#).unwrap();
        assert!(matches!(w, ClientMsg::Mouse(MouseMsg { kind: MouseKind::Wheel, dy: Some(d), .. }) if d == -120.0));
    }

    #[test]
    fn parses_key_text_tab_select() {
        assert_eq!(
            parse_client(r#"{"t":"key","key":"a","char":"a","mods":{"platform":true}}"#).unwrap(),
            ClientMsg::Key {
                key: "a".into(),
                char: Some("a".into()),
                mods: Some(Mods { platform: true, ..Default::default() })
            }
        );
        assert_eq!(parse_client(r#"{"t":"text","text":"åäö@"}"#).unwrap(), ClientMsg::Text { text: "åäö@".into() });
        assert_eq!(
            parse_client(r#"{"t":"tab","op":"select","id":3}"#).unwrap(),
            ClientMsg::Tab { op: TabOp::Select, id: Some(3), url: None }
        );
        assert_eq!(parse_client(r#"{"t":"select","on":true}"#).unwrap(), ClientMsg::Select { on: true });
        assert_eq!(parse_client(r#"{"t":"visible","on":false}"#).unwrap(), ClientMsg::Visible { on: false });
        assert_eq!(
            parse_client(r#"{"t":"agent","v":1,"name":"codex"}"#).unwrap(),
            ClientMsg::Agent { v: Some(1), name: Some("codex".into()), terminal: None }
        );
        assert_eq!(
            parse_client(r#"{"t":"agent","v":1,"name":"codex","terminal":"t7"}"#).unwrap(),
            ClientMsg::Agent { v: Some(1), name: Some("codex".into()), terminal: Some("t7".into()) }
        );
        assert_eq!(parse_client(r#"{"t":"show","group":"user"}"#).unwrap(), ClientMsg::Show { group: "user".into() });
        assert!(parse_client(r#"{"t":"show"}"#).is_err());
        assert_eq!(
            parse_client(r#"{"t":"req","id":3,"op":"tabs","args":{"action":"list"}}"#).unwrap(),
            ClientMsg::Req { id: 3.into(), op: "tabs".into(), args: serde_json::json!({"action":"list"}) }
        );
    }

    #[test]
    fn rejects_bad_messages() {
        assert!(parse_client("not json").is_err());
        assert!(parse_client(r#"{"t":"nope"}"#).is_err());
        assert!(parse_client(r#"{"t":"navigate"}"#).is_err());
        assert!(parse_client(r#"{"t":"mouse","type":"hover"}"#).is_err());
    }

    #[test]
    fn serializes_server_messages() {
        let f = ServerMsg::Frame { path: "data/herdr-browser/frames/7.jpg".into(), seq: 7, w: 800.0, h: 600.0, ts: 0.0, sy: 0.0 };
        let v: serde_json::Value = serde_json::from_str(&f.to_json()).unwrap();
        assert_eq!(v["t"], "frame");
        assert_eq!(v["seq"], 7);
        let s = ServerMsg::State(StateMsg {
            connected: true,
            url: "u".into(),
            title: "t".into(),
            loading: false,
            can_back: true,
            can_forward: false,
            tabs: vec![TabInfo { id: 1, title: "t".into(), url: "u".into(), active: true }],
            selecting: false,
            agent: None,
            group: "user".into(),
            groups: vec![GroupInfo { id: "user".into(), owner: "user".into(), terminal: None, name: None, tabs: vec![] }],
        });
        let v: serde_json::Value = serde_json::from_str(&s.to_json()).unwrap();
        assert_eq!(v["t"], "state");
        assert_eq!(v["canBack"], true);
        assert_eq!(v["canForward"], false);
        assert_eq!(v["tabs"][0]["active"], true);
        assert!(v.as_object().unwrap().contains_key("agent") && v["agent"].is_null());
        assert_eq!(v["group"], "user");
        assert_eq!(v["groups"][0]["owner"], "user");
        assert!(v["groups"][0]["terminal"].is_null());
        let r: serde_json::Value = serde_json::from_str(
            &ServerMsg::Res { id: 7.into(), ok: false, data: None, error: Some("x".into()) }.to_json(),
        )
        .unwrap();
        assert_eq!((r["t"].as_str(), r["id"].as_i64(), r["ok"].as_bool(), r["error"].as_str()), (Some("res"), Some(7), Some(false), Some("x")));
        assert!(r.get("data").is_none());
        let e: serde_json::Value = serde_json::from_str(&ServerMsg::Error { message: "x".into() }.to_json()).unwrap();
        assert_eq!(e["t"], "error");
    }

    #[test]
    fn mods_bits() {
        assert_eq!(Mods::default().cdp_bits(), 0);
        assert_eq!(Mods { alt: true, control: true, platform: true, shift: true }.cdp_bits(), 15);
        assert_eq!(Mods { platform: true, ..Default::default() }.cdp_bits(), 4);
        assert_eq!(Mods { shift: true, ..Default::default() }.cdp_bits(), 8);
    }

    #[test]
    fn view_clamps() {
        let v = View::from_parts(Some(800.4), Some(-5.0), Some(f64::NAN), View::default());
        assert_eq!(v, View { w: 800.0, h: 800.0, scale: 2.0 });
        assert_eq!(View::from_parts(Some(1e9), None, Some(9.0), View::default()).w, 8192.0);
    }

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("example.com"), "https://example.com");
        assert_eq!(normalize_url("localhost:3000"), "http://localhost:3000");
        assert_eq!(normalize_url("https://a.b/c"), "https://a.b/c");
        assert_eq!(normalize_url("about:blank"), "about:blank");
        assert_eq!(normalize_url("rust lang"), "https://www.google.com/search?q=rust%20lang");
        assert_eq!(normalize_url("  "), "about:blank");
    }
}
