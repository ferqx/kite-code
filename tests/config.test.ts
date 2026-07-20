import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, loadAgentConfig } from '../src/core/config/index';

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
                "supportsPromptCache": false
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
            "maxSummaryTokens": 5000,
            "maxSummaryInputTokens": 24000,
            "warningRatio": 0.65,
            "compactRatio": 0.7,
            "hardRatio": 0.86,
            "targetRatio": 0.52,
            "minimumReductionRatio": 0.18,
            "cooldownTurns": 4,
            "recentTurns": 3
          }
        }`,
      );
      expect(loadAgentConfig({ configPath }).compaction).toEqual({
        maxSummaryTokens: 5000,
        maxSummaryInputTokens: 24000,
        warningRatio: 0.65,
        compactRatio: 0.7,
        hardRatio: 0.86,
        targetRatio: 0.52,
        minimumReductionRatio: 0.18,
        cooldownTurns: 4,
        recentTurns: 3,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects compaction softRatio outside 0–1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-code-config-'));
    try {
      const configPath = join(dir, 'bad-ratio.jsonc');
      for (const bad of [1.5, -0.1]) {
        writeFileSync(
          configPath,
          `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "softRatio": ${bad} } }`,
        );
        expect(() => loadAgentConfig({ configPath })).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects compaction negative cooldownTurns and recentTurns', () => {
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
        `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "recentTurns": -5 } }`,
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
        `{ "provider": { "ollama": { "models": [{ "name": "x", "default": true }] } }, "compaction": { "warningRatio": 0.01, "compactRatio": 0.5, "hardRatio": 1, "minimumReductionRatio": 0, "targetRatio": 0.01 } }`,
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
