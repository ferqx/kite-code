import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DesktopProject } from '../src/bridge';

const PROJECTS_FILE_LIMIT = 1_048_576;

interface StoredProject {
  path: string;
  lastOpenedAt: number;
}

export function readProjects(directory: string): StoredProject[] {
  const file = join(directory, 'projects.json');
  let metadata: Stats;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw new Error('无法读取已打开项目列表。');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > PROJECTS_FILE_LIMIT)
    throw new Error('项目列表文件无效。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('项目列表格式无效，请检查应用数据目录中的 projects.json。');
  }
  if (!Array.isArray(parsed) || !parsed.every(isStoredProject))
    throw new Error('项目列表格式无效，请检查应用数据目录中的 projects.json。');
  return parsed;
}

export function readProjectDisplay(directory: string): DesktopProject[] {
  return readProjects(directory).map((project) => ({
    ...project,
    directoryMissing: directoryMissing(project.path),
  }));
}

export function canonicalProject(value: string): string {
  let path: string;
  try {
    path = realpathSync.native(value);
  } catch {
    throw new Error('项目目录已不存在或无法访问。');
  }
  try {
    if (!statSync(path).isDirectory()) throw new Error();
  } catch {
    throw new Error('请选择有效的本地项目目录。');
  }
  return path;
}

export function rememberProject(directory: string, path: string): void {
  const projects = readProjects(directory).filter((project) => project.path !== path);
  projects.unshift({ path, lastOpenedAt: Date.now() });
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    throw new Error('无法创建应用数据目录。');
  }
  const temporary = join(directory, `projects-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(projects));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, join(directory, 'projects.json'));
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw new Error('无法保存项目列表。');
  }
}

export function knownProject(directory: string, value: string): string {
  const path = canonicalProject(value);
  if (path !== value || !readProjects(directory).some((project) => project.path === value))
    throw new Error('项目路径已改变或未通过目录选择器添加，请重新添加项目。');
  return path;
}

function directoryMissing(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch (error) {
    return isNodeError(error, 'ENOENT');
  }
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!isExactRecord(value, ['path', 'lastOpenedAt'])) return false;
  return (
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    Number.isSafeInteger(value.lastOpenedAt) &&
    (value.lastOpenedAt as number) >= 0
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
