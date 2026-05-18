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
  const sandboxTmp = join(workspace, ".sandbox-tmp");
  const sandboxBunCache = join(workspace, ".sandbox-bun-cache");

  // 确保沙箱目录存在 / Ensure sandbox directories exist
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

  // HOME 继承真实值，`~` 展开到真实用户目录。dotfile 写入由
  // checkDangerousPaths + tool-policy 审批流拦截，不再需要假 HOME。
  // Inherit real HOME so `~` resolves to the actual user directory.
  // Dotfile writes are blocked by checkDangerousPaths + tool-policy approval.
  if (process.env.HOME) {
    env["HOME"] = process.env.HOME;
  }

  // 重定向临时目录和缓存到工作区 / Redirect temp dirs and caches into workspace
  env["TMPDIR"] = sandboxTmp;
  env["TMP"] = sandboxTmp;
  env["TEMP"] = sandboxTmp;
  env["XDG_CACHE_HOME"] = join(sandboxTmp, ".cache");
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

/**
 * 检测命令中是否引用了危险文件路径
 * 防止 agent 修改 shell 配置、git hooks、SSH 密钥等持久化/提权文件
 *
 * Check if a command references dangerous file paths
 * Prevents agent from modifying shell configs, git hooks, SSH keys, etc.
 */
export function checkDangerousPaths(command: string): string | null {
  for (const pattern of DANGEROUS_PATH_PATTERNS) {
    const match = command.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** 危险文件路径模式 / Dangerous file path patterns */
const DANGEROUS_PATHS = [
  // Shell 配置文件（持久化入口）/ Shell config files (persistence entry point)
  ".bashrc",
  ".bash_profile",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zlogout",
  ".profile",
  ".cshrc",
  ".tcshrc",
  ".kshrc",
  ".config/fish/",
  // Git 钩子和配置（代码执行钩子）/ Git hooks and config (code execution hooks)
  ".git/config",
  ".git/hooks/",
  ".gitmodules",
  // SSH 密钥和授权（横向移动）/ SSH keys and authorization (lateral movement)
  ".ssh/authorized_keys",
  ".ssh/authorized_keys2",
  ".ssh/config",
  ".ssh/id_",
  ".ssh/known_hosts",
  // IDE / Agent 配置文件（行为篡改）/ IDE / Agent config files (behavior tampering)
  ".claude/settings.json",
  ".claude/commands/",
  ".claude/agents/",
  ".vscode/settings.json",
  ".vscode/tasks.json",
  ".vscode/launch.json",
  ".vscode/extensions.json",
  ".idea/",
  // 凭据和密钥文件（数据窃取）/ Credential and secret files (data exfiltration)
  ".aws/credentials",
  ".aws/config",
  ".npmrc",
  ".yarnrc",
  ".netrc",
  ".git-credentials",
  ".env",
  ".env.local",
  ".env.production",
  // 系统配置 / System configuration
  "/etc/crontab",
  "/etc/cron.d/",
  "/etc/sudoers",
  "/etc/sudoers.d/",
  "/etc/passwd",
  "/etc/shadow",
  "/etc/group",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/ssh/sshd_config",
  "/etc/ssh/ssh_config",
  "crontab",
  // 持久化机制 — 重启后自动执行（参考 Codex CLI）/ Persistence — auto-start after reboot
  "Library/LaunchAgents/",
  "Library/LaunchDaemons/",
  ".config/systemd/user/",
  "/etc/systemd/system/",
  ".config/autostart/",
  // Docker 凭证（Registry 凭据泄露）/ Docker credentials
  ".docker/config.json",
  ".docker/daemon.json",
];

/** 从危险路径列表编译的正则模式 / Regex patterns compiled from dangerous path list */
const DANGEROUS_PATH_PATTERNS: RegExp[] = DANGEROUS_PATHS.map((path) => {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = `(?:\\s|>|>>|'|"|/|~|^)`;
  if (path.endsWith("/")) {
    // 目录模式：允许匹配子路径（如 .git/hooks/ 匹配 .git/hooks/pre-commit）
    return new RegExp(`${prefix}(${escaped})`, "i");
  }
  // 文件模式：要求路径边界，防止部分匹配（如 .ssh/authorized_keys 不匹配 authorized_keys2）
  return new RegExp(`${prefix}(${escaped})(?:\\s|'|"|$|/|>)`, "i");
});
