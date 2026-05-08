import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ResourceLimits } from "./types";
import { DEFAULT_RESOURCE_LIMITS } from "./types";

/** shell 执行前注入的资源限制脚本 / Resource limit preamble injected before shell commands */
export function buildUlimitPreamble(limits: Partial<ResourceLimits> = {}): string {
  const resolved = { ...DEFAULT_RESOURCE_LIMITS, ...limits };
  const parts: string[] = [];
  if (resolved.cpuTime > 0) parts.push(`ulimit -t ${resolved.cpuTime}`);
  if (resolved.fileSize > 0) parts.push(`ulimit -f ${resolved.fileSize}`);
  if (resolved.fileDescriptors > 0) parts.push(`ulimit -n ${resolved.fileDescriptors}`);
  if (resolved.virtualMemory > 0) parts.push(`ulimit -v ${resolved.virtualMemory}`);
  if (resolved.processes > 0) parts.push(`ulimit -u ${resolved.processes}`);
  if (parts.length === 0) return "";
  return parts.join(" ; ") + " ; ";
}

/** 构建硬化后的环境变量 / Build hardened environment variables */
export function buildHardenedEnv(workspace: string): Record<string, string> {
  const sandboxHome = join(workspace, ".sandbox-home");
  const sandboxTmp = join(workspace, ".sandbox-tmp");
  const sandboxBunCache = join(workspace, ".sandbox-bun-cache");

  // 确保沙箱目录存在 / Ensure sandbox directories exist
  mkdirSync(sandboxHome, { recursive: true });
  mkdirSync(sandboxTmp, { recursive: true });
  mkdirSync(sandboxBunCache, { recursive: true });

  // 保留安全的环境变量 / Keep safe environment variables
  const env: Record<string, string> = {};

  // 传递安全的白名单变量 / Pass through safe allowlisted variables
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // 重定向可写目录到工作区 / Redirect writable directories into workspace
  env["HOME"] = sandboxHome;
  env["TMPDIR"] = sandboxTmp;
  env["TMP"] = sandboxTmp;
  env["TEMP"] = sandboxTmp;
  env["XDG_CACHE_HOME"] = join(workspace, ".sandbox-home", ".cache");
  env["BUN_INSTALL_CACHE_DIR"] = sandboxBunCache;

  return env;
}

/** 需要从父进程传递的安全环境变量 / Safe environment variables to inherit from parent */
const SAFE_ENV_KEYS = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "DISPLAY",
];

/** 剥离危险环境变量的 shell 片段 / Shell snippet to strip dangerous environment variables */
export function buildEnvStripSnippet(): string {
  const DANGEROUS_VARS = [
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "NODE_OPTIONS",
    "BUN_RUNTIME",
    "BUN_CONFIG",
    "PYTHONPATH",
    "PYTHONHOME",
    "PERL5LIB",
    "RUBYOPT",
    "GEM_HOME",
    "GEM_PATH",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "CLASSPATH",
    "GRADLE_OPTS",
    "MAVEN_OPTS",
    "SBT_OPTS",
  ];

  return DANGEROUS_VARS.map((v) => `unset ${v}`).join(" ; ") + " ; ";
}

/** 构建环境变量 export shell 片段 / Build environment variable export shell snippet */
export function buildEnvExportSnippet(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`)
    .join(" ; ") + " ; ";
}
