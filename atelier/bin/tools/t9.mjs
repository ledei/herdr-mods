// T9's MCP tools, as entries of bin/atelier-mcp.mjs's TOOLS table: atelier_version (replaces the entry of that name:
// adds a whole-checkpoint restore and compare) and atelier_variants. run() needs the server's private helpers, so
// this is a factory: Object.assign(TOOLS, t9Tools({ api, qs, canvasOf, ToolError, CANVAS, BOARD })).
export function t9Tools({ api, qs, canvasOf, ToolError, CANVAS, BOARD }) {
  const TS = { type: 'string', maxLength: 40, description: 'A snapshot ts from list' };
  return {
    atelier_version: {
      description: 'Lists a board\'s snapshots and the canvas checkpoints, makes a named checkpoint of every board, restores one board to a snapshot '
        + 'or every board to a checkpoint, or shows an old snapshot beside the board in the panel as a read-only board (compare). '
        + 'Use when about to make a risky change, when the user wants an earlier version back, or to show what changed. '
        + 'Returns {versions, checkpoints}, the new checkpoint, the restored file and sha, {restored, unchanged, missing, before} for a checkpoint, or {shown} for compare. '
        + 'Restoring a board needs its current sha as expectSha; restoring a checkpoint first makes one of how things are now (before), so it can be undone.',
      props: {
        canvas: CANVAS, action: { type: 'string', enum: ['list', 'checkpoint', 'restore', 'compare'] }, file: BOARD,
        ts: TS, checkpoint: { type: 'string', maxLength: 40, description: 'restore: a checkpoint id, instead of file and ts' },
        label: { type: 'string', maxLength: 120, description: 'checkpoint: its name' }, expectSha: { type: 'string', maxLength: 64 },
      },
      required: ['action'],
      run: async (a) => {
        const canvas = await canvasOf(a);
        if (a.action === 'list') return api('GET', `/__agent/versions?${qs({ canvas, file: a.file })}`);
        if (a.action === 'checkpoint') return api('POST', '/__agent/checkpoint', { canvas, label: a.label });
        if (a.action === 'compare') return api('POST', '/__agent/version', { canvas, action: 'compare', file: a.file, ts: a.ts });
        if (a.checkpoint) return api('POST', '/__agent/version', { canvas, action: 'restoreCheckpoint', id: a.checkpoint });
        if (!a.file || !a.ts) throw new ToolError('atelier_version restore needs file and ts, or checkpoint.');
        return api('POST', '/__agent/restore', { canvas, file: a.file, ts: a.ts, expectSha: a.expectSha });
      },
    },
    atelier_variants: {
      description: 'Lists the variant groups (base, labels, the picked one, prop variants with their place), marks the variant the user picked, '
        + 'moves a variant to the Archive page, or shows one board once more with other Tweaks as a prop variant (prop, unprop). '
        + 'Use when the user chooses between variants, wants the others out of the way, or wants to compare scenarios of one board side by side. '
        + 'Returns {groups}, or what changed. '
        + 'Archive moves a board, it never deletes one; make new variants with atelier_board op variant.',
      props: {
        canvas: CANVAS, action: { type: 'string', enum: ['list', 'pick', 'archive', 'prop', 'unprop'] }, file: BOARD,
        props: { type: 'object', description: 'prop: the Tweaks (data-props) values for this view, at most 4 KB' },
        label: { type: 'string', maxLength: 20, description: 'prop: its label (default A1, A2, …); unprop: the one to remove' },
        group: { type: 'string', maxLength: 40, description: 'unprop: the group id' },
      },
      required: ['action'],
      run: async ({ canvas, ...rest }) => api('POST', '/__agent/variants', { canvas: await canvasOf({ canvas }), ...rest }),
    },
  };
}
