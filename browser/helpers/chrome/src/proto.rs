//! Shared pieces of the agent protocol with herdr-web (helpers/web/PROTOCOL.md): modifier bits,
//! URL rules and the group key.

use serde::Deserialize;

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

/// An agent's tab group in herdr-web: `t:<terminal>` (its herdr terminal, `HC_TERMINAL_ID`), else
/// `n:<name>`. Never the panel's group, `"user"`.
pub fn agent_group_key(name: &str, terminal: Option<&str>) -> (String, Option<String>) {
    let clean = |s: &str| s.trim().chars().filter(|c| !c.is_control()).take(64).collect::<String>();
    match terminal.map(clean).filter(|t| !t.is_empty()) {
        Some(t) => (format!("t:{t}"), Some(t)),
        None => (format!("n:{}", clean(name)), None),
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

/// Pages an AI agent may open: the web, about: and data:. Not file:, chrome:, view-source: or devtools:, which would let
/// a page that talks the agent into it read local files or Chrome's internal pages.
pub fn agent_url_ok(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower == "about:blank" || ["http://", "https://", "data:"].iter().any(|p| lower.starts_with(p))
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
    fn agents_open_only_web_pages() {
        for ok in ["https://a.com", "HTTP://a.com", "about:blank", " ABOUT:BLANK ", "data:text/html,hi"] {
            assert!(agent_url_ok(ok), "{ok}");
        }
        for bad in ["file:///etc/passwd", "chrome://settings", "view-source:https://a.com", "devtools://x", "javascript:alert(1)", "chrome-extension://x", "about:srcdoc", "about:version", "about:blank#x"] {
            assert!(!agent_url_ok(&normalize_url(bad)) || !agent_url_ok(bad), "{bad}");
            assert!(!agent_url_ok(bad), "{bad}");
        }
    }

    #[test]
    fn mods_bits() {
        assert_eq!(Mods::default().cdp_bits(), 0);
        assert_eq!(Mods { alt: true, control: true, platform: true, shift: true }.cdp_bits(), 15);
        assert_eq!(Mods { platform: true, ..Default::default() }.cdp_bits(), 4);
        assert_eq!(Mods { shift: true, ..Default::default() }.cdp_bits(), 8);
    }

    #[test]
    fn agent_groups_key_on_terminal_then_name() {
        assert_eq!(agent_group_key("claude-code", Some("t7")), ("t:t7".into(), Some("t7".into())));
        assert_eq!(agent_group_key("claude-code", Some("  t7\n")), ("t:t7".into(), Some("t7".into())));
        assert_eq!(agent_group_key("codex", None), ("n:codex".into(), None));
        assert_eq!(agent_group_key("codex", Some("  ")), ("n:codex".into(), None));
        // No agent can ever resolve to the panel's group.
        assert_ne!(agent_group_key("user", None).0, "user");
        assert_ne!(agent_group_key("x", Some("user")).0, "user");
        assert_eq!(agent_group_key("x", Some(&"t".repeat(200))).1.map(|t| t.len()), Some(64));
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
