import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentConfig } from '@/core/config';

describe('source-aware observability configuration', () => {
  test('keeps user consent authoritative and projects disable-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-observability-config-'));
    const userHome = join(root, 'home');
    const workspace = join(root, 'workspace');
    const previousHome = process.env.KITE_CODE_HOME;
    try {
      mkdirSync(join(userHome, '.kite-code'), { recursive: true });
      mkdirSync(join(workspace, '.kite-code'), { recursive: true });
      process.env.KITE_CODE_HOME = userHome;
      writeFileSync(
        join(userHome, '.kite-code', 'kite-code.jsonc'),
        JSON.stringify({
          provider: { ollama: { models: [{ name: 'local', default: true }] } },
          telemetry: {
            enabled: true,
            endpointPolicy: 'vendor_managed',
            endpointSecret: 'USER-ONLY-SECRET',
            consent: {
              state: 'granted',
              metricCategories: ['run_turn'],
              receiver: 'Kite Operations',
              retentionDays: 30,
              withdrawalMethod: 'Disable telemetry in user settings.',
              canaryOptIn: false,
            },
          },
        }),
      );
      writeFileSync(
        join(workspace, '.kite-code', 'kite-code.jsonc'),
        JSON.stringify({
          telemetry: {
            enabled: false,
            endpointPolicy: 'admin_managed',
            endpointSecret: 'PROJECT-MUST-NOT-FLOW',
            contentLoggingConsent: true,
            modelProviderConsent: true,
          },
        }),
      );

      const config = loadAgentConfig({ workspace, providerName: 'ollama' });
      expect(config.telemetry?.user).toMatchObject({
        enabled: true,
        endpointPolicy: 'vendor_managed',
        endpointSecret: 'USER-ONLY-SECRET',
      });
      expect(config.telemetry?.project).toEqual({ enabled: false });
      expect(JSON.stringify(config.telemetry?.project)).not.toContain('PROJECT-MUST-NOT-FLOW');
    } finally {
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
