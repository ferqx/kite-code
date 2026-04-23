import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfigPath, loadAgentConfig } from "../src/config";

describe("loadAgentConfig", () => {
  test("uses a user-home default config path across operating systems", () => {
    expect(defaultConfigPath()).toBe(join(homedir(), ".openpx", "openpx.jsonc"));
  });

  test("loads DeepSeek provider and default model from JSONC", () => {
    const dir = join(import.meta.dir, ".tmp-config");
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, "openpx.jsonc");
    writeFileSync(
      configPath,
      `{
        "provider": {
          "deepseek": {
            "apiKey": "sk-test",
            "baseURL": "https://api.deepseek.com/v1"
          }
        },
        "model": {
          "default": {
            "provider": "deepseek",
            "name": "deepseek-chat"
          }
        }
      }`,
    );

    const config = loadAgentConfig({ configPath });

    expect(config.apiKey).toBe("sk-test");
    expect(config.baseURL).toBe("https://api.deepseek.com/v1");
    expect(config.modelName).toBe("deepseek-chat");
  });
});
