import { existsSync } from "node:fs";
import { join } from "node:path";

function resolveProjectRoot(): string {
  return join(import.meta.dirname, "..", "..", "..");
}

/** 定位 vendored bash.exe / Locate the vendored bash.exe */
export function findBashBinary(): string | null {
  const path = join(resolveProjectRoot(), "vendor", "msys2", "usr", "bin", "bash.exe");
  if (existsSync(path)) return path;
  return null;
}

/** 定位 vendored MSYS2 usr/bin 目录（coreutils 所在）/ Locate vendored MSYS2 usr/bin directory (where coreutils live) */
export function getMsys2BinDir(): string | null {
  const path = join(resolveProjectRoot(), "vendor", "msys2", "usr", "bin");
  if (existsSync(path)) return path;
  return null;
}
