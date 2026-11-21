// Atelier's colours and small UI atoms. From herdr-figcraft-atelier: dark uses the design boards' values; light maps
// the same roles onto herdr's theme().
import { div, svg } from "gpui-kit";
import { theme, settings } from "herdr";

const ACCENT = "#02da96", ACCENT_INK = "#07352a";

const DARK = {
  panel: "#1e1e1e", frame: "#2a2c30", head: "#17191d", line: "#222428", text: "#e6e6e7", muted: "#98999b", soft: "#a9aaad",
  faint: "#55575c", item: "#262629", ghostLine: "#555555", bar: "#2c2c2c", barLine: "#444444", group: "#383838",
  tool: "#d4d4d4", accent: ACCENT, accentInk: ACCENT_INK,
};

export function palette() {
  if (settings().dark !== false) return DARK;
  const t = theme();
  return {
    panel: t.background, frame: t.border, head: t.chrome, line: t.border, text: t.foreground, muted: t.muted, soft: t.muted,
    faint: t.dim, item: t.hover, ghostLine: t.input, bar: t.popover, barLine: t.border, group: t.raised,
    tool: t.foreground, accent: ACCENT, accentInk: ACCENT_INK,
  };
}

export const icon = (name, size = 16) => svg(`mods/atelier/icons/${name}.svg`).size(size).flex_none();

// A square icon button (28 px, icon 15).
export function iconButton(id, name, label, action, { size = 28, iconSize = 15 } = {}) {
  const c = palette();
  return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8)
    .text_color(c.muted).hover((s) => s.bg(c.item).text_color(c.text)).tooltip(label).accessibility_label(label)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
    .child(icon(name, iconSize));
}
