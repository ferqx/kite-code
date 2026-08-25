import { describe, expect, test } from 'bun:test';
import type {
  AvailableModel,
  ConnectionError,
  ProviderDefinition,
} from '../src/tui/components/first-run/types';
import {
  chooseInitialModel,
  classifyError,
  getErrorActions,
  PROVIDERS,
} from '../src/tui/components/first-run/types';

describe('PROVIDERS', () => {
  test('all providers have required fields', () => {
    for (const p of PROVIDERS) {
      expect(p.type).toBeString();
      expect(p.label).toBeString();
      expect(p.defaultBaseURL).toBeString();
      expect(['api-key', 'ollama', 'custom-endpoint']).toContain(p.connectionForm);
      expect(['required', 'optional', 'none']).toContain(p.apiKey);
      expect(typeof p.supportsModelDiscovery).toBe('boolean');
      expect(Array.isArray(p.recommendedModels)).toBe(true);
      expect(['automatic', 'on', 'off']).toContain(p.defaultReasoning);
    }
  });

  test('DeepSeek is the first provider', () => {
    expect(PROVIDERS[0]!.type).toBe('deepseek');
  });

  test('DeepSeek and OpenAI require API key', () => {
    for (const type of ['deepseek', 'openai'] as const) {
      const p = PROVIDERS.find((p) => p.type === type)!;
      expect(p.apiKey).toBe('required');
      expect(p.connectionForm).toBe('api-key');
    }
  });

  test('Custom endpoint allows optional API key', () => {
    const custom = PROVIDERS.find((p) => p.type === 'openai-compatible')!;
    expect(custom.apiKey).toBe('optional');
    expect(custom.connectionForm).toBe('custom-endpoint');
    expect(custom.description).toBe('Self-hosted or compatible');
  });
});

describe('chooseInitialModel', () => {
  const provider: ProviderDefinition = {
    type: 'openai-compatible',
    label: 'Test',
    defaultBaseURL: 'http://localhost/v1',
    connectionForm: 'custom-endpoint',
    apiKey: 'optional',
    supportsModelDiscovery: true,
    recommendedModels: ['gpt-4o', 'gpt-3.5-turbo'],
    defaultReasoning: 'automatic',
  };

  test('selects model with default flag first', () => {
    const models: AvailableModel[] = [
      { name: 'model-a' },
      { name: 'model-b', default: true },
      { name: 'model-c' },
    ];
    expect(chooseInitialModel(provider, models)?.name).toBe('model-b');
  });

  test('falls back to recommended models when no default', () => {
    const models: AvailableModel[] = [
      { name: 'random-model' },
      { name: 'gpt-3.5-turbo' },
      { name: 'another' },
    ];
    expect(chooseInitialModel(provider, models)?.name).toBe('gpt-3.5-turbo');
  });

  test('prefers recommended models in order', () => {
    const models: AvailableModel[] = [
      { name: 'random-model' },
      { name: 'gpt-4o' },
      { name: 'gpt-3.5-turbo' },
    ];
    expect(chooseInitialModel(provider, models)?.name).toBe('gpt-4o');
  });

  test('falls back to first model when no recommended match', () => {
    const models: AvailableModel[] = [{ name: 'custom-model' }, { name: 'other-model' }];
    expect(chooseInitialModel(provider, models)?.name).toBe('custom-model');
  });

  test('returns null for empty model list', () => {
    expect(chooseInitialModel(provider, [])).toBeNull();
  });

  test('returns null when models is empty array', () => {
    const models: AvailableModel[] = [];
    expect(chooseInitialModel(provider, models)).toBeNull();
  });
});

describe('classifyError', () => {
  const url = 'http://localhost:11434';

  test('classifies 401 as auth', () => {
    const err = classifyError(401, 'Unauthorized', url);
    expect(err.kind).toBe('auth');
    expect(err.details).toContain('rejected');
  });

  test('classifies 403 as auth', () => {
    const err = classifyError(403, 'Forbidden', url);
    expect(err.kind).toBe('auth');
  });

  test('classifies ECONNREFUSED as unreachable', () => {
    const err = classifyError(null, 'fetch failed: ECONNREFUSED', url);
    expect(err.kind).toBe('unreachable');
    expect(err.details).toBe(url);
  });

  test('classifies ENOTFOUND as unreachable', () => {
    const err = classifyError(null, 'ENOTFOUND example.com', url);
    expect(err.kind).toBe('unreachable');
  });

  test('classifies timeout as unreachable', () => {
    const err = classifyError(null, 'The operation timed out', url);
    expect(err.kind).toBe('unreachable');
  });

  test('classifies other errors as incompatible', () => {
    const err = classifyError(500, 'Internal Server Error', url);
    expect(err.kind).toBe('incompatible');
  });

  test('classifies fetch error without status as incompatible', () => {
    const err = classifyError(null, 'Something went wrong', url);
    expect(err.kind).toBe('incompatible');
  });
});

describe('getErrorActions', () => {
  test('auth error offers edit key, try again, and choose provider', () => {
    const err: ConnectionError = { kind: 'auth', message: 'Unauthorized' };
    const actions = getErrorActions(err);
    expect(actions.map((a) => a.action)).toEqual(['edit-key', 'back-to-provider']);
  });

  test('unreachable error offers edit settings and choose provider', () => {
    const err: ConnectionError = { kind: 'unreachable', message: 'Failed' };
    const actions = getErrorActions(err);
    expect(actions.map((a) => a.action)).toEqual(['edit-settings', 'back-to-provider']);
  });

  test('incompatible error offers enter model, edit settings, and choose provider', () => {
    const err: ConnectionError = { kind: 'incompatible', message: 'Bad format' };
    const actions = getErrorActions(err);
    expect(actions.map((a) => a.action)).toEqual([
      'enter-model',
      'edit-settings',
      'back-to-provider',
    ]);
  });

  test('generic error offers edit settings and choose provider', () => {
    const err: ConnectionError = { kind: 'generic', message: 'Oops' };
    const actions = getErrorActions(err);
    expect(actions.map((a) => a.action)).toEqual(['edit-settings', 'back-to-provider']);
  });
});
