import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillScanOptions } from '@/core/skills/types';

/** 动态解析 OPENPX_DIR，确保运行时修改 OPENPX_HOME 生效（e2e 测试需要） */
function getOpenpxDir(): string {
  return join(process.env.OPENPX_HOME ?? homedir(), '.openpx');
}

export function defaultConfigPath(): string {
  return join(getOpenpxDir(), 'openpx.jsonc');
}

export function projectConfigPath(workspace?: string): string {
  return join(workspace ?? process.cwd(), '.openpx', 'openpx.jsonc');
}

export function defaultCheckpointPath(): string {
  return join(getOpenpxDir(), 'checkpoints.sqlite');
}

export function editorInputPath(suffix: string): string {
  return join(getOpenpxDir(), `editor-input-${suffix}.md`);
}

export function sessionExportPath(timestamp: string): string {
  return join(getOpenpxDir(), `session-${timestamp}.md`);
}

export function skillDirs(workspace: string): SkillScanOptions {
  return {
    projectOpenpxSkillsDir: join(workspace, '.openpx', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
    userOpenpxSkillsDir: join(getOpenpxDir(), 'skills'),
    userAgentsSkillsDir: join(homedir(), '.agents', 'skills'),
  };
}
