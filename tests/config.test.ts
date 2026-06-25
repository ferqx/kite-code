import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
    const dir = join(import.meta.dir, '.tmp-config');
    mkdirSync(dir, { recursive: true });
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
  });

  test('loads an explicitly typed OpenAI-compatible provider', () => {
    const dir = join(import.meta.dir, '.tmp-config');
    mkdirSync(dir, { recursive: true });
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
  });

  test('loads an Ollama provider with local defaults', () => {
    const dir = join(import.meta.dir, '.tmp-config');
    mkdirSync(dir, { recursive: true });
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
  });

  test('overrides the configured default provider and model', () => {
    const dir = join(import.meta.dir, '.tmp-config');
    mkdirSync(dir, { recursive: true });
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
  });

  test('overrides to Ollama even when the provider is not configured', () => {
    const dir = join(import.meta.dir, '.tmp-config');
    mkdirSync(dir, { recursive: true });
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
  });
});
