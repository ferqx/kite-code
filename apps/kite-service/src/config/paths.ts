import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillScanOptions } from '@kite-ai/runtime-contract';

/**
 * Service-owned state root. The manager passes KITE_CODE_HOME as the exact,
 * validated KiteHomeIdentity root; unlike the legacy CLI value it must not
 * receive another `.kite-code` suffix.
 */
function getKiteCodeDir(): string {
  return process.env.KITE_CODE_HOME ?? join(homedir(), '.kite-code');
}

/** User-level Kite Code directory used by durable control-plane artifacts. */
export function userKiteCodeDir(): string {
  return getKiteCodeDir();
}

export function defaultConfigPath(): string {
  return join(getKiteCodeDir(), 'kite-code.jsonc');
}

/** User-level MCP configuration shared by all workspaces. */
export function userMcpConfigPath(): string {
  return join(getKiteCodeDir(), 'mcp.json');
}

/** Project-controlled MCP configuration. */
export function projectMcpConfigPath(workspace?: string): string {
  return join(workspace ?? process.cwd(), '.kite-code', 'mcp.json');
}

/** Local decisions authorizing exact project MCP server declarations. */
export function mcpProjectApprovalPath(): string {
  return join(getKiteCodeDir(), 'mcp-project-approvals.jsonc');
}

/** Local records of workspaces the user has explicitly trusted to run the agent. */
export function workspaceTrustPath(): string {
  return join(getKiteCodeDir(), 'workspace-trust.jsonc');
}

export function projectConfigPath(workspace?: string): string {
  return join(workspace ?? process.cwd(), '.kite-code', 'kite-code.jsonc');
}

export function defaultCheckpointPath(): string {
  return join(getKiteCodeDir(), 'checkpoints.sqlite');
}

export function editorInputPath(suffix: string): string {
  return join(getKiteCodeDir(), `editor-input-${suffix}.md`);
}

export function sessionExportPath(timestamp: string): string {
  return join(getKiteCodeDir(), `session-${timestamp}.md`);
}

/** Root directory for immutable user-level Plan Artifacts. */
export function planArtifactRoot(): string {
  return join(getKiteCodeDir(), 'plans');
}

export interface SkillDirsOverrides {
  readonly userKiteCodeSkillsDir?: string;
  readonly userAgentsSkillsDir?: string;
}

export function skillDirs(workspace: string, overrides: SkillDirsOverrides = {}): SkillScanOptions {
  return {
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
    userKiteCodeSkillsDir: overrides.userKiteCodeSkillsDir ?? join(getKiteCodeDir(), 'skills'),
    userAgentsSkillsDir: overrides.userAgentsSkillsDir ?? join(homedir(), '.agents', 'skills'),
  };
}

/** 会话日志目录：~/.kite-code/sessions/<frontend>/<threadId>/
 *  按平台分子目录，Agent 可通过 frontend + threadId 自定位日志。 */
export function sessionLogRoot(): string {
  return join(getKiteCodeDir(), 'sessions');
}

export function sessionLogFrontendDir(frontend: string): string {
  return join(sessionLogRoot(), frontend);
}

export function sessionLogDir(frontend: string, threadId: string): string {
  return join(sessionLogFrontendDir(frontend), threadId);
}
