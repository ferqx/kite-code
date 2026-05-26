import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";
import { z } from "zod";
import { defaultConfigPath } from "./paths";
import type { McpServerConfig } from "../mcp/types";

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
  /** 思考程度，映射到 reasoning_effort API 参数 / Thinking level, mapped to reasoning_effort API param */
  reasoningEffort?: string | null;
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

/** MCP configuration result */
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/**
 * Load MCP server configurations from:
 * 1. openpx.jsonc -> mcpServers section
 * 2. .mcp.json in project root (merged, doesn't override same-name servers)
 */
export function loadMcpConfig(configPath?: string): McpConfig {
  const servers: Record<string, McpServerConfig> = {};

  // 1. openpx.jsonc
  const primaryPath = configPath ?? defaultConfigPath();
  if (existsSync(primaryPath)) {
    const raw = readFileSync(primaryPath, "utf8");
    const parsed = parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "mcpServers" in (parsed as object)
    ) {
      const mcpServers = (parsed as Record<string, unknown>).mcpServers;
      if (mcpServers && typeof mcpServers === "object") {
        for (const [name, cfg] of Object.entries(
          mcpServers as Record<string, unknown>,
        )) {
          if (cfg && typeof cfg === "object") {
            servers[name] = normalizeMcpServerConfig(
              cfg as Record<string, unknown>,
            );
          }
        }
      }
    }
  }

  // 2. .mcp.json
  const projectMcpPath = resolve(process.cwd(), ".mcp.json");
  if (existsSync(projectMcpPath)) {
    const raw = readFileSync(projectMcpPath, "utf8");
    const parsed = parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "mcpServers" in (parsed as object)
    ) {
      const mcpServers = (parsed as Record<string, unknown>).mcpServers;
      if (mcpServers && typeof mcpServers === "object") {
        for (const [name, cfg] of Object.entries(
          mcpServers as Record<string, unknown>,
        )) {
          if (!servers[name] && cfg && typeof cfg === "object") {
            servers[name] = normalizeMcpServerConfig(
              cfg as Record<string, unknown>,
            );
          }
        }
      }
    }
  }

  return { servers };
}

/** Normalize a raw MCP server config object */
function normalizeMcpServerConfig(
  raw: Record<string, unknown>,
): McpServerConfig {
  const type: McpServerConfig["type"] =
    raw.type === "http" ? "http" : "stdio";

  const config: McpServerConfig = { type };

  if (typeof raw.command === "string") {
    config.command = expandEnvVars(raw.command);
  }
  if (Array.isArray(raw.args)) {
    config.args = raw.args
      .filter((a): a is string => typeof a === "string")
      .map(expandEnvVars);
  }
  if (raw.url && typeof raw.url === "string") {
    config.url = expandEnvVars(raw.url);
  }
  if (raw.env && typeof raw.env === "object") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      raw.env as Record<string, unknown>,
    )) {
      if (typeof v === "string") {
        env[k] = expandEnvVars(v);
      }
    }
    config.env = env;
  }
  if (raw.headers && typeof raw.headers === "object") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      raw.headers as Record<string, unknown>,
    )) {
      if (typeof v === "string") {
        headers[k] = expandEnvVars(v);
      }
    }
    config.headers = headers;
  }
  if (raw.risk === "read") {
    config.risk = "read";
  }

  return config;
}

/**
 * Expand environment variable references in a string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
export interface AvailableModel {
  provider: string;
  name: string;
  label: string;
  isDefault: boolean;
}

function fallbackModels(): AvailableModel[] {
  return [
    { provider: "deepseek", name: "deepseek-chat", label: "DeepSeek V4", isDefault: true },
    { provider: "deepseek", name: "deepseek-reasoner", label: "DeepSeek R1", isDefault: false },
    { provider: "openai", name: "gpt-4o", label: "GPT-4o", isDefault: false },
    { provider: "anthropic", name: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", isDefault: false },
  ];
}

export function listAvailableModels(configPath?: string): AvailableModel[] {
  const path = configPath ?? defaultConfigPath();
  if (!existsSync(path)) return fallbackModels();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw) as Record<string, unknown>;
    const models = parsed.models as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(models) || models.length === 0) return fallbackModels();
    return models.map((m) => ({
      provider: String(m.provider ?? ""),
      name: String(m.name ?? ""),
      label: String(m.label ?? m.name ?? ""),
      isDefault: Boolean(m.default),
    }));
  } catch {
    return fallbackModels();
  }
}

export function expandEnvVars(value: string): string {
  return value.replace(
    /\$\{(\w+)(?::-([^}]*))?\}/g,
    (_match, varName: string, defaultValue: string | undefined) => {
      const envValue = process.env[varName];
      if (envValue !== undefined && envValue !== "") {
        return envValue;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      return "";
    },
  );
}
