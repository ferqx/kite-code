import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  type ProviderModelSnapshot,
} from '@kite-ai/kite-app-contract';
import { render } from 'ink-testing-library';
import ModelSelector from '../src/tui/components/ModelSelector';

const snapshot: ProviderModelSnapshot = {
  schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  workspace: {
    canonicalPath: '/workspace/project',
    projectId: 'project_workspace',
    workspaceDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  revision: 'provider-model-revision-1',
  providers: [
    {
      provider: 'openai',
      type: 'openai',
      readiness: 'ready',
      selectedModel: 'gpt-5.6',
      models: [
        { provider: 'openai', name: 'gpt-5.6', isDefault: true },
        { provider: 'openai', name: 'gpt-5.5', isDefault: false },
      ],
    },
  ],
  selected: { provider: 'openai', name: 'gpt-5.6' },
};

describe('ModelSelector App Control projection', () => {
  test('renders a safe snapshot and returns model identity with observed revision', async () => {
    const selected: Array<{ provider: string; name: string; observedRevision: string }> = [];
    const view = render(
      <ModelSelector
        currentModel="stale-model"
        currentProvider="stale-provider"
        snapshot={snapshot}
        onSelect={(model) =>
          selected.push({
            provider: model.provider,
            name: model.name,
            observedRevision: model.observedRevision,
          })
        }
        onClose={() => {}}
      />,
    );

    expect(view.lastFrame()).toContain('gpt-5.6');
    expect(view.lastFrame()).toContain('gpt-5.5');
    view.stdin.write('\u001b[B');
    await Bun.sleep(10);
    view.stdin.write('\r');
    await Bun.sleep(10);

    expect(selected).toEqual([
      { provider: 'openai', name: 'gpt-5.5', observedRevision: 'provider-model-revision-1' },
    ]);
    view.unmount();
  });

  test('has no direct model config or repository dependency', () => {
    const source = readFileSync(
      new URL('../src/tui/components/ModelSelector.tsx', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('#kite-cli/config');
    expect(source).not.toContain('listAvailableModels');
    expect(source).not.toContain('loadAgentConfig');
  });
});
