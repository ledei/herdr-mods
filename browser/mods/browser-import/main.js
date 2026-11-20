// Import sign-ins: copies the cookies of sites the person picks from one of their Chrome profiles into the
// herdr browser. Opened as a dialog by the browser panel's Sign-ins pill with props { open: [hosts] } (the
// hosts open in its tabs, pre-ticked). Every step runs the helper's CLI, never an agent tool:
//   herdr-browser cookies profiles --json                       -> [{dir, name}]
//   herdr-browser cookies sites --profile <dir> --json          -> [{site, cookies, expires_latest}]
//   herdr-browser cookies import --profile <dir> --sites a,b    -> {imported, skipped, sites}
// The import asks macOS for Chrome's Keychain entry, so it waits on the person: no short timeout.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, appHome, checking, props, closeOverlay, theme, setShared } from "herdr";

const DIALOG = "herdr-browser.dialog"; // "<ms>" while this dialog is open, "closed" after: the native page window sits above Herdr, so the panel hides it meanwhile
const IMPORTED = "herdr-browser.imported"; // the panel reloads its tab when this changes
const MAX_ROWS = 300;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Runs the CLI; its JSON on success, else an Error with the reason it printed.
async function cli(args, timeout) {
  const r = await exec(`${appHome()}/bin/herdr-browser`, ["cookies", ...args], { timeout });
  const out = (r.stdout ?? "").trim(), err = (r.stderr ?? "").trim();
  let data;
  try { data = JSON.parse(out); } catch {}
  if (r.code !== 0 || data === undefined || data?.error) {
    const why = data?.error ?? err.split("\n").filter(Boolean).pop() ?? out;
    throw new Error(why || `herdr-browser exited with ${r.code}`);
  }
  return data;
}

// A site row is "open now" when a tab's host is the site or under it (a.b.example.com for example.com).
const opens = (site, hosts) => {
  const s = String(site).replace(/^\./, "").toLowerCase();
  return hosts.some((h) => h === s || h.endsWith(`.${s}`));
};

export default class Import extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (!checking()) setShared(DIALOG, String(Date.now()));
    this.step = "profiles"; // profiles -> sites -> run -> done | error
    this.profiles = undefined; // undefined: loading
    this.sites = undefined;
    this.picked = new Set();
    this.req = 0; // bumped by every profile or sites load: a late answer to an older one is dropped
    this.at = 0;
    this.error = "";
    this.filter = InputState.new({ placeholder: "Filter sites" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.filter.on("focus", (_e, cx) => { this.filterFocused = true; cx.notify(); });
    this.filter.on("blur", (_e, cx) => { this.filterFocused = false; cx.notify(); });
    if (checking()) { this.profiles = []; return; }
    this.loadProfiles(cx);
  }

  hosts() {
    return (props()?.open ?? []).map((h) => String(h).toLowerCase());
  }

  close() {
    try { setShared(DIALOG, "closed"); } catch {}
    closeOverlay(props().overlay);
  }

  loadProfiles(cx) {
    const req = ++this.req;
    this.step = "profiles";
    this.profiles = undefined;
    this.sites = undefined;
    this.picked = new Set();
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      let list, error = "";
      try { list = await cli(["profiles", "--json"], 30_000); } catch (e) { error = e.message; }
      if (req !== this.req) return;
      this.profiles = Array.isArray(list) ? list.filter((p) => p && p.dir) : [];
      this.error = error;
      this.at = 0;
      cx.notify();
    });
  }

  pickProfile(p, cx) {
    if (!p) return;
    const req = ++this.req;
    this.profile = p;
    this.step = "sites";
    this.sites = undefined;
    this.picked = new Set(); // only ever sites ticked in this profile's own list
    this.error = "";
    this.filter.set_value("");
    cx.notify();
    cx.spawn(async (cx) => {
      let list, error = "";
      try { list = await cli(["sites", "--profile", p.dir, "--json"], 60_000); } catch (e) { error = e.message; }
      if (req !== this.req || this.profile !== p) return;
      if (error) { this.sites = []; this.error = error; }
      else {
        this.sites = Array.isArray(list) ? list.filter((s) => s && s.site) : [];
        const hosts = this.hosts();
        this.picked = new Set(this.sites.filter((s) => opens(s.site, hosts)).map((s) => s.site));
      }
      cx.notify();
      cx.timer.after(50, () => this.filter.focus());
    });
  }

  // The sites step can copy only once this profile's list has loaded without an error.
  canCopy() {
    if (this.step === "sites" && (!Array.isArray(this.sites) || this.error)) return false;
    return this.picked.size > 0 && Boolean(this.profile);
  }

  copy(cx) {
    const sites = [...this.picked];
    if (!this.canCopy()) return;
    this.step = "run";
    this.error = "";
    this.handle.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await cli(["import", "--profile", this.profile.dir, "--sites", sites.join(","), ...(props()?.native ? ["--target", "native"] : [])], 600_000);
        this.copied = Array.isArray(r?.sites) ? r.sites.length : typeof r?.sites === "number" ? r.sites : sites.length;
        this.step = "done";
        setShared(IMPORTED, Date.now());
      } catch (e) { this.error = e.message; this.step = "error"; }
      cx.notify();
    });
  }

  toggle(site, cx) {
    if (this.picked.has(site)) this.picked.delete(site);
    else this.picked.add(site);
    cx.notify();
  }

  shownSites() {
    const f = this.filter.value().trim().toLowerCase();
    return (this.sites ?? []).filter((s) => !f || String(s.site).toLowerCase().includes(f));
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (this.step === "profiles") {
      const n = this.profiles?.length ?? 0;
      if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else if (e.key === "enter") this.pickProfile(this.profiles?.[this.at], cx);
      else return;
    } else if (this.step === "sites" && e.key === "enter" && !this.filterFocused) this.copy(cx);
    else if (this.step === "done" && e.key === "enter") return this.close();
    else if (this.step === "error" && e.key === "enter") this.copy(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const button = (id, label, primary, enabled, onClick) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(!enabled, (el) => el.opacity(0.4))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
      .child(label);
    const title = this.step === "profiles" ? "Import sign-ins" : this.profile ? `Import sign-ins from ${this.profile.name || this.profile.dir}` : "Import sign-ins";
    const n = this.picked.size;
    const footer = h_flex().justify_end().gap(8).text_size(12).flex_none()
      .when(this.step === "sites", (el) => el.child(button("back", "Back", false, true, (_e, cx) => this.loadProfiles(cx))))
      .when(this.step === "error", (el) => el.child(button("back", "Back", false, true, (_e, cx) => { this.step = "sites"; this.error = ""; cx.notify(); })))
      .when(this.step !== "done", (el) => el.child(button("cancel", "Cancel", false, true, () => this.close())))
      .when(this.step === "profiles" && Boolean(this.error), (el) => el.child(button("reload", "Retry", true, true, (_e, cx) => this.loadProfiles(cx))))
      .when(this.step === "sites", (el) => el.child(button("copy", n === 1 ? "Copy 1 site" : `Copy ${n} sites`, true, this.canCopy(), (_e, cx) => this.copy(cx))))
      .when(this.step === "error", (el) => el.child(button("retry", "Retry", true, this.canCopy(), (_e, cx) => this.copy(cx))))
      .when(this.step === "done", (el) => el.child(button("done", "Done", true, true, () => this.close())));
    return v_flex().id("browser-import").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(18).gap(12).rounded(8).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(h_flex().items_center().gap(8).flex_none()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(this.body(t))
      .child(footer);
  }

  body(t) {
    if (this.step === "profiles") return this.profilesView(t);
    if (this.step === "sites") return this.sitesView(t);
    const box = v_flex().flex_1().min_h(0).gap(8).justify_center().items_center().px(12).text_color(t.muted);
    if (this.step === "run") {
      return box.child(div().text_size(18).text_color(t.accent).frames(SPIN, 90))
        .child(div().text_center().child("Waiting for macOS to allow access to Chrome's sign-ins…"))
        .child(div().text_center().text_size(12).text_color(t.dim).child("macOS asks for your password or to allow access to \"Chrome Safe Storage\"."));
    }
    if (this.step === "done") {
      const n = this.copied ?? 0;
      return box.child(svg("mods/browser-import/check.svg").size(22).text_color(t.accent))
        .child(div().text_color(t.foreground).child(`Copied sign-ins for ${n} ${n === 1 ? "site" : "sites"}`))
        .child(div().text_size(12).text_color(t.dim).child("The browser reloads its page."));
    }
    return box.child(div().text_color(t.blocked).text_center().child("Couldn't copy the sign-ins"))
      .child(div().text_center().text_size(12).child(this.error || "Unknown error"));
  }

  profilesView(t) {
    const list = this.profiles;
    const row = (p, i) => v_flex().id(`profile-${i}`).flex_none().h(44).px(10).justify_center().rounded(7).cursor_pointer()
      .when(i === this.at, (el) => el.bg(t.selected))
      .when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.pickProfile(p, cx))
      .child(div().truncate().text_color(t.foreground).child(p.name || p.dir))
      .child(div().truncate().text_size(11.5).text_color(t.dim).child(p.dir));
    return v_flex().flex_1().min_h(0).gap(8)
      .child(div().text_color(t.muted).child("Choose the Chrome profile to copy sign-ins from."))
      .when(list === undefined, (el) => el.child(div().text_color(t.dim).frames(SPIN, 90)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(Array.isArray(list) && !list.length && !this.error, (el) => el.child(div().text_color(t.dim).child("No Chrome profiles found.")))
      .when(Boolean(list?.length), (el) => el.child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("profile-list").size_full().overflow_y_scroll().children(list.map(row)))
        .child(Scrollbar.vertical("profile-list").absolute().inset_0())));
  }

  sitesView(t) {
    const all = this.sites;
    const rows = this.shownSites();
    const hosts = this.hosts();
    const check = (on) => div().size(16).flex_none().flex().items_center().justify_center().rounded(4).border_1()
      .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
      .when(on, (el) => el.child(svg("mods/browser-import/check.svg").size(12).text_color(t.accent_foreground)));
    const row = (s, i) => {
      const on = this.picked.has(s.site);
      const count = Number(s.cookies) || 0;
      return h_flex().id(`site-${i}`).flex_none().h(34).px(8).gap(10).items_center().rounded(6).cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => this.toggle(s.site, cx))
        .child(check(on))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(String(s.site)))
        .when(opens(s.site, hosts), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open now")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(count === 1 ? "1 cookie" : `${count} cookies`));
    };
    const capped = rows.slice(0, MAX_ROWS);
    return v_flex().flex_1().min_h(0).gap(8)
      .child(div().text_size(12).text_color(t.muted).child("Any AI that drives this browser can use the sign-ins you copy."))
      .child(Input.new(this.filter).h(32).px(10).items_center().rounded(6).border(1).flex_none()
        .border_color(this.filterFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .when(all === undefined, (el) => el.child(div().text_color(t.dim).frames(SPIN, 90)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(Array.isArray(all) && !all.length && !this.error, (el) => el.child(div().text_color(t.dim).child("This profile has no sign-ins.")))
      .when(Boolean(all?.length), (el) => el.child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("site-list").size_full().overflow_y_scroll()
          .children(capped.map(row))
          .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching sites.")))
          .when(rows.length > MAX_ROWS, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child(`${rows.length - MAX_ROWS} more: filter to find them.`))))
        .child(Scrollbar.vertical("site-list").absolute().inset_0())))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(all?.length ? `${this.picked.size} of ${all.length} sites picked` : ""));
  }
}
