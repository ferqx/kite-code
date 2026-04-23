import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "jsonc-parser";
import { z } from "zod";

const providerSchema = z.object({
  apiKey: z.string().min(1),
  baseURL: z.string().url(),
});

const configSchema = z.object({
  provider: z.record(z.string(), providerSchema),
  model: z.object({
    default: z.object({
      provider: z.string().min(1),
      name: z.string().min(1),
    }),
  }),
});

export interface AgentConfig {
  apiKey: string;
  baseURL: string;
  modelName: string;
  providerName: string;
}

export interface LoadAgentConfigOptions {
  configPath?: string;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".openpx", "openpx.jsonc");
}

export function loadAgentConfig(options: LoadAgentConfigOptions = {}): AgentConfig {
  const configPath = options.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`OpenPX config file not found: ${configPath}`);
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = configSchema.parse(parse(raw));
  const providerName = parsed.model.default.provider;
  const provider = parsed.provider[providerName];

  if (!provider) {
    throw new Error(`Model provider '${providerName}' is not configured`);
  }

  return {
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    modelName: parsed.model.default.name,
    providerName,
  };
}
