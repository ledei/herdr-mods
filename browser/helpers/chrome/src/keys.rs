//! Mapping from GPUI key names (as the panel sends them) to CDP key events.

use crate::proto::Mods;

/// A named (non-printable) key as CDP wants it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyDef {
    pub key: &'static str,
    pub code: &'static str,
    pub vk: i64,
    /// Text for the keyDown (only Enter has one); None means rawKeyDown.
    pub text: Option<&'static str>,
    /// macOS editing commands Chrome should run for this key with these modifiers.
    pub commands: Vec<&'static str>,
}

/// What a `{t:"key"}` message turns into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    /// Printable text, sent with Input.insertText.
    Text(String),
    /// Named key: keyDown/rawKeyDown then keyUp.
    Named(KeyDef),
    /// Editing chord (cmd/ctrl + a/c/x/z/y): keyDown with `commands`, then keyUp.
    Command { command: &'static str, key: String, code: String, vk: i64 },
    /// cmd/ctrl+v: read the system clipboard and insert it as text.
    Paste,
    /// Any other modifier chord: plain keyDown/keyUp with modifiers so page shortcuts work.
    Chord { key: String, code: String, vk: i64 },
    Ignore,
}

fn base(name: &str) -> Option<(&'static str, &'static str, i64)> {
    Some(match name {
        "enter" | "return" => ("Enter", "Enter", 13),
        "backspace" => ("Backspace", "Backspace", 8),
        "tab" => ("Tab", "Tab", 9),
        "escape" | "esc" => ("Escape", "Escape", 27),
        "delete" => ("Delete", "Delete", 46),
        "left" => ("ArrowLeft", "ArrowLeft", 37),
        "up" => ("ArrowUp", "ArrowUp", 38),
        "right" => ("ArrowRight", "ArrowRight", 39),
        "down" => ("ArrowDown", "ArrowDown", 40),
        "home" => ("Home", "Home", 36),
        "end" => ("End", "End", 35),
        "pageup" => ("PageUp", "PageUp", 33),
        "pagedown" => ("PageDown", "PageDown", 34),
        _ => return None,
    })
}

/// macOS editing commands (the same table Playwright uses on mac, trimmed).
fn mac_commands(key: &str, m: &Mods) -> Vec<&'static str> {
    let (s, a, c) = (m.shift, m.alt, m.platform);
    let one = |x: &'static str| vec![x];
    match key {
        "Backspace" if c => one("deleteToBeginningOfLine"),
        "Backspace" if a => one("deleteWordBackward"),
        "Backspace" => one("deleteBackward"),
        "Delete" if a => one("deleteWordForward"),
        "Delete" => one("deleteForward"),
        "ArrowLeft" if c && s => one("moveToBeginningOfLineAndModifySelection"),
        "ArrowLeft" if c => one("moveToBeginningOfLine"),
        "ArrowLeft" if a && s => one("moveWordLeftAndModifySelection"),
        "ArrowLeft" if a => one("moveWordLeft"),
        "ArrowLeft" if s => one("moveLeftAndModifySelection"),
        "ArrowLeft" => one("moveLeft"),
        "ArrowRight" if c && s => one("moveToEndOfLineAndModifySelection"),
        "ArrowRight" if c => one("moveToEndOfLine"),
        "ArrowRight" if a && s => one("moveWordRightAndModifySelection"),
        "ArrowRight" if a => one("moveWordRight"),
        "ArrowRight" if s => one("moveRightAndModifySelection"),
        "ArrowRight" => one("moveRight"),
        "ArrowUp" if c && s => one("moveToBeginningOfDocumentAndModifySelection"),
        "ArrowUp" if c => one("moveToBeginningOfDocument"),
        "ArrowUp" if s => one("moveUpAndModifySelection"),
        "ArrowUp" => one("moveUp"),
        "ArrowDown" if c && s => one("moveToEndOfDocumentAndModifySelection"),
        "ArrowDown" if c => one("moveToEndOfDocument"),
        "ArrowDown" if s => one("moveDownAndModifySelection"),
        "ArrowDown" => one("moveDown"),
        "Home" if s => one("moveToBeginningOfDocumentAndModifySelection"),
        "Home" => one("scrollToBeginningOfDocument"),
        "End" if s => one("moveToEndOfDocumentAndModifySelection"),
        "End" => one("scrollToEndOfDocument"),
        "PageUp" if s => one("pageUpAndModifySelection"),
        "PageUp" => one("scrollPageUp"),
        "PageDown" if s => one("pageDownAndModifySelection"),
        "PageDown" => one("scrollPageDown"),
        _ => vec![],
    }
}

pub fn named_key(name: &str, mods: &Mods) -> Option<KeyDef> {
    let (key, code, vk) = base(&name.to_ascii_lowercase())?;
    Some(KeyDef {
        key,
        code,
        vk,
        text: if key == "Enter" { Some("\r") } else { None },
        commands: mac_commands(key, mods),
    })
}

/// DOM `code` and Windows virtual key code for a single printable character.
pub fn char_code(c: char) -> (String, i64) {
    let u = c.to_ascii_uppercase();
    if u.is_ascii_alphabetic() {
        (format!("Key{u}"), u as i64)
    } else if c.is_ascii_digit() {
        (format!("Digit{c}"), c as i64)
    } else {
        let (code, vk) = match c {
            ' ' => ("Space", 32),
            '-' => ("Minus", 189),
            '=' => ("Equal", 187),
            '[' => ("BracketLeft", 219),
            ']' => ("BracketRight", 221),
            ';' => ("Semicolon", 186),
            '\'' => ("Quote", 222),
            ',' => ("Comma", 188),
            '.' => ("Period", 190),
            '/' => ("Slash", 191),
            '\\' => ("Backslash", 220),
            '`' => ("Backquote", 192),
            _ => ("", 0),
        };
        (code.to_string(), vk)
    }
}

/// Classify a `{t:"key", key, char?, mods}` message.
pub fn classify(key: &str, ch: Option<&str>, mods: &Mods) -> KeyAction {
    let lower = key.to_lowercase();
    let single = {
        let mut it = lower.chars();
        match (it.next(), it.next()) {
            (Some(c), None) => Some(c),
            _ => None,
        }
    };
    if mods.platform || mods.control {
        if let Some(c) = single {
            let (code, vk) = char_code(c);
            let k = c.to_string();
            let cmd = match c {
                'a' => Some("selectAll"),
                'c' => Some("copy"),
                'x' => Some("cut"),
                'z' if mods.shift => Some("redo"),
                'z' => Some("undo"),
                'y' => Some("redo"),
                'v' => return KeyAction::Paste,
                _ => None,
            };
            return match cmd {
                Some(command) => KeyAction::Command { command, key: k, code, vk },
                None => KeyAction::Chord { key: k, code, vk },
            };
        }
        if let Some(def) = named_key(&lower, mods) {
            return KeyAction::Named(def);
        }
        return KeyAction::Ignore;
    }
    if let Some(def) = named_key(&lower, mods) {
        return KeyAction::Named(def);
    }
    if lower == "space" {
        return KeyAction::Text(" ".into());
    }
    if let Some(c) = ch.filter(|c| !c.is_empty() && !c.chars().any(char::is_control)) {
        return KeyAction::Text(c.to_string());
    }
    if key.chars().count() == 1 && !key.chars().any(char::is_control) {
        let t = if mods.shift { key.to_uppercase() } else { key.to_string() };
        return KeyAction::Text(t);
    }
    KeyAction::Ignore
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m() -> Mods {
        Mods::default()
    }
    fn cmd() -> Mods {
        Mods { platform: true, ..Default::default() }
    }

    #[test]
    fn enter_has_text_and_vk13() {
        let KeyAction::Named(d) = classify("enter", None, &m()) else { panic!() };
        assert_eq!((d.key, d.code, d.vk, d.text), ("Enter", "Enter", 13, Some("\r")));
        assert!(d.commands.is_empty());
    }

    #[test]
    fn named_key_codes() {
        let cases = [
            ("backspace", "Backspace", 8),
            ("tab", "Tab", 9),
            ("escape", "Escape", 27),
            ("delete", "Delete", 46),
            ("left", "ArrowLeft", 37),
            ("up", "ArrowUp", 38),
            ("right", "ArrowRight", 39),
            ("down", "ArrowDown", 40),
            ("home", "Home", 36),
            ("end", "End", 35),
            ("pageup", "PageUp", 33),
            ("pagedown", "PageDown", 34),
        ];
        for (name, key, vk) in cases {
            let KeyAction::Named(d) = classify(name, None, &m()) else { panic!("{name}") };
            assert_eq!((d.key, d.vk), (key, vk), "{name}");
            assert_eq!(d.text, None, "{name} should be rawKeyDown");
        }
    }

    #[test]
    fn mac_editing_commands() {
        assert_eq!(named_key("backspace", &m()).unwrap().commands, vec!["deleteBackward"]);
        let alt = Mods { alt: true, ..Default::default() };
        assert_eq!(named_key("backspace", &alt).unwrap().commands, vec!["deleteWordBackward"]);
        let shift = Mods { shift: true, ..Default::default() };
        assert_eq!(named_key("left", &shift).unwrap().commands, vec!["moveLeftAndModifySelection"]);
        assert_eq!(named_key("right", &cmd()).unwrap().commands, vec!["moveToEndOfLine"]);
        assert!(named_key("tab", &m()).unwrap().commands.is_empty());
    }

    #[test]
    fn printable_goes_to_text() {
        assert_eq!(classify("a", Some("a"), &m()), KeyAction::Text("a".into()));
        assert_eq!(classify("a", Some("A"), &Mods { shift: true, ..m() }), KeyAction::Text("A".into()));
        assert_eq!(classify("a", None, &Mods { shift: true, ..m() }), KeyAction::Text("A".into()));
        assert_eq!(classify("2", Some("@"), &Mods { alt: true, ..m() }), KeyAction::Text("@".into()));
        assert_eq!(classify("å", Some("å"), &m()), KeyAction::Text("å".into()));
        assert_eq!(classify("space", Some(" "), &m()), KeyAction::Text(" ".into()));
        assert_eq!(classify("f13", None, &m()), KeyAction::Ignore);
    }

    #[test]
    fn editing_chords() {
        let c = |k: &str, mods: Mods| classify(k, None, &mods);
        assert!(matches!(c("a", cmd()), KeyAction::Command { command: "selectAll", vk: 65, .. }));
        assert!(matches!(c("c", cmd()), KeyAction::Command { command: "copy", .. }));
        assert!(matches!(c("x", cmd()), KeyAction::Command { command: "cut", .. }));
        assert!(matches!(c("z", cmd()), KeyAction::Command { command: "undo", .. }));
        assert!(matches!(c("z", Mods { shift: true, ..cmd() }), KeyAction::Command { command: "redo", .. }));
        assert!(matches!(c("y", cmd()), KeyAction::Command { command: "redo", .. }));
        assert_eq!(c("v", cmd()), KeyAction::Paste);
        let ctrl = Mods { control: true, ..m() };
        assert!(matches!(c("a", ctrl), KeyAction::Command { command: "selectAll", .. }));
        match c("k", cmd()) {
            KeyAction::Chord { key, code, vk } => assert_eq!((key.as_str(), code.as_str(), vk), ("k", "KeyK", 75)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn char_codes() {
        assert_eq!(char_code('a'), ("KeyA".into(), 65));
        assert_eq!(char_code('7'), ("Digit7".into(), 55));
        assert_eq!(char_code(' '), ("Space".into(), 32));
    }
}
