import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import type { TuiOnboardingPort } from '../../src/tui/onboarding';
import { TuiOnboarding } from '../../src/tui/onboarding-panel';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
function port(read: TuiOnboardingPort['read']): TuiOnboardingPort {
  return {
    read,
    selectModel: async () => ({ status: 'ready', modelName: 'confirmed' }),
    trust: async () => ({ status: 'model-required', stage: 'provider' }),
    connect: async () => ({ status: 'unknown' }),
    recover: async () => ({ status: 'unknown' }),
    resume: async () => ({ status: 'unknown' }),
  };
}
test('trust gate defaults to exit; pressing Enter does not record trust', async () => {
  let exits = 0,
    trusts = 0,
    ready = 0;
  const source = port(async () => ({ trusted: false, hasModels: false, readScopes: [] }));
  source.trust = async () => {
    trusts++;
    return { status: 'model-required' };
  };
  const ui = render(
    <TuiOnboarding
      port={source}
      workspaceId="w"
      path="/workspace"
      onReady={() => ready++}
      onExit={() => exits++}
    />,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('/workspace');
    ui.stdin.write('\r');
    await tick();
    expect(exits).toBe(1);
    expect(trusts).toBe(0);
    expect(ready).toBe(0);
  } finally {
    ui.unmount();
  }
});
test('configured confirmed default skips first run while errors remain retryable without writes', async () => {
  let ready = 0,
    reads = 0;
  const source = port(async () => {
    reads++;
    if (reads === 1) throw Error('not ready');
    return { trusted: true, hasModels: true, modelName: 'confirmed', readScopes: [] };
  });
  const ui = render(
    <TuiOnboarding
      port={source}
      workspaceId="w"
      path="/workspace"
      onReady={() => ready++}
      onExit={() => {}}
    />,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Configuration could not be loaded');
    expect(ready).toBe(0);
    ui.stdin.write('\r');
    await tick();
    expect(ready).toBe(1);
    expect(reads).toBe(2);
  } finally {
    ui.unmount();
  }
});
test('API key remains masked and unknown recovery never resends the original connection', async () => {
  let posts = 0,
    gets = 0;
  const source = port(async () => ({ trusted: true, hasModels: false, readScopes: [] }));
  source.connect = async (_id, input) => {
    posts++;
    expect(input.apiKey).toBe('sensitive-key');
    return { status: 'unknown' };
  };
  source.recover = async () => {
    gets++;
    return { status: 'unknown' };
  };
  const ui = render(
    <TuiOnboarding
      port={source}
      workspaceId="w"
      path="/workspace"
      onReady={() => {}}
      onExit={() => {}}
    />,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('DeepSeek');
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('sensitive-key');
    await tick();
    expect(ui.lastFrame()).not.toContain('sensitive-key');
    ui.stdin.write('\r');
    await tick();
    expect(posts).toBe(1);
    expect(ui.lastFrame()).not.toContain('sensitive-key');
    ui.stdin.write('\r');
    await tick();
    expect(posts).toBe(1);
    expect(gets).toBe(1);
  } finally {
    ui.unmount();
  }
});

test('existing disabled models offer enable/use and provider configuration instead of a dead end', async () => {
  let selections = 0;
  const source = port(async () => ({
    trusted: true,
    hasModels: true,
    readScopes: [],
    models: [{ id: 'saved', name: 'Saved original model', configured: true, enabled: false }],
  }));
  source.selectModel = async (_id, modelId) => {
    selections++;
    expect(modelId).toBe('saved');
    return { status: 'ready', modelName: 'Saved original model' };
  };
  let ready = 0;
  const ui = render(
    <TuiOnboarding
      port={source}
      workspaceId="w"
      path="/workspace"
      onReady={() => ready++}
      onExit={() => {}}
    />,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Saved original model');
    expect(ui.lastFrame()).toContain('enable and use');
    expect(ui.lastFrame()).toContain('Configure a provider');
    ui.stdin.write('\r');
    await tick();
    expect(selections).toBe(1);
    expect(ready).toBe(1);
  } finally {
    ui.unmount();
  }
});
