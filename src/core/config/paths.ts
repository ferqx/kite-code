import { join } from "node:path";
import { homedir } from "node:os";
import type { SkillScanOptions } from "@/core/skills/types";

const OPENPX_HOME = process.env.OPENPX_HOME ?? homedir();
const OPENPX_DIR = join(OPENPX_HOME, ".openpx");

export function defaultConfigPath(): string {
  return join(OPENPX_DIR, "openpx.jsonc");
}

export function projectConfigPath(workspace?: string): string {
  return join(workspace ?? process.cwd(), ".openpx", "openpx.jsonc");
}

export function defaultCheckpointPath(): string {
  return join(OPENPX_DIR, "checkpoints.sqlite");
}

export function editorInputPath(suffix: string): string {
  return join(OPENPX_DIR, `editor-input-${suffix}.md`);
}

export function sessionExportPath(timestamp: string): string {
  return join(OPENPX_DIR, `session-${timestamp}.md`);
}

export function skillDirs(workspace: string): SkillScanOptions {
  return {
    projectOpenpxSkillsDir: join(workspace, ".openpx", "skills"),
    projectAgentsSkillsDir: join(workspace, ".agents", "skills"),
    userOpenpxSkillsDir: join(OPENPX_DIR, "skills"),
    userAgentsSkillsDir: join(homedir(), ".agents", "skills"),
  };
}
