import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillScanOptions } from '@/core/skills/types';

/** 动态解析 KITE_CODE_DIR，确保运行时修改 KITE_CODE_HOME 生效（e2e 测试需要） */
function getKiteCodeDir(): string {
  return join(process.env.KITE_CODE_HOME ?? homedir(), '.kite-code');
}

export function defaultConfigPath(): string {
  return join(getKiteCodeDir(), 'kite-code.jsonc');
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
