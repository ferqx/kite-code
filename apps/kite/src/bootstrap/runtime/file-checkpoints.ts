/**
 * 文件检查点（ADR-0042 §4）：写入前原像的记录入口与回退恢复。
 * File checkpoints (ADR-0042 §4): pre-write pre-image recording entry and
 * rewind restore.
 *
 * 语义 / Semantics:
 * - 工具（write_file/edit_file）改动工作区文件前，经 `recordFilePreimage`
 *   在 StateRuntimeStorage 记录目标文件原像（best-effort，失败静默）。
 * - `/rewind` 回退到命名检查点时，先调用 `restoreFilesToCheckpoint` 把工作区
 *   文件恢复到检查点时刻的状态，再执行 `store.restoreNamedSnapshot`（后者会
 *   截断检查点之后的原像行，顺序不可颠倒）。
 * - fork 只复制原像行、不改动共享工作区的文件（与 Claude Code 一致）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { workspaceFilesystemContentHash as fileContentHash } from '@kite/builtin-runtime/filesystem';
import type { RuntimeHostFilePreimageRecorder } from '@kite/runtime-host/storage';
import type { StateRuntimeStorage } from './state-runtime';

function normalizeEOL(content: string): string {
  return content.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

/**
 * 文件原像记录器：由 runtime 层（executor）注入到工具执行链。
 * best-effort —— 实现必须吞掉自身错误，绝不允许中断工具执行。
 * File pre-image recorder injected from the runtime layer into the tool
 * execution chain. Best-effort: implementations must swallow their own errors.
 */
export type FilePreimageRecorder = RuntimeHostFilePreimageRecorder;

/** 为指定线程构造原像记录器；store/threadId 缺省时返回 undefined（无处落库）。 */
export function createFilePreimageRecorder(
  store: StateRuntimeStorage | undefined,
  threadId: string,
): FilePreimageRecorder | undefined {
  if (!store || !threadId) return undefined;
  const recorder: FilePreimageRecorder = (path, content, existed) => {
    try {
      store.checkpoints.recordFilePreimage(threadId, path, content, existed);
    } catch {
      /* best-effort：记录失败不得影响工具执行 */
    }
  };
  recorder.recordPostimage = (path, content, existed) => {
    try {
      store.checkpoints.recordFilePostimage(
        threadId,
        path,
        existed && content != null ? fileContentHash(normalizeEOL(content)) : null,
        existed,
      );
    } catch {
      /* best-effort：记录失败不得影响工具执行 */
    }
  };
  return recorder;
}

export interface FileRestoreOutcome {
  /** 恢复为原像内容的文件 / files restored to their pre-image content */
  restored: string[];
  /** 检查点时不存在而被删除的文件 / files removed (did not exist at checkpoint) */
  deleted: string[];
  /** 恢复失败的文件（不阻断会话回退）/ files that failed to restore */
  failed: Array<{ path: string; error: string }>;
  /** 当前内容不再匹配 Kite 最后写入结果，已跳过以保护后续修改。 */
  conflicts: Array<{
    path: string;
    reason: 'modified_after_kite_write' | 'unverified_postimage';
  }>;
}

export interface FileRestorePreview {
  /** Paths that can currently be restored, ordered by the size of their change. */
  files: Array<{ path: string; addedLines: number; removedLines: number }>;
  /** Whether every restorable path could be included in the exact line totals. */
  lineStatsAvailable: boolean;
  addedLines: number;
  removedLines: number;
  conflictCount: number;
  failureCount: number;
}

type FileRestorePlanItem = ReturnType<
  StateRuntimeStorage['checkpoints']['fileRestorePlan']
>[number];

type RestoreCandidate =
  | { kind: 'unchanged' }
  | { kind: 'restore'; currentContent: string | null }
  | { kind: 'conflict'; reason: FileRestoreOutcome['conflicts'][number]['reason'] }
  | { kind: 'failed'; error: string };

function resolveRestoreTarget(path: string, workspace: string): string {
  return isAbsolute(path) ? path : join(workspace, path);
}

function inspectRestoreCandidate(item: FileRestorePlanItem, target: string): RestoreCandidate {
  try {
    const currentExists = existsSync(target);
    const currentContent = currentExists ? normalizeEOL(readFileSync(target, 'utf8')) : null;
    const desiredContent = normalizeEOL(item.content ?? '');
    const desiredAlreadyPresent =
      item.existed &&
      currentExists &&
      currentContent != null &&
      fileContentHash(currentContent) === fileContentHash(desiredContent);
    const desiredAlreadyAbsent = !item.existed && !currentExists;
    if (desiredAlreadyPresent || desiredAlreadyAbsent) return { kind: 'unchanged' };

    if (item.postExisted == null || (item.postExisted && !item.postHash)) {
      return { kind: 'conflict', reason: 'unverified_postimage' };
    }

    const stillMatchesLastKiteWrite = item.postExisted
      ? currentExists && currentContent != null && fileContentHash(currentContent) === item.postHash
      : !currentExists;
    if (!stillMatchesLastKiteWrite) {
      return { kind: 'conflict', reason: 'modified_after_kite_write' };
    }

    return { kind: 'restore', currentContent };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

function contentLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const MAX_PREVIEW_DIFF_LINES = 100_000;

/** Count a shortest line-level edit script with bounded Myers diff work. */
function lineChangeStats(
  currentContent: string,
  desiredContent: string,
): {
  addedLines: number;
  removedLines: number;
} | null {
  const current = contentLines(currentContent);
  const desired = contentLines(desiredContent);
  let currentStart = 0;
  let desiredStart = 0;
  while (
    currentStart < current.length &&
    desiredStart < desired.length &&
    current[currentStart] === desired[desiredStart]
  ) {
    currentStart++;
    desiredStart++;
  }
  let currentEnd = current.length;
  let desiredEnd = desired.length;
  while (
    currentEnd > currentStart &&
    desiredEnd > desiredStart &&
    current[currentEnd - 1] === desired[desiredEnd - 1]
  ) {
    currentEnd--;
    desiredEnd--;
  }

  const oldLines = current.slice(currentStart, currentEnd);
  const newLines = desired.slice(desiredStart, desiredEnd);
  if (oldLines.length === 0 || newLines.length === 0) {
    return { addedLines: newLines.length, removedLines: oldLines.length };
  }
  const oldLineSet = new Set(oldLines);
  if (!newLines.some((line) => oldLineSet.has(line))) {
    return { addedLines: newLines.length, removedLines: oldLines.length };
  }

  const max = oldLines.length + newLines.length;
  if (max > MAX_PREVIEW_DIFF_LINES) return null;
  const offset = max + 1;
  const frontier = new Int32Array(max * 2 + 3);
  let steps = 0;
  for (let distance = 0; distance <= max; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++steps > 500_000) return null;
      const position = offset + diagonal;
      let oldIndex: number;
      if (
        diagonal === -distance ||
        (diagonal !== distance && frontier[position - 1]! < frontier[position + 1]!)
      ) {
        oldIndex = frontier[position + 1]!;
      } else {
        oldIndex = frontier[position - 1]! + 1;
      }
      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < oldLines.length &&
        newIndex < newLines.length &&
        oldLines[oldIndex] === newLines[newIndex]
      ) {
        oldIndex++;
        newIndex++;
      }
      frontier[position] = oldIndex;
      if (oldIndex === oldLines.length && newIndex === newLines.length) {
        const addedLines = (distance + newLines.length - oldLines.length) / 2;
        return { addedLines, removedLines: distance - addedLines };
      }
    }
  }
  return null;
}

/** Preview the paths and line changes that can safely be restored right now. */
export function previewFilesToCheckpoint(
  store: StateRuntimeStorage,
  threadId: string,
  snapshotId: string,
  workspace: string,
): FileRestorePreview {
  const preview: FileRestorePreview = {
    files: [],
    lineStatsAvailable: true,
    addedLines: 0,
    removedLines: 0,
    conflictCount: 0,
    failureCount: 0,
  };
  const entry = store.checkpoints.getNamedSnapshotEntry(threadId, snapshotId);
  if (!entry) return preview;

  for (const item of store.checkpoints.fileRestorePlan(threadId, entry.eventPosition)) {
    const candidate = inspectRestoreCandidate(item, resolveRestoreTarget(item.path, workspace));
    if (candidate.kind === 'conflict') {
      preview.conflictCount++;
      continue;
    }
    if (candidate.kind === 'failed') {
      preview.failureCount++;
      continue;
    }
    if (candidate.kind === 'unchanged') continue;

    const stats = lineChangeStats(
      candidate.currentContent ?? '',
      item.existed ? normalizeEOL(item.content ?? '') : '',
    );
    if (!stats) preview.lineStatsAvailable = false;
    const filePreview = {
      path: item.path,
      addedLines: stats?.addedLines ?? 0,
      removedLines: stats?.removedLines ?? 0,
    };
    preview.files.push(filePreview);
    preview.addedLines += filePreview.addedLines;
    preview.removedLines += filePreview.removedLines;
  }
  preview.files.sort(
    (left, right) =>
      right.addedLines + right.removedLines - (left.addedLines + left.removedLines) ||
      left.path.localeCompare(right.path),
  );
  return preview;
}

/**
 * 将工作区文件恢复到命名检查点时刻的状态。
 * Restore workspace files to their state at a named recovery point.
 *
 * 必须在 `store.restoreNamedSnapshot` 之前调用：恢复点截断会删除其后的原像。
 * Must be called BEFORE `store.restoreNamedSnapshot`, which truncates
 * pre-images beyond the restored position.
 *
 * 路径键与写入时对称：相对路径基于 workspace 解析，绝对路径原样使用。
 * 工具层已对外部路径做过授权校验，恢复只会触及曾被批准写入的文件。
 */
export function restoreFilesToCheckpoint(
  store: StateRuntimeStorage,
  threadId: string,
  snapshotId: string,
  workspace: string,
): FileRestoreOutcome {
  const outcome: FileRestoreOutcome = { restored: [], deleted: [], failed: [], conflicts: [] };
  const entry = store.checkpoints.getNamedSnapshotEntry(threadId, snapshotId);
  if (!entry) return outcome;
  for (const item of store.checkpoints.fileRestorePlan(threadId, entry.eventPosition)) {
    const target = resolveRestoreTarget(item.path, workspace);
    const candidate = inspectRestoreCandidate(item, target);
    if (candidate.kind === 'unchanged') continue;
    if (candidate.kind === 'conflict') {
      outcome.conflicts.push({ path: item.path, reason: candidate.reason });
      continue;
    }
    if (candidate.kind === 'failed') {
      outcome.failed.push({ path: item.path, error: candidate.error });
      continue;
    }
    try {
      if (!item.existed) {
        if (existsSync(target)) {
          rmSync(target, { force: true });
          outcome.deleted.push(item.path);
        }
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, item.content ?? '', 'utf8');
        outcome.restored.push(item.path);
      }
    } catch (error) {
      outcome.failed.push({
        path: item.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}
