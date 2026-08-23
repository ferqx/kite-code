import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURE_FLAGS, getFeatureFlags, parseFeatureOverride } from '#app/config/features';
import { loadAgentConfig } from '#app/config/index';
import { parseArgs } from '@/app/cli/index';
import { resolveAutoReviewTimeout } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-dependencies';

describe('feature flags', () => {
  test('uses registered defaults and accepts partial config overrides', () => {
    expect(getFeatureFlags()).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(getFeatureFlags({ features: { autoReview: true } }).autoReview).toBe(true);
    expect(getFeatureFlags({ features: { autoReview: true } }).loopMode).toBe(false);
    expect(getFeatureFlags().capabilityCatalog).toBe(true);
    expect(getFeatureFlags().mcpRuntimeBinding).toBe(true);
    expect(getFeatureFlags().toolSearch).toBe(true);
    expect(getFeatureFlags().contextCompaction).toBe(true);
    expect(getFeatureFlags().contextCompactionAuto).toBe(false);
    expect(getFeatureFlags().contextCompactionManual).toBe(true);
    expect(getFeatureFlags().verification).toBe(false);
    expect(getFeatureFlags().mcpProviderAction).toBe(false);
    expect(getFeatureFlags().sessionLoggingPolicy).toBe(true);
    expect(getFeatureFlags().resourceBudget).toBe(false);
    expect(getFeatureFlags().boundedCancellation).toBe(false);
    expect(getFeatureFlags().terminalOutcome).toBe(false);
    expect(getFeatureFlags().executionBoundary).toBe(false);
    expect(getFeatureFlags().networkBoundary).toBe(false);
    expect(getFeatureFlags().observabilityMetrics).toBe(false);
    expect(getFeatureFlags().promptContract).toBe(true);
    expect(getFeatureFlags({ features: { promptContract: false } }).promptContract).toBe(false);
    expect(getFeatureFlags({ features: { promptContract: true } }).promptContract).toBe(true);
    expect(getFeatureFlags({ features: { boundedCancellation: true } }).boundedCancellation).toBe(
      true,
    );
    expect(getFeatureFlags({ features: { verification: true } }).verification).toBe(true);
    expect(getFeatureFlags({ features: { mcpRuntimeBinding: true } }).mcpRuntimeBinding).toBe(true);
  });

  test('parses CLI overrides and rejects unknown flags', () => {
    expect(parseFeatureOverride('autoReview')).toEqual({ autoReview: true });
    expect(parseFeatureOverride('autoReview=false')).toEqual({ autoReview: false });
    expect(parseFeatureOverride('mcpRuntimeBinding')).toEqual({ mcpRuntimeBinding: true });
    expect(parseFeatureOverride('mcpProviderAction')).toEqual({ mcpProviderAction: true });
    expect(parseFeatureOverride('verification=false')).toEqual({ verification: false });
    expect(parseFeatureOverride('contextCompactionAuto')).toEqual({
      contextCompactionAuto: true,
    });
    expect(parseFeatureOverride('resourceBudget')).toEqual({ resourceBudget: true });
    expect(parseFeatureOverride('boundedCancellation')).toEqual({
      boundedCancellation: true,
    });
    expect(parseFeatureOverride('terminalOutcome=false')).toEqual({ terminalOutcome: false });
    expect(parseFeatureOverride('executionBoundary')).toEqual({ executionBoundary: true });
    expect(parseFeatureOverride('networkBoundary')).toEqual({ networkBoundary: true });
    expect(parseFeatureOverride('promptContract=true')).toEqual({ promptContract: true });
    expect(parseFeatureOverride('promptContract=false')).toEqual({ promptContract: false });
    expect(() => parseFeatureOverride('typo=true')).toThrow('Unknown feature flag');
  });

  test('loads config flags and accepts repeatable CLI overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-features-'));
    try {
      const configPath = join(dir, 'kite-code.jsonc');
      writeFileSync(
        configPath,
        '{ "features": { "autoReview": true, "promptContract": true }, "provider": { "ollama": {} } }',
      );
      const loaded = loadAgentConfig({ configPath, providerName: 'ollama' });
      expect(loaded.features).toEqual({
        autoReview: true,
        promptContract: true,
      });
      expect(loaded.sessionLoggingPolicy?.mode).toBe('metadata');
      expect(
        parseArgs(['run', '--feature', 'autoReview=false', '--feature', 'loopMode'])
          .featureOverrides,
      ).toEqual({ autoReview: false, loopMode: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects CLI attempts to enable release-controlled execution boundaries', () => {
    expect(() => parseArgs(['run', '--feature', 'executionBoundary'])).toThrow(
      'release-controlled',
    );
    expect(() => parseArgs(['run', '--feature', 'networkBoundary=true'])).toThrow(
      'release-controlled',
    );
    expect(parseArgs(['run', '--feature', 'networkBoundary=false']).featureOverrides).toEqual({
      networkBoundary: false,
    });
    expect(() => parseArgs(['run', '--feature', 'observabilityMetrics=true'])).toThrow(
      'release-controlled',
    );
    expect(parseArgs(['run', '--feature', 'observabilityMetrics=false']).featureOverrides).toEqual({
      observabilityMetrics: false,
    });
    expect(parseArgs(['run', '--telemetry-status']).telemetryStatus).toBe(true);
  });

  test('keeps the legacy reviewer timeout until autoReview is enabled', () => {
    const config = {
      apiKey: '',
      baseURL: 'http://localhost:11434',
      modelName: 'mock',
      providerName: 'ollama',
      providerType: 'ollama' as const,
      sandbox: { enabled: true },
      autoReview: { timeoutMs: 321 },
    };
    expect(resolveAutoReviewTimeout({ ...config, features: { autoReview: false } })).toBe(15_000);
    expect(resolveAutoReviewTimeout({ ...config, features: { autoReview: true } })).toBe(321);
  });
});
