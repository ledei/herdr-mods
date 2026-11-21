// T12's tool for bin/atelier-mcp.mjs: atelier_record, an entry in the shape of its TOOLS table. A factory, since the
// helpers it calls live inside atelier-mcp.mjs:
//   Object.assign(TOOLS, t12Tools({ api, canvasOf, CANVAS, BOARD }));
export function t12Tools({ api, canvasOf, CANVAS, BOARD }) {
  return {
    atelier_record: {
      description: 'Films a board for 2-10 s: PNG frames every ~200 ms, a filmstrip contact sheet and an event log (clicks with the element hit, state keys that changed, animations started and finished, errors, each at t ms), '
        + 'plus video.mp4 and video.gif when ffmpeg is installed; steps as in atelier_play run during the recording. '
        + 'Use when judging motion or a transition, or to show the user how a flow plays. '
        + 'Returns {dir, frames, filmstrip, events (the events.json path), video?, gif?, anchors (the clicked elements), timeline (the first events), steps?, runner}; the files are under <canvas>/.atelier/shots/rec-<ts>/. '
        + 'Live films the board as it is in the panel; headless starts from the board\'s start state, so pass the steps that lead to the moment you want.',
      props: {
        canvas: CANVAS, board: BOARD,
        seconds: { type: 'number', minimum: 2, maximum: 10, description: 'How long to film, default 5' },
        steps: { type: 'array', maxItems: 50, description: 'Steps as in atelier_play, run while filming', items: { type: 'object' } },
        runner: { type: 'string', enum: ['live', 'headless'], description: 'Default live when the panel is open, else headless' },
      },
      required: ['board'],
      run: async ({ canvas, ...rest }) => api('POST', '/__agent/record', { canvas: await canvasOf({ canvas }), ...rest }),
    },
  };
}
