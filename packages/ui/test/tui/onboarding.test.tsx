import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { act } from 'react';
import type { TuiOnboardingPort } from '../../src/tui/onboarding';
import { TuiOnboarding } from '../../src/tui/onboarding-panel';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(ready: () => boolean) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    } finally {
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
    if (ready()) return;
    if (Date.now() >= deadline) throw new Error('onboarding fixture did not reach its next state');
  }
}
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
    await until(() => ui.lastFrame()?.includes('/workspace') === true);
    expect(ui.lastFrame()).toContain('/workspace');
    ui.stdin.write('\r');
    await until(() => exits === 1);
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
    await until(() => ui.lastFrame()?.includes('Configuration could not be loaded') === true);
    expect(ui.lastFrame()).toContain('Configuration could not be loaded');
    expect(ready).toBe(0);
    ui.stdin.write('\r');
    await until(() => ready === 1);
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
    await until(() => ui.lastFrame()?.includes('Choose a model provider') === true);
    expect(ui.lastFrame()).toContain('DeepSeek');
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Connect to DeepSeek') === true);
    ui.stdin.write('sensitive-key');
    await until(() => ui.lastFrame()?.includes('*'.repeat('sensitive-key'.length)) === true);
    expect(ui.lastFrame()).not.toContain('sensitive-key');
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('The original write needs confirmation') === true);
    expect(posts).toBe(1);
    expect(ui.lastFrame()).not.toContain('sensitive-key');
    ui.stdin.write('\r');
    await until(() => gets === 1);
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
    await until(() => ui.lastFrame()?.includes('Saved original model') === true);
    expect(ui.lastFrame()).toContain('Saved original model');
    expect(ui.lastFrame()).toContain('enable and use');
    expect(ui.lastFrame()).toContain('Configure a provider');
    ui.stdin.write('\r');
    await until(() => ready === 1);
    expect(selections).toBe(1);
    expect(ready).toBe(1);
  } finally {
    ui.unmount();
  }
});

test('Escape cancels only the pending discovery, restores the masked original form and ignores its late ready result', async () => {
  const source = port(async () => ({ trusted: true, hasModels: false, readScopes: [] }));
  let signal: AbortSignal | undefined,
    finish!: (result: import('../../src/tui/onboarding').TuiOnboardingResult) => void;
  let ready = 0,
    exits = 0;
  source.connect = async (_workspaceId, input, aborted, onPhase) => {
    expect(input.apiKey).toBe('temporary-key');
    signal = aborted;
    onPhase?.('discovering');
    return new Promise((resolve) => {
      finish = resolve;
    });
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
    await until(() => ui.lastFrame()?.includes('Choose a model provider') === true);
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Connect to DeepSeek') === true);
    ui.stdin.write('temporary-key');
    await until(() => ui.lastFrame()?.includes('*'.repeat('temporary-key'.length)) === true);
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Connecting to DeepSeek') === true);
    expect(ui.lastFrame()).toContain('Connecting to DeepSeek');
    ui.stdin.write('\u001b');
    await until(
      () => signal?.aborted === true && ui.lastFrame()?.includes('Connect to DeepSeek') === true,
    );
    expect(signal?.aborted).toBe(true);
    expect(ui.lastFrame()).toContain('Connect to DeepSeek');
    expect(ui.lastFrame()).not.toContain('temporary-key');
    expect(exits).toBe(0);
    finish({ status: 'ready', modelName: 'late' });
    await tick();
    expect(ready).toBe(0);
    expect(ui.lastFrame()).toContain('Connect to DeepSeek');
  } finally {
    ui.unmount();
  }
});

test('Escape after publication has begun retains the original unknown and permits only its GET recovery', async () => {
  const source = port(async () => ({ trusted: true, hasModels: false, readScopes: [] }));
  let connects = 0,
    gets = 0,
    exits = 0;
  source.connect = async (_workspaceId, _input, _signal, onPhase) => {
    connects++;
    onPhase?.('publishing');
    return new Promise(() => {});
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
      onExit={() => exits++}
    />,
  );
  try {
    await until(() => ui.lastFrame()?.includes('Choose a model provider') === true);
    ui.stdin.write('\r');
    await until(() => ui.lastFrame()?.includes('Connect to DeepSeek') === true);
    ui.stdin.write('temporary-key');
    await until(() => ui.lastFrame()?.includes('*'.repeat('temporary-key'.length)) === true);
    ui.stdin.write('\r');
    await until(
      () => connects === 1 && ui.lastFrame()?.includes('Connecting to DeepSeek') === true,
    );
    ui.stdin.write('\u001b');
    await until(() => ui.lastFrame()?.includes('The original write needs confirmation') === true);
    expect(ui.lastFrame()).toContain('The original write needs confirmation');
    expect(exits).toBe(0);
    ui.stdin.write('\r');
    await until(() => gets === 1);
    expect(gets).toBe(1);
    expect(connects).toBe(1);
    expect(ui.lastFrame()).not.toContain('temporary-key');
  } finally {
    ui.unmount();
  }
});

test('verified observer admission opens saved history without trust or model readiness mutations', async () => {
  let admissions = 0;
  let writes = 0;
  const source = port(async () => ({
    observer: 'workspace_missing',
    trusted: false,
    hasModels: false,
    readScopes: [],
  }));
  source.trust =
    source.selectModel =
    source.connect =
      async () => {
        writes++;
        return { status: 'failed', code: 'unexpected_write' };
      };
  const ui = render(
    <TuiOnboarding
      port={source}
      workspaceId="w"
      path="/missing"
      onReady={() => admissions++}
      onExit={() => {}}
    />,
  );
  try {
    await until(() => admissions === 1);
    expect(admissions).toBe(1);
    expect(writes).toBe(0);
    expect(ui.lastFrame()).not.toContain('Trust this workspace');
    expect(ui.lastFrame()).not.toContain('Configuration could not be loaded');
  } finally {
    ui.unmount();
  }
});
