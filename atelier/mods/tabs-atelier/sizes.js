// The Atelier layout's widths. While Atelier is the shown panel the canvas takes the room: the chat ("main") has a px
// width and the panel a weight (what the chat leaves). With another panel, or none, it is the other way round, so the
// chat fills. Only px versus weight is reconciled, so a width the person dragged stays, and comes back next time.
// No imports: tested in node.

export const CHAT_PX = 360, PANEL_PX = 368;

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}
const px = (n) => (typeof n?.size?.px === "number" ? n.size.px : null);

/** The layout.resize commands that give `tree` the widths it should have, and the remembered px widths
 *  ({chat, panel}) to pass next time. */
export function sizeCmds(tree, mem = {}) {
  const main = find(tree, "main"), panel = find(tree, "panel"), body = find(tree, "panel-body");
  if (!main || !panel || !body) return { cmds: [], mem };
  const active = find(body, body.active ?? body.children?.[0]?.id);
  const canvas = !panel.hidden && active?.content?.mod === "atelier";
  const m = { ...mem, ...(px(main) !== null ? { chat: px(main) } : {}), ...(px(panel) !== null ? { panel: px(panel) } : {}) };
  const cmds = [];
  if (canvas) {
    if (px(main) === null) cmds.push(["layout.resize", { id: "main", px: m.chat ?? CHAT_PX }]);
    if (px(panel) !== null) cmds.push(["layout.resize", { id: "panel", weight: 1 }]);
  } else {
    if (px(panel) === null) cmds.push(["layout.resize", { id: "panel", px: m.panel ?? PANEL_PX }]);
    if (px(main) !== null) cmds.push(["layout.resize", { id: "main", weight: 1 }]);
  }
  return { cmds, mem: m };
}
