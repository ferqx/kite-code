import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import type { TuiController } from '../../src/tui/controller';
import { TuiModelPanel } from '../../src/tui/model-panel';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
test('model window starts at actual default and effort, exact two-step review preserves chosen model', async () => {
  const choices: unknown[] = [];
  const models = Array.from({ length: 18 }, (_, i) => ({
    id: `model-${String(i).padStart(2, '0')}`,
    provider: 'provider',
    model: `Name ${i}`,
    enabled: true,
    configured: true,
    diagnostics: [],
    reasoningEffort: 'high',
    reasoningEffortChoices: ['low', 'high'],
    reasoningEffortSupport: 'compatible_wire',
  }));
  const state = {
    panel: 'models',
    models: { defaultModelId: 'model-15', models, errors: [] },
    stale: false,
  };
  const controller = {
    state,
    chooseModel: async (operation: unknown) => choices.push(operation),
    closePanel: () => {},
    openModels: async () => {},
    lookupModel: async () => {},
  } as unknown as TuiController;
  const ui = render(<TuiModelPanel controller={controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('› provider / model-15');
    expect(ui.lastFrame()).not.toContain('Name 0');
    ui.stdin.write('\r');
    await tick();
    expect(choices).toEqual([]);
    ui.stdin.write('\r');
    await tick();
    expect(choices).toEqual([{ kind: 'default', modelId: 'model-15' }]);
    state.panel = 'effort';
    ui.rerender(<TuiModelPanel controller={controller} />);
    await tick();
    expect(ui.lastFrame()).toContain('› high');
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(choices[1]).toEqual({ kind: 'effort', modelId: 'model-15', reasoningEffort: 'high' });
  } finally {
    ui.unmount();
  }
});
