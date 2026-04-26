import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "jsonc-parser";
import { z } from "zod";

const providerSchema = z.object({
  type: z.enum(["deepseek", "openai", "openai-compatible"]).optional(),
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

export type ModelProviderType = "deepseek" | "openai" | "openai-compatible";

/** Agent 配置 / Agent configuration */
export interface AgentConfig {
  /** API 密钥 / API key */
  apiKey: string;
  /** API 基础 URL / API base URL */
  baseURL: string;
  /** 模型名称 / Model name */
  modelName: string;
  /** 提供商名称 / Provider name */
  providerName: string;
  /** LangChain adapter 类型 / LangChain adapter type */
  providerType: ModelProviderType;
}

/** 加载配置选项 / Configuration loading options */
export interface LoadAgentConfigOptions {
  /** 配置文件路径 / Configuration file path */
  configPath?: string;
}

/** 获取默认配置路径 / Get default configuration path */
export function defaultConfigPath(): string {
  return join(homedir(), ".openpx", "openpx.jsonc");
}

/** 加载并解析 Agent 配置 / Load and parse agent configuration */
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

  const providerType = provider.type ?? inferProviderType(providerName);

  return {
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    modelName: parsed.model.default.name,
    providerName,
    providerType,
  };
}

function inferProviderType(providerName: string): ModelProviderType {
  return providerName === "deepseek" ? "deepseek" : "openai-compatible";
}
