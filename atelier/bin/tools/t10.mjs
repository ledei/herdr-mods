// T10's tool for bin/atelier-mcp.mjs: atelier_edit, an entry in the shape of its TOOLS table. A factory, since the
// helpers it calls (api, canvasOf, ToolError and the shared schemas) live inside atelier-mcp.mjs:
//   Object.assign(TOOLS, t10Tools({ api, canvasOf, ToolError, CANVAS, ID }));
export default function t10Tools({ api, canvasOf, ToolError, CANVAS, ID }) {
  return {
    atelier_edit: {
      description: 'Changes elements of a board in place by id: merges CSS into the style attribute, sets text or attributes, removes an element, or moves it before or after a sibling, '
        + 'spliced into the source so every byte you did not name stays as it was, with a version kept first. '
        + 'Use when making any small change to a board, after atelier_resolve or atelier_tree gave the ids and sha. '
        + 'Returns {sha, summary, diff, ids: {old id: new id}} and the board reloads by itself; ids after a moved or removed element shift. '
        + 'Edits outside the user\'s locked scope are refused unless outOfScope says why the user wants them, and a style or text built with {{ }} holes is refused: edit those by hand.',
      props: {
        canvas: CANVAS,
        expectSha: { type: 'string', maxLength: 64, description: 'The board\'s sha from atelier_resolve or atelier_tree; a stale one is refused' },
        edits: {
          type: 'array', minItems: 1, maxItems: 50, description: 'All on one board, ids from the version expectSha names',
          items: {
            type: 'object', required: ['id'],
            properties: {
              id: ID,
              style: { type: 'object', description: 'CSS properties to set, e.g. {"gap": "10px"}; null removes one', additionalProperties: { type: ['string', 'number', 'null'] } },
              text: { type: 'string', maxLength: 4000, description: 'The element\'s own text, plain (no markup, no {{ }})' },
              attr: { type: 'object', description: 'Attributes to set, e.g. {"aria-label": "Stäng"}; null removes one (not style)', additionalProperties: { type: ['string', 'null'] } },
              remove: { type: 'boolean', description: 'Remove the element' },
              insertBefore: { ...ID, description: 'Move the element before this sibling' },
              insertAfter: { ...ID, description: 'Move the element after this sibling' },
            },
          },
        },
        outOfScope: { type: 'string', maxLength: 300, description: 'Only when the user asked for a change outside the locked scope: why' },
      },
      required: ['expectSha', 'edits'],
      // Also the lite call {id, text, expectSha?} (plain strings): one text edit, the sha read first when not given.
      run: async ({ canvas, id, text, ...rest }) => {
        const c = await canvasOf({ canvas });
        if (rest.edits) return api('POST', '/__agent/edit', { canvas: c, ...rest });
        const sha = rest.expectSha || (await api('GET', `/__agent/resolve?${new URLSearchParams({ canvas: c, id })}`))?.sha;
        if (!sha) throw new ToolError(`Could not read the board of ${id}.`);
        return api('POST', '/__agent/edit', { canvas: c, expectSha: sha, edits: [{ id, text }] });
      },
      lite: {
        description: 'Changes the text of one element on the canvas by its id (from a comment anchor or the view). Use when a comment asks for new wording. Returns the new sha. Text only; keep everything else.',
        params: { id: 'element id File.dc.html#<tid>:<path>', text: 'the new text', expectSha: 'the board sha (default: read it now)' },
        optional: ['expectSha'],
      },
    },
  };
}
