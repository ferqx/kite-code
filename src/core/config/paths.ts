import { join } from "node:path";
import { homedir } from "node:os";

const OPENPX_DIR = join(homedir(), ".openpx");

export function defaultConfigPath(): string {
  return join(OPENPX_DIR, "openpx.jsonc");
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
