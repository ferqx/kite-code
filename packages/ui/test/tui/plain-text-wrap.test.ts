import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { wrapPlainText } from '../../src/tui/ink/plain-text-wrap';

// Compare the installed Ink dependency's actual wrapping contract, not a second fixture model.
const fromInk = createRequire(import.meta.resolve('ink'));
const wrapAnsi = fromInk('wrap-ansi').default as (
  text: string,
  width: number,
  options: { trim: boolean; hard: boolean },
) => string;

for (const [name, text, width] of [
  ['normal words', 'Original text with words and a complete tail.', 12],
  ['Unicode clusters', '原🌿e\u0301 👩🏽‍💻 🇨🇳 漢字 repeated e\u0301 FULL_TAIL', 8],
  ['long word across segmentation spans', `${'👩🏽‍💻e\u0301漢'.repeat(210)} END`, 17],
  ['spaces and tabs', ' leading  multiple spaces   and\ttab  tail ', 11],
  ['explicit newlines', 'one paragraph\n\n second line \r\nfinal tail', 9],
] as const) {
  test(`bounded plain wrapping preserves Ink ${name}`, () => {
    expect(wrapPlainText(text, width)).toBe(wrapAnsi(text, width, { trim: false, hard: true }));
  });
}
