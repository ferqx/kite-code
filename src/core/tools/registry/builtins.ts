/**
 * 生产静态工具 Registry（ADR-0043）。
 * Production registry for static builtin tools (ADR-0043).
 *
 * 每个工具的 Schema、契约、解析、分类与执行器收敛到 spec；const tuple
 * `builtinToolSpecs` 是所有类型的单一事实源 —— PendingBuiltinToolRequest
 * 从 tuple 自动推导，新增工具只需在 tuple 中追加一行，无需同步手写联合。
 */

import { askUserSpec } from './builtins/ask-user';
import { editFileSpec } from './builtins/edit-file';
import {
  listMcpResourcesSpec,
  listMcpToolsSpec,
  readMcpResourceSpec,
} from './builtins/mcp-inventory';
import { readFileSpec } from './builtins/read-file';
import { readPlanSpec } from './builtins/read-plan';
import { searchContentSpec } from './builtins/search-content';
import { searchFilesSpec } from './builtins/search-files';
import { shellExecuteSpec } from './builtins/shell-execute';
import {
  activateSkillSpec,
  completeSkillSpec,
  readSkillReferenceSpec,
} from './builtins/skill-runtime';
import { taskSpec } from './builtins/task';
import { toolSearchSpec } from './builtins/tool-search';
import { updatePlanSpec } from './builtins/update-plan';
import { webFetchSpec } from './builtins/web-fetch';
import { writeFileSpec } from './builtins/write-file';
import { writePlanSpec } from './builtins/write-plan';
import { createToolRegistry, type ToolRegistry } from './registry';

/**
 * Const tuple of all builtin tool specs — preserves literal `name` types
 * via `defineExecutableTool` / `defineInterruptTool`. This is the single source
 * of truth from which `PendingBuiltinToolRequest` and the registry are derived.
 */
export const builtinToolSpecs = [
  askUserSpec,
  readFileSpec,
  readPlanSpec,
  searchContentSpec,
  searchFilesSpec,
  shellExecuteSpec,
  writeFileSpec,
  editFileSpec,
  webFetchSpec,
  listMcpResourcesSpec,
  listMcpToolsSpec,
  readMcpResourceSpec,
  taskSpec,
  toolSearchSpec,
  readSkillReferenceSpec,
  completeSkillSpec,
  activateSkillSpec,
  updatePlanSpec,
  writePlanSpec,
] as const;

/** Registry instance built directly from the const tuple. */
export const builtinToolRegistry: ToolRegistry<(typeof builtinToolSpecs)[number]> =
  createToolRegistry(builtinToolSpecs);

type BuiltinSpec = (typeof builtinToolSpecs)[number];

type RequestOf<Spec> = Spec extends {
  name: infer N extends string;
  inputSchema: import('zod').ZodType<infer A>;
}
  ? { id?: string; name: N; args: A; reason: string; protectedCommand: string }
  : never;

/**
 * 可辨识工具请求联合 — name→args 关联由对应 spec 的 Input 类型自动保证。
 * 从 const tuple 推导，每项 spec 的 Zod Input 类型是 args 的单一来源。
 * 新增工具：只需在 builtinToolSpecs 中追加一行即可。
 */
export type PendingBuiltinToolRequest = RequestOf<BuiltinSpec>;
