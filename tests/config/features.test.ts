import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '@/app/cli/index';
import {
  DEFAULT_FEATURE_FLAGS,
  getFeatureFlags,
  parseFeatureOverride,
} from '@/core/config/features';
import { loadAgentConfig } from '@/core/config/index';
import { resolveAutoReviewTimeout } from '@/core/runtime/executor';

describe('feature flags', () => {
  test('uses registered defaults and accepts partial config overrides', () => {
    expect(getFeatureFlags()).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(getFeatureFlags({ features: { autoReviewV2: true } }).autoReviewV2).toBe(true);
    expect(getFeatureFlags({ features: { autoReviewV2: true } }).loopMode).toBe(false);
    expect(getFeatureFlags().capabilityCatalogV1).toBe(true);
    expect(getFeatureFlags().mcpRuntimeBindingV1).toBe(true);
    expect(getFeatureFlags().capabilitySearchV1).toBe(true);
    expect(getFeatureFlags().verificationV1).toBe(false);
    expect(getFeatureFlags().mcpProviderActionV1).toBe(false);
    expect(getFeatureFlags({ features: { verificationV1: true } }).verificationV1).toBe(true);
    expect(getFeatureFlags({ features: { mcpRuntimeBindingV1: true } }).mcpRuntimeBindingV1).toBe(
      true,
    );
  });

  test('parses CLI overrides and rejects unknown flags', () => {
    expect(parseFeatureOverride('autoReviewV2')).toEqual({ autoReviewV2: true });
    expect(parseFeatureOverride('autoReviewV2=false')).toEqual({ autoReviewV2: false });
    expect(parseFeatureOverride('mcpRuntimeBindingV1')).toEqual({ mcpRuntimeBindingV1: true });
    expect(parseFeatureOverride('mcpProviderActionV1')).toEqual({ mcpProviderActionV1: true });
    expect(parseFeatureOverride('verificationV1=false')).toEqual({ verificationV1: false });
    expect(() => parseFeatureOverride('typo=true')).toThrow('Unknown feature flag');
  });

  test('loads config flags and accepts repeatable CLI overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-features-'));
    try {
      const configPath = join(dir, 'kite-code.jsonc');
      writeFileSync(
        configPath,
        '{ "features": { "autoReviewV2": true }, "provider": { "ollama": {} } }',
      );
      expect(loadAgentConfig({ configPath, providerName: 'ollama' }).features).toEqual({
        autoReviewV2: true,
      });
      expect(
        parseArgs(['run', '--feature', 'autoReviewV2=false', '--feature', 'loopMode'])
          .featureOverrides,
      ).toEqual({ autoReviewV2: false, loopMode: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps the legacy reviewer timeout until autoReviewV2 is enabled', () => {
    const config = {
      apiKey: '',
      baseURL: 'http://localhost:11434',
      modelName: 'mock',
      providerName: 'ollama',
      providerType: 'ollama' as const,
      sandbox: { enabled: true },
      autoReview: { timeoutMs: 321 },
    };
    expect(resolveAutoReviewTimeout({ ...config, features: { autoReviewV2: false } })).toBe(15_000);
    expect(resolveAutoReviewTimeout({ ...config, features: { autoReviewV2: true } })).toBe(321);
  });
});
