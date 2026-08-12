import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, loadAgentConfig, saveModelSelection } from '../src/core/config/index';

// 验证 loadAgentConfig 配置加载功能 / Verify loadAgentConfig configuration loading
describe('loadAgentConfig', () => {
  // 验证默认配置路径始终指向用户 home 目录下的 kite-code.jsonc / Verify default config path always resolves to kite-code.jsonc under user home
  test('uses a user-home default config path across operating systems', () => {
    expect(defaultConfigPath()).toBe(join(homedir(), '.kite-code', 'kite-code.jsonc'));
  });

  // 验证能正确解析 JSONC 文件中的 DeepSeek provider 和模型配置 / Verify parsing DeepSeek provider and model config from JSONC file
  test('loads DeepSeek provider and default model from JSONC', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'kite-code.jsonc');
      writeFileSync(
        configPath,
        `{
        "provider": {
          "deepseek": {
            "apiKey": "sk-test",
            "baseURL": "https://api.deepseek.com/v1",
            "models": [
              { "name": "deepseek-chat", "default": true }
            ]
          }
        }
      }`,
      );

      const config = loadAgentConfig({ configPath });

      expect(config.apiKey).toBe('sk-test');
      expect(config.baseURL).toBe('https://api.deepseek.com/v1');
      expect(config.modelName).toBe('deepseek-chat');
      expect(config.providerName).toBe('deepseek');
      expect(config.providerType).toBe('deepseek');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loads an explicitly typed OpenAI-compatible provider', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'openai-compatible.jsonc');
      writeFileSync(
        configPath,
        `{
        "provider": {
          "siliconflow": {
            "type": "openai-compatible",
            "apiKey": "sk-compatible",
            "baseURL": "https://api.siliconflow.cn/v1",
            "models": [
              { "name": "Qwen/Qwen3-Coder", "default": true }
            ]
          }
        }
      }`,
      );

      const config = loadAgentConfig({ configPath });

      expect(config.apiKey).toBe('sk-compatible');
      expect(config.baseURL).toBe('https://api.siliconflow.cn/v1');
      expect(config.modelName).toBe('Qwen/Qwen3-Coder');
      expect(config.providerName).toBe('siliconflow');
      expect(config.providerType).toBe('openai-compatible');
      expect(config.reasoningExplicitlyDisabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('distinguishes an explicit reasoning disable from the provider default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'reasoning-disabled.jsonc');
      writeFileSync(
        configPath,
        `{
          "model": {
            "default": { "provider": "compatible", "name": "plain-chat-model" }
          },
          "provider": {
            "compatible": {
              "type": "openai-compatible",
              "apiKey": "sk-compatible",
              "baseURL": "https://models.example.test/v1",
              "model": "plain-chat-model",
              "reasoning": false
            }
          }
        }`,
      );

      const config = loadAgentConfig({ configPath });
      expect(config.reasoning).toBe(false);
      expect(config.reasoningExplicitlyDisabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists the selected provider and model route for the next startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'model-selection.jsonc');
      writeFileSync(
        configPath,
        `{
          "model": {
            "default": { "provider": "deepseek", "name": "deepseek-v4-flash" }
          },
          "provider": {
            "deepseek": {
              "apiKey": "sk-test",
              "models": ["deepseek-v4-flash", "deepseek-v4-pro"]
            },
            "opencode_go": {
              "type": "openai-compatible",
              "apiKey": "sk-compatible",
              "baseURL": "https://models.example.test/v1",
              "models": ["deepseek-v4-flash"]
            }
          }
        }`,
      );

      expect(saveModelSelection('opencode_go', 'deepseek-v4-flash', configPath)).toBe(true);
      expect(readFileSync(configPath, 'utf8')).toContain(
        '"model": "opencode_go:deepseek-v4-flash"',
      );
      const restarted = loadAgentConfig({ configPath });

      expect(restarted.providerName).toBe('opencode_go');
      expect(restarted.modelName).toBe('deepseek-v4-flash');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loads provider:model shorthand and preserves colons in the model name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'compact-model-selection.jsonc');
      writeFileSync(
        configPath,
        `{
          "model": "ollama:qwen2.5-coder:7b",
          "provider": {
            "ollama": {
              "model": "qwen2.5-coder:14b",
              "models": ["qwen2.5-coder:7b", "qwen2.5-coder:14b"]
            }
          }
        }`,
      );

      const config = loadAgentConfig({ configPath });
      expect(config.providerName).toBe('ollama');
      expect(config.modelName).toBe('qwen2.5-coder:7b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('continues to load the legacy model.default object format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'legacy-model-selection.jsonc');
      writeFileSync(
        configPath,
        `{
          "model": {
            "default": { "provider": "ollama", "name": "legacy-local" }
          },
          "provider": {
            "ollama": { "models": ["legacy-local", "fallback-local"] }
          }
        }`,
      );

      const config = loadAgentConfig({ configPath });
      expect(config.providerName).toBe('ollama');
      expect(config.modelName).toBe('legacy-local');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores a persisted model route that is no longer configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'stale-model-selection.jsonc');
      writeFileSync(
        configPath,
        `{
          "model": {
            "default": { "provider": "removed", "name": "removed-model" }
          },
          "provider": {
            "ollama": {
              "models": [{ "name": "local-model", "default": true }]
            }
          }
        }`,
      );

      const restarted = loadAgentConfig({ configPath });
      expect(restarted.providerName).toBe('ollama');
      expect(restarted.modelName).toBe('local-model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loads formal model context and output capabilities from the selected entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'model-capabilities.jsonc');
      writeFileSync(
        configPath,
        `{
          "provider": {
            "ollama": {
              "models": [{
                "name": "local-custom",
                "default": true,
                "contextWindow": 32768,
                "maxOutputTokens": 2048,
                "tokenizerFamily": "llama",
                "supportsUsageMetadata": true,
                "supportsPromptCache": false,
                "streaming": true
              }]
            }
          }
        }`,
      );
      expect(loadAgentConfig({ configPath }).modelCapabilities).toEqual({
        contextWindowTokens: 32768,
        maxOutputTokens: 2048,
        tokenizerFamily: 'llama',
        supportsUsageMetadata: true,
        supportsPromptCache: false,
        streaming: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loads bounded automatic context compaction thresholds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'compaction.jsonc');
      writeFileSync(
        configPath,
        `{
          "provider": {
            "ollama": {
              "models": [{ "name": "local", "default": true }]
            }
          },
          "compaction": {
            "autoMode": "shadow",
            "reclaimMode": "shadow",
            "triggerRatio": 0.68,
            "compactAfterEstimatedTokens": 12000,
            "maxSummaryTokens": 5000,
            "maxSummaryInputTokens": 24000,
            "warningRatio": 0.65,
            "compactRatio": 0.7,
            "hardRatio": 0.86,
            "minimumReductionRatio": 0.18,
            "maxSummaryInputToReductionRatio": 4,
            "cooldownTurns": 4
          }
        }`,
      );
      expect(loadAgentConfig({ configPath }).compaction).toEqual({
        autoMode: 'shadow',
        reclaimMode: 'shadow',
        triggerRatio: 0.68,
        compactAfterEstimatedTokens: 12000,
        maxSummaryTokens: 5000,
        maxSummaryInputTokens: 24000,
        warningRatio: 0.65,
        compactRatio: 0.7,
        hardRatio: 0.86,
        minimumReductionRatio: 0.18,
        maxSummaryInputToReductionRatio: 4,
        cooldownTurns: 4,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects unknown automatic compaction rollout modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'bad-auto-mode.jsonc');
      writeFileSync(
        configPath,
        `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "autoMode": "soft_hard" } }`,
      );
      expect(() => loadAgentConfig({ configPath })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts explicit live context reclaim while feature gates remain default-off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'bad-reclaim-mode.jsonc');
      writeFileSync(
        configPath,
        `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "reclaimMode": "live" } }`,
      );
      expect(loadAgentConfig({ configPath }).compaction?.reclaimMode).toBe('live');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects removed compaction softRatio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'bad-ratio.jsonc');
      writeFileSync(
        configPath,
        `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "softRatio": 0.5 } }`,
      );
      expect(() => loadAgentConfig({ configPath })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects negative compaction cooldownTurns and removed recentTurns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'bad-turns.jsonc');
      writeFileSync(
        configPath,
        `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "cooldownTurns": -1 } }`,
      );
      expect(() => loadAgentConfig({ configPath })).toThrow();
      writeFileSync(
        configPath,
        `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "recentTurns": 3 } }`,
      );
      expect(() => loadAgentConfig({ configPath })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts boundary values for compaction ratios', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'boundary-ratios.jsonc');
      writeFileSync(
        configPath,
        `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "warningRatio": 0.01, "compactRatio": 0.5, "hardRatio": 1, "minimumReductionRatio": 0 } }`,
      );
      const cfg = loadAgentConfig({ configPath });
      expect(cfg.compaction?.minimumReductionRatio).toBe(0);
      expect(cfg.compaction?.hardRatio).toBe(1);
      expect(cfg.compaction?.warningRatio).toBe(0.01);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loads an Ollama provider with local defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'ollama.jsonc');
      writeFileSync(
        configPath,
        `{
        "provider": {
          "ollama": {
            "models": [
              { "name": "qwen2.5-coder:7b", "default": true }
            ]
          }
        }
      }`,
      );

      const config = loadAgentConfig({ configPath });

      expect(config.apiKey).toBe('');
      expect(config.baseURL).toBe('http://localhost:11434');
      expect(config.modelName).toBe('qwen2.5-coder:7b');
      expect(config.providerName).toBe('ollama');
      expect(config.providerType).toBe('ollama');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loads sandbox enabled flag from JSONC', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'sandbox-disabled.jsonc');
      writeFileSync(
        configPath,
        `{
        "sandbox": {
          "enabled": false
        },
        "provider": {
          "ollama": {
            "models": [
              { "name": "qwen2.5-coder:7b", "default": true }
            ]
          }
        }
      }`,
      );

      const config = loadAgentConfig({ configPath });

      expect(config.sandbox.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('overrides the configured default provider and model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'override-provider.jsonc');
      writeFileSync(
        configPath,
        `{
        "provider": {
          "deepseek": {
            "apiKey": "sk-test",
            "baseURL": "https://api.deepseek.com/v1",
            "models": [
              { "name": "deepseek-chat", "default": true }
            ]
          },
          "ollama": {}
        }
      }`,
      );

      const config = loadAgentConfig({
        configPath,
        providerName: 'ollama',
        modelName: 'gemma4:31b-cloud',
      });

      expect(config.apiKey).toBe('');
      expect(config.baseURL).toBe('http://localhost:11434');
      expect(config.modelName).toBe('gemma4:31b-cloud');
      expect(config.providerName).toBe('ollama');
      expect(config.providerType).toBe('ollama');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('overrides to Ollama even when the provider is not configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'override-missing-ollama.jsonc');
      writeFileSync(
        configPath,
        `{
        "provider": {
          "deepseek": {
            "apiKey": "sk-test",
            "baseURL": "https://api.deepseek.com/v1",
            "models": [
              { "name": "deepseek-chat", "default": true }
            ]
          }
        }
      }`,
      );

      const config = loadAgentConfig({
        configPath,
        providerName: 'ollama',
        modelName: 'gemma4:31b-cloud',
      });

      expect(config.apiKey).toBe('');
      expect(config.baseURL).toBe('http://localhost:11434');
      expect(config.modelName).toBe('gemma4:31b-cloud');
      expect(config.providerName).toBe('ollama');
      expect(config.providerType).toBe('ollama');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
