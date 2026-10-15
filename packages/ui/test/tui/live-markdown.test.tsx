import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { updateMarkdownParseCache } from '../../src/tui/ink/MarkdownBlock';
import { partitionLiveMarkdown } from '../../src/tui/live-markdown';
import { TerminalMarkdown } from '../../src/tui/markdown';

test('stable original Markdown groups and their live tail preserve exact rendered blocks and spacing', () => {
  for (const content of [
    '首段 café e\u0301 🧭\n\nSecond paragraph\n\nLast unfinished paragraph',
    '# Heading\n\n- one\n- two\n\n```ts\nconst original = true;\n```\n\nlast',
    '| First | Second |\n| --- | --- |\n| exact | original |\n\n> original quote\n\ntail',
  ]) {
    const cache = updateMarkdownParseCache(undefined, content);
    const parts = partitionLiveMarkdown(cache);
    const full = render(<TerminalMarkdown content={content} />);
    const split = render(
      <>
        {[...parts.stable, ...(parts.tail ? [parts.tail] : [])].map((part) => (
          <TerminalMarkdown key={part.key} content="" parsedSlice={part.slice} />
        ))}
      </>,
    );
    try {
      expect(split.lastFrame()).toBe(full.lastFrame());
    } finally {
      full.unmount();
      split.unmount();
    }
  }
});

test('only the final original group stays mutable; appending and table promotion cannot rewrite sealed groups', () => {
  const first = updateMarkdownParseCache(undefined, 'FIRST\n\n| potential');
  const before = partitionLiveMarkdown(first);
  const next = updateMarkdownParseCache(
    first,
    'FIRST\n\n| potential | value |\n| --- | --- |\n| original | complete |',
  );
  const after = partitionLiveMarkdown(next);
  expect(after.stable.map((part) => [part.key, part.version])).toEqual(
    before.stable.map((part) => [part.key, part.version]),
  );
  expect(after.tail?.slice.groups[0]?.kind).toBe('table');
  const open = partitionLiveMarkdown(
    updateMarkdownParseCache(undefined, '```ts\nconst exact = true;'),
  );
  expect(open.stable).toEqual([]);
  expect(open.tail?.slice.groups[0]?.kind).toBe('code');
  const changed = partitionLiveMarkdown(updateMarkdownParseCache(next, 'CHANGED\n\nlast'));
  expect(changed.stable[0]?.version).not.toBe(after.stable[0]?.version);
});
