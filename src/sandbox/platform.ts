import { existsSync } from "node:fs";

/** 检查当前平台是否支持沙箱（macOS sandbox-exec）/ Check if sandbox is available on current platform */
export function isSandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  return existsSync("/usr/bin/sandbox-exec");
}
