/**
 * 文件检查点（ADR-0025 §4）：写入前原像的记录入口与回退恢复。
 * File checkpoints (ADR-0025 §4): pre-write pre-image recording entry and
 * rewind restore.
 *
 * 语义 / Semantics:
 * - 工具（write_file/edit_file）改动工作区文件前，经 `recordFilePreimage`
 *   在 RuntimeStore 记录目标文件原像（best-effort，失败静默）。
 * - `/rewind` 回退到命名检查点时，先调用 `restoreFilesToCheckpoint` 把工作区
 *   文件恢复到检查点时刻的状态，再执行 `store.restoreNamedSnapshot`（后者会
 *   截断检查点之后的原像行，顺序不可颠倒）。
 * - fork 只复制原像行、不改动共享工作区的文件（与 Claude Code 一致）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { RuntimeStore } from './store';

/**
 * 文件原像记录器：由 runtime 层（executor）注入到工具执行链。
 * best-effort —— 实现必须吞掉自身错误，绝不允许中断工具执行。
 * File pre-image recorder injected from the runtime layer into the tool
 * execution chain. Best-effort: implementations must swallow their own errors.
 */
export type FilePreimageRecorder = (path: string, content: string | null, existed: boolean) => void;

/** 为指定线程构造原像记录器；store/threadId 缺省时返回 undefined（无处落库）。 */
export function createFilePreimageRecorder(
  store: RuntimeStore | undefined,
  threadId: string,
): FilePreimageRecorder | undefined {
  if (!store || !threadId) return undefined;
  return (path, content, existed) => {
    try {
      store.recordFilePreimage(threadId, path, content, existed);
    } catch {
      /* best-effort：记录失败不得影响工具执行 */
    }
  };
}

export interface FileRestoreOutcome {
  /** 恢复为原像内容的文件 / files restored to their pre-image content */
  restored: string[];
  /** 检查点时不存在而被删除的文件 / files removed (did not exist at checkpoint) */
  deleted: string[];
  /** 恢复失败的文件（不阻断会话回退）/ files that failed to restore */
  failed: Array<{ path: string; error: string }>;
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
  store: RuntimeStore,
  threadId: string,
  snapshotId: string,
  workspace: string,
): FileRestoreOutcome {
  const outcome: FileRestoreOutcome = { restored: [], deleted: [], failed: [] };
  const entry = store.getNamedSnapshotEntry(threadId, snapshotId);
  if (!entry) return outcome;
  for (const item of store.fileRestorePlan(threadId, entry.eventPosition)) {
    const target = isAbsolute(item.path) ? item.path : join(workspace, item.path);
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
