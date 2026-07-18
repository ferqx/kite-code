import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillScanOptions } from '@/core/skills/types';

/** 动态解析 KITE_CODE_DIR，确保运行时修改 KITE_CODE_HOME 生效（e2e 测试需要） */
function getKiteCodeDir(): string {
  return join(process.env.KITE_CODE_HOME ?? homedir(), '.kite-code');
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

/** Legacy workspace-local MCP config retained for read-only migration compatibility. */
export function localMcpConfigPath(workspaceKey: string): string {
  return join(getKiteCodeDir(), 'projects', workspaceKey, 'mcp.jsonc');
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

/** Deterministic path for one immutable Plan Artifact version. */
export function planArtifactPath(taskId: string, planId: string, version: number): string {
  return join(planArtifactRoot(), taskId, planId, `v${version}.md`);
}

/** Root for access-controlled capability result artifacts, separate from Plan Artifacts. */
export function capabilityArtifactRoot(): string {
  return join(getKiteCodeDir(), 'capability-results');
}

/** Deterministic immutable path for one governed capability invocation result. */
export function capabilityArtifactPath(invocationId: string): string {
  return join(capabilityArtifactRoot(), `${invocationId}.json`);
}

export function skillDirs(workspace: string): SkillScanOptions {
  return {
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
    userKiteCodeSkillsDir: join(getKiteCodeDir(), 'skills'),
    userAgentsSkillsDir: join(homedir(), '.agents', 'skills'),
  };
}

/** 会话日志目录：~/.kite-code/sessions/<frontend>/<threadId>/
 *  按平台分子目录，Agent 可通过 frontend + threadId 自定位日志。 */
export function sessionLogDir(frontend: string, threadId: string): string {
  return join(getKiteCodeDir(), 'sessions', frontend, threadId);
}
