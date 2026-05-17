import { existsSync, readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { z } from "zod";
import { defaultConfigPath } from "./paths";

const providerSchema = z.object({
  type: z.enum(["deepseek", "openai", "openai-compatible", "ollama"]).optional(),
  apiKey: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
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

export type ModelProviderType = "deepseek" | "openai" | "openai-compatible" | "ollama";

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
  /** 覆盖默认 provider 名称 / Override default provider name */
  providerName?: string;
  /** 覆盖默认模型名称 / Override default model name */
  modelName?: string;
}

export { defaultConfigPath, defaultCheckpointPath, editorInputPath, sessionExportPath } from "./paths";

/** 加载并解析 Agent 配置 / Load and parse agent configuration */
export function loadAgentConfig(options: LoadAgentConfigOptions = {}): AgentConfig {
  const configPath = options.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`OpenPX config file not found: ${configPath}`);
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = configSchema.parse(parse(raw));
  const providerName = options.providerName ?? parsed.model.default.provider;
  const provider = parsed.provider[providerName] ?? builtInProvider(providerName);

  if (!provider) {
    throw new Error(`Model provider '${providerName}' is not configured`);
  }

  const providerType = provider.type ?? inferProviderType(providerName);

  return {
    apiKey: resolveProviderApiKey(providerName, providerType, provider.apiKey),
    baseURL: resolveProviderBaseURL(providerName, providerType, provider.baseURL),
    modelName: options.modelName ?? parsed.model.default.name,
    providerName,
    providerType,
  };
}

function inferProviderType(providerName: string): ModelProviderType {
  if (providerName === "deepseek") {
    return "deepseek";
  }
  if (providerName === "ollama") {
    return "ollama";
  }
  return "openai-compatible";
}

function builtInProvider(
  providerName: string,
): z.infer<typeof providerSchema> | null {
  if (providerName === "ollama") {
    return { type: "ollama" };
  }
  return null;
}

function resolveProviderApiKey(
  providerName: string,
  providerType: ModelProviderType,
  apiKey: string | undefined,
): string {
  if (apiKey) {
    return apiKey;
  }
  if (providerType === "ollama") {
    return "";
  }
  throw new Error(`Model provider '${providerName}' requires apiKey`);
}

function resolveProviderBaseURL(
  providerName: string,
  providerType: ModelProviderType,
  baseURL: string | undefined,
): string {
  if (baseURL) {
    return baseURL;
  }
  if (providerType === "ollama") {
    return "http://localhost:11434";
  }
  throw new Error(`Model provider '${providerName}' requires baseURL`);
}
