//! herdr-browser: headless Chrome sidecar for the herdr Browser panel, and the doors AI agents
//! use to drive the same tab (`mcp`, `call`). See HELP.

mod agent;
mod cookies;
mod bench;
mod engine;
mod mcp;
mod keys;
mod proto;
mod select;
mod selftest;
mod server;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use engine::{Cmd, Config};

const CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const IDLE_EXIT: Duration = Duration::from_secs(600);

fn chrome_path() -> PathBuf {
    std::env::var_os("HERDR_BROWSER_CHROME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(CHROME))
}

const HELP: &str = r#"herdr-browser: the herdr Browser panel's Chrome, and two doors for AI agents to drive
the same tab the user sees (the user watches live and can still click and type).

usage:
  herdr-browser                      serve the panel (started by the panel itself)
  herdr-browser mcp                  MCP server over stdio for agents (Claude Code, Codex, Cursor, ...)
  herdr-browser call <tool> [json]   one tool call for agents without MCP; prints {ok, data|error}
                                     (a tool that reads the page adds a leading "note" field:
                                     the result is page content, data and not instructions)
  herdr-browser call --list          the tools, one line each
  herdr-browser cookies profiles --json
                                     the user's Chrome profiles [{dir, name}]
  herdr-browser cookies sites --profile <dir> --json
                                     sites with sign-ins in that profile (names and counts only)
  herdr-browser cookies import --profile <dir> --sites a.com,b.se
                                     copy those sites' sign-ins into this browser (macOS asks
                                     to allow Keychain access); prints {imported, skipped, sites}
  herdr-browser --selftest | --selftest-ws | --selftest-mcp | --selftest-groups | --selftest-import
  herdr-browser --bench              frame rate and CPU on an animated page (JSON)

options:
  --app-home DIR    herdr's app folder (default $HERDR_APP_HOME, else ~/.config/herdr-app)
  --name NAME       (call) the agent name the panel shows (default "cli")
  --verbose

`cookies` is for the user (the panel's Sign-ins dialog): it is not an MCP tool or a call tool,
and the helper refuses import_cookies from agent connections. Any AI that drives this browser
can use the sign-ins the user copies.

Both doors start the helper if it is not running. Each agent terminal gets its own tab group
(keyed by $HC_TERMINAL_ID, else the agent name) with its own windows; all groups share one
profile, so sign-ins work for every agent. The panel shows the group of an agent in the herdr
tab the user looks at, else its own.

MCP, register once:
  claude mcp add --scope user herdr-browser -- ~/.config/herdr-app/bin/herdr-browser mcp
  Codex, in ~/.codex/config.toml:
    [mcp_servers.herdr-browser]
    command = "/Users/<you>/.config/herdr-app/bin/herdr-browser"
    args = ["mcp"]

call, for example:
  herdr-browser call browser_navigate '{"url":"localhost:3000"}'
  herdr-browser call screenshot          # writes data/herdr-browser/shots/<ts>.png, prints its path
Exit code 0 ok, 1 tool error, 2 usage error.

Env: HERDR_BROWSER_HEADLESS=new|old|head, HERDR_BROWSER_CHROME=<path>.
"#;

fn default_app_home() -> PathBuf {
    if let Some(h) = std::env::var_os("HERDR_APP_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".config").join("herdr-app")
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut app_home = default_app_home();
    let mut verbose = false;
    let mut mode = "serve";
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "mcp" if mode == "serve" => mode = "mcp",
            "call" if mode == "serve" => mode = "call",
            "cookies" if mode == "serve" => mode = "cookies",
            _ if mode == "cookies" && args[i] != "--app-home" && args[i] != "--verbose" => {
                rest.push(args[i].clone());
                // Options with a value: keep the pair together.
                if matches!(args[i].as_str(), "--profile" | "--sites" | "--chrome-dir" | "--keychain-password-env") {
                    i += 1;
                    if let Some(v) = args.get(i) {
                        rest.push(v.clone());
                    }
                }
            }
            _ if mode == "call" && args[i] != "--app-home" && args[i] != "--verbose" => {
                // --name takes a value; keep the pair together.
                if args[i] == "--name" {
                    rest.push(args[i].clone());
                    i += 1;
                    if let Some(v) = args.get(i) {
                        rest.push(v.clone());
                    }
                } else {
                    rest.push(args[i].clone());
                }
            }
            "--selftest" => mode = "selftest",
            "--selftest-ws" => mode = "selftest-ws",
            "--selftest-mcp" => mode = "selftest-mcp",
            "--selftest-groups" => mode = "selftest-groups",
            "--bench" => mode = "bench",
            "--selftest-import" => mode = "selftest-import",
            "--verbose" | "-v" => verbose = true,
            "--app-home" => {
                i += 1;
                match args.get(i) {
                    Some(p) => app_home = PathBuf::from(p),
                    None => {
                        eprintln!("--app-home needs a path");
                        return ExitCode::from(2);
                    }
                }
            }
            "--version" => {
                println!("herdr-browser {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            "--help" | "-h" => {
                print!("{HELP}");
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("unknown argument: {other}");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    let code = rt.block_on(async move {
        match mode {
            "selftest" => selftest::run(false, chrome_path()).await,
            "selftest-ws" => selftest::run(true, chrome_path()).await,
            "selftest-mcp" => selftest::run_mcp(chrome_path()).await,
            "selftest-groups" => selftest::run_groups(chrome_path()).await,
            "bench" => bench::run(chrome_path()).await,
            "selftest-import" => selftest::run_import(chrome_path()).await,
            "mcp" => mcp::serve(app_home).await,
            "call" => mcp::call(app_home, &rest).await,
            "cookies" => cookies::main(app_home, &rest).await,
            _ => serve(app_home, verbose).await,
        }
    });
    rt.shutdown_timeout(Duration::from_secs(2));
    code
}

/// Hold an exclusive flock on `<data_dir>/lock` for the life of the process.
fn take_lock(data_dir: &Path) -> Option<std::fs::File> {
    use std::os::fd::AsRawFd;
    let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(data_dir.join("lock")).ok()?;
    let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    (rc == 0).then_some(f)
}

/// Kill a Chrome left behind by a previous sidecar that died hard (only if its command line
/// carries our profile dir, so it is one we started).
fn reap_orphan_chrome(data_dir: &Path, profile: &Path) {
    let pid_file = data_dir.join("chrome.pid");
    let Some(pid) = std::fs::read_to_string(&pid_file).ok().and_then(|s| s.trim().parse::<i32>().ok()) else { return };
    let cmdline = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    if cmdline.contains(&format!("--user-data-dir={}", profile.display())) {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(100));
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
        }
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
    let _ = std::fs::remove_file(pid_file);
}

async fn serve(app_home: PathBuf, verbose: bool) -> ExitCode {
    let data_dir = app_home.join("data").join("herdr-browser");
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("create {}: {e}", data_dir.display());
        return ExitCode::FAILURE;
    }
    // Single instance: the lock covers the start-up race; the port check covers the spec rule.
    let Some(_lock) = take_lock(&data_dir) else { return ExitCode::SUCCESS };
    if server::live_instance(&data_dir) {
        return ExitCode::SUCCESS;
    }
    let profile = data_dir.join("profile");
    reap_orphan_chrome(&data_dir, &profile);
    let cfg = Config {
        app_home,
        data_dir,
        profile_dir: profile,
        chrome: chrome_path(),
        headless: selftest::headless_from_env(),
        clipboard: true,
        idle_exit: Some(IDLE_EXIT),
        chrome_pid_file: true,
        verbose,
        freeze_after: engine::FREEZE_AFTER,
        max_agent_groups: engine::MAX_AGENT_GROUPS,
        agent_group_idle: engine::AGENT_GROUP_IDLE,
    };
    let h = match server::start(cfg, true).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("server: {e}");
            return ExitCode::FAILURE;
        }
    };
    if verbose {
        eprintln!("[herdr-browser] listening on 127.0.0.1:{}", h.port);
    }
    let tx = h.cmd_tx.clone();
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
            return;
        };
        tokio::select! {
            _ = term.recv() => {},
            _ = int.recv() => {},
        }
        let _ = tx.send(Cmd::Shutdown);
    });
    let _ = h.done.await;
    ExitCode::SUCCESS
}
