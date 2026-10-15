import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { defaultTuiPreferences } from '../../src/tui/preferences';
import { TuiPresentationProvider } from '../../src/tui/presentation';
import { TuiResult } from '../../src/tui/result';

test('diagnostic results show their own receipt before a catalogue without losing any fields', () => {
  const value = {
    definitions: Array.from({ length: 64 }, (_, index) => ({ id: `tool-${index}`, schema: {} })),
    executionId: 'original-result-execution',
    toolsMetadata: { availability: 'available', reason: null, recordKey: 'tools/original' },
    nested: { omitted: false, items: [null, 0, ''] },
  };
  const view = render(
    <TuiPresentationProvider value={{ preferences: defaultTuiPreferences, testDiagnostics: true }}>
      <TuiResult value={value} />
    </TuiPresentationProvider>,
  );
  try {
    const text = view.lastFrame()!;
    expect(text.indexOf('"executionId"')).toBeLessThan(text.indexOf('"definitions"'));
    expect(text.indexOf('"toolsMetadata"')).toBeLessThan(text.indexOf('"definitions"'));
    expect(JSON.parse(text)).toEqual(value);
  } finally {
    view.unmount();
    view.cleanup();
  }
});
