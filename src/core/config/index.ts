import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";
import { z } from "zod";
import { defaultConfigPath, projectConfigPath } from "./paths";
import type { McpServerConfig } from "../mcp/types";

// ── Zod schemas ──

const providerModelEntrySchema = z.object({
  name: z.string().min(1),
  default: z.boolean().optional(),
});

const providerSchema = z.object({
  type: z.enum(["deepseek", "openai", "openai-compatible", "ollama"]).optional(),
  apiKey: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  models: z.array(providerModelEntrySchema).optional(),
});

// Deprecated: kept for backward compatibility with old top-level models array
const legacyModelEntrySchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  default: z.boolean().optional(),
});

const mcpServerSchema = z.object({
  type: z.enum(["stdio", "http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  risk: z.enum(["read"]).optional(),
});

export const configSchema = z.object({
  provider: z.record(z.string(), providerSchema).optional().default({}),
  /** @deprecated Use provider[name].models instead */
  models: z.array(legacyModelEntrySchema).optional(),
  theme: z.enum(["dark", "light"]).optional(),
  mcpServers: z.record(z.string(), mcpServerSchema).optional().default({}),
});

export type OpenpxConfig = z.infer<typeof configSchema>;

// ── Types ──

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

export { defaultConfigPath, projectConfigPath, defaultCheckpointPath, editorInputPath, sessionExportPath } from "./paths";

// ── Defaults (DeepSeek) ──

const DEFAULT_DEEPSEEK_MODELS: AvailableModel[] = [
  { provider: "deepseek", name: "deepseek-v4-flash", isDefault: true },
  { provider: "deepseek", name: "deepseek-v4-pro", isDefault: false },
];

// ── Config file loading ──

/** Read and parse a single config file. Returns null if not found. */
function readConfigFile(path: string): OpenpxConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return configSchema.parse(parse(raw));
}

/** Merge project config over user config. */
function mergeConfigs(user: OpenpxConfig, project: OpenpxConfig): OpenpxConfig {
  return {
    provider: { ...user.provider, ...project.provider },
    models: project.models ?? user.models,
    theme: project.theme ?? user.theme,
    mcpServers: { ...user.mcpServers, ...project.mcpServers },
  };
}

/**
 * Load and merge user-level (~/.openpx/openpx.jsonc) + project-level (.openpx/openpx.jsonc).
 * Project overrides user.
 * When explicitPath is given, loads only that file (no merge).
 * Falls back to DeepSeek defaults when no config file exists.
 */
function loadConfig(workspace?: string, explicitPath?: string): OpenpxConfig {
  if (explicitPath) {
    const cfg = readConfigFile(explicitPath);
    if (!cfg) {
      throw new Error(`OpenPX config file not found: ${explicitPath}`);
    }
    return cfg;
  }
  const user = readConfigFile(defaultConfigPath());
  const project = readConfigFile(projectConfigPath(workspace));
  if (user && project) return mergeConfigs(user, project);
  if (user) return user;
  if (project) return project;
  // No config file → DeepSeek defaults
  return defaultOpenpxConfig();
}

function defaultOpenpxConfig(): OpenpxConfig {
  return {
    provider: {
      deepseek: {
        type: "deepseek",
        baseURL: "https://api.deepseek.com/v1",
        models: [
          { name: "deepseek-v4-flash", default: true },
          { name: "deepseek-v4-pro" },
        ],
      },
    },
    theme: "dark",
    mcpServers: {},
  };
}

// ── Agent config ──

/** 加载并解析 Agent 配置 / Load and parse agent configuration */
export function loadAgentConfig(options: LoadAgentConfigOptions = {}): AgentConfig {
  const { configPath } = options;
  const cfg = loadConfig(process.cwd(), configPath);

  const defaultModel = findDefaultModel(cfg);

  const providerName = options.providerName ?? defaultModel?.provider ?? "deepseek";
  const provider = cfg.provider?.[providerName] ?? builtInProvider(providerName);

  if (!provider) {
    throw new Error(`Model provider '${providerName}' is not configured`);
  }

  const providerType = provider.type ?? inferProviderType(providerName);

  return {
    apiKey: resolveProviderApiKey(providerName, providerType, provider.apiKey),
    baseURL: resolveProviderBaseURL(providerName, providerType, provider.baseURL),
    modelName: options.modelName ?? defaultModel?.name ?? "deepseek-v4-flash",
    providerName,
    providerType,
  };
}

function inferProviderType(providerName: string): ModelProviderType {
  if (providerName === "deepseek") return "deepseek";
  if (providerName === "ollama") return "ollama";
  return "openai-compatible";
}

function builtInProvider(
  providerName: string,
): z.infer<typeof providerSchema> | null {
  if (providerName === "ollama") return { type: "ollama" };
  if (providerName === "deepseek") return { type: "deepseek", baseURL: "https://api.deepseek.com/v1" };
  return null;
}

/**
 * Find the default model from config.
 * Priority: first model with default:true in provider models > first model of first provider > null
 */
function findDefaultModel(cfg: OpenpxConfig): { provider: string; name: string } | null {
  // Look for explicit default in provider models
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (prov.models) {
      const def = prov.models.find((m) => m.default);
      if (def) return { provider: provName, name: def.name };
    }
  }
  // Fallback: first model of first provider
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (prov.models && prov.models.length > 0) {
      return { provider: provName, name: prov.models[0].name };
    }
  }
  return null;
}

function resolveProviderApiKey(
  providerName: string,
  providerType: ModelProviderType,
  apiKey: string | undefined,
): string {
  if (apiKey) return apiKey;
  if (providerType === "ollama") return "";
  // Try env var: PROVIDERNAME_API_KEY
  const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`];
  if (envKey) return envKey;
  throw new Error(`Model provider '${providerName}' requires apiKey (set ${providerName.toUpperCase()}_API_KEY)`);
}

function resolveProviderBaseURL(
  providerName: string,
  providerType: ModelProviderType,
  baseURL: string | undefined,
): string {
  if (baseURL) return baseURL;
  if (providerType === "ollama") return "http://localhost:11434";
  if (providerType === "deepseek") return "https://api.deepseek.com/v1";
  // Try env var: PROVIDERNAME_BASE_URL
  const envURL = process.env[`${providerName.toUpperCase()}_BASE_URL`];
  if (envURL) return envURL;
  throw new Error(`Model provider '${providerName}' requires baseURL`);
}

// ── MCP config ──

/** MCP configuration result */
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/**
 * Load MCP server configurations from:
 * 1. openpx.jsonc (user + project merged) -> mcpServers section
 * 2. .mcp.json in project root (merged, project mcp doesn't override same-name servers)
 */
export function loadMcpConfig(configPath?: string): McpConfig {
  const servers: Record<string, McpServerConfig> = {};

  // 1. Merged openpx.jsonc
  const cfg = configPath ? readConfigFile(configPath) : loadConfig();
  if (cfg?.mcpServers) {
    for (const [name, raw] of Object.entries(cfg.mcpServers)) {
      servers[name] = normalizeMcpServerConfig(raw as Record<string, unknown>);
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
        for (const [name, cfgEntry] of Object.entries(
          mcpServers as Record<string, unknown>,
        )) {
          if (!servers[name] && cfgEntry && typeof cfgEntry === "object") {
            servers[name] = normalizeMcpServerConfig(
              cfgEntry as Record<string, unknown>,
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

// ── Available models ──

/** 可用模型 / Available model */
export interface AvailableModel {
  provider: string;
  name: string;
  isDefault: boolean;
}

export function listAvailableModels(configPath?: string): AvailableModel[] {
  const cfg = configPath ? readConfigFile(configPath) : loadConfig();
  if (!cfg) return DEFAULT_DEEPSEEK_MODELS;

  // Backward compat: old top-level models array
  if (cfg.models && cfg.models.length > 0) {
    return cfg.models.map((m) => ({
      provider: m.provider,
      name: m.name,
      isDefault: m.default ?? false,
    }));
  }

  // Collect models from providers
  const models: AvailableModel[] = [];
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (prov.models) {
      for (const m of prov.models) {
        models.push({ provider: provName, name: m.name, isDefault: m.default ?? false });
      }
    }
  }
  if (models.length > 0) return models;

  return DEFAULT_DEEPSEEK_MODELS;
}

// ── Theme ──

export type ThemeName = "dark" | "light";

/** Read theme from config. Falls back to "dark". */
export function loadTheme(workspace?: string): ThemeName {
  const cfg = loadConfig(workspace);
  return cfg?.theme ?? "dark";
}

// ── Env var expansion ──

/**
 * Expand environment variable references in a string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
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
