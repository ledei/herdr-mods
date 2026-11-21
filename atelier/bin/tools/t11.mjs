// T11's tool for bin/atelier-mcp.mjs: atelier_props, an entry in the shape of its TOOLS table. A factory, since the
// helpers it calls (api, canvasOf and the shared schemas) live inside atelier-mcp.mjs:
//   Object.assign(TOOLS, t11Tools({ api, canvasOf, CANVAS, BOARD }));
export function t11Tools({ api, canvasOf, CANVAS, BOARD }) {
  return {
    atelier_props: {
      description: 'Reads a board\'s Tweaks (its data-props: each key\'s editor, options and default) and the values in effect, previews other values live on the board in the panel, '
        + 'saves values as the file\'s defaults, or resets the preview. '
        + 'Use when showing a scenario or start point (start, persona, stage, a mock on/off key), or when the user wants a Tweak kept as the default. '
        + 'Returns {meta, values, changed, presets?, sha, runner} ("source" when Atelier is closed), or {sha, changed} after persist. '
        + 'Set and reset change only the live view and need the panel open; persist writes only the data-props attribute, needs expectSha and keeps to the user\'s locked scope unless outOfScope says why.',
      props: {
        canvas: CANVAS, board: BOARD,
        action: { type: 'string', enum: ['get', 'set', 'persist', 'reset'], description: 'Default get' },
        values: { type: 'object', description: 'set and persist: {key: value}, e.g. {"start": "Steg 2 · vad"}; each value one the key\'s editor takes' },
        expectSha: { type: 'string', maxLength: 64, description: 'persist: the board\'s sha from get; a stale one is refused' },
        outOfScope: { type: 'string', maxLength: 300, description: 'persist under a locked scope: why the user wants this default changed' },
      },
      required: ['board'],
      run: async ({ canvas, ...rest }) => api('POST', '/__agent/props', { canvas: await canvasOf({ canvas }), ...rest }),
    },
  };
}
