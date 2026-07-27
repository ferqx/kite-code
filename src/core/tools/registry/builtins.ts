/**
 * 生产静态工具 Registry（ADR-0043）。
 * Production registry for static builtin tools (ADR-0043).
 *
 * 阶段 1.2 逐工具迁移：每个工具的 Schema、契约、解析、分类与执行器
 * 收敛到 spec；未迁移工具继续走 definitions.ts + tool-runner 旧路径。
 * 六个计算原语已完成 Registry 切换；旧执行路径和迁移 flag 已退役。
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
import { createToolRegistry } from './registry';

/**
 * Const tuple of all builtin tool specs — preserves literal `name` types
 * for deriving `BuiltinToolName` and `PendingBuiltinToolRequest`.
 * The Registry (.register()) still operates via the class for runtime lookup.
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

export const builtinToolRegistry = createToolRegistry()
  .register(askUserSpec)
  .register(readFileSpec)
  .register(readPlanSpec)
  .register(searchContentSpec)
  .register(searchFilesSpec)
  .register(shellExecuteSpec)
  .register(writeFileSpec)
  .register(editFileSpec)
  .register(webFetchSpec)
  .register(listMcpResourcesSpec)
  .register(listMcpToolsSpec)
  .register(readMcpResourceSpec)
  .register(taskSpec)
  .register(toolSearchSpec)
  .register(readSkillReferenceSpec)
  .register(completeSkillSpec)
  .register(activateSkillSpec)
  .register(updatePlanSpec)
  .register(writePlanSpec);

/**
 * 可辨识工具请求联合 — name→args 关联由对应 spec 的 Input 类型保证。
 * 从 const tuple 元素推导，每个 spec 的 Zod Input 类型是 args 的单一来源。
 * 新增工具时在此加一行即可，编译期自动校验 args 类型与 spec 一致。
 */
export type PendingBuiltinToolRequest =
  | MakeRequest<'ask_user', import('@/protocol/events').UserInputRequest>
  | MakeRequest<'read_file', import('./builtins/read-file').ReadFileInput>
  | MakeRequest<'read_plan', import('./builtins/read-plan').ReadPlanInput>
  | MakeRequest<'search_content', import('./builtins/search-content').SearchContentInput>
  | MakeRequest<'search_files', import('./builtins/search-files').SearchFilesInput>
  | MakeRequest<'shell_execute', import('@/core/types').ShellActionEnvelope>
  | MakeRequest<'write_file', import('./builtins/write-file').WriteFileToolInput>
  | MakeRequest<'edit_file', import('./builtins/edit-file').EditFileToolInput>
  | MakeRequest<'web_fetch', import('./builtins/web-fetch').WebFetchInput>
  | MakeRequest<'list_mcp_resources', import('./builtins/mcp-inventory').ListMcpResourcesInput>
  | MakeRequest<'list_mcp_tools', import('./builtins/mcp-inventory').ListMcpToolsInput>
  | MakeRequest<'read_mcp_resource', import('./builtins/mcp-inventory').ReadMcpResourceInput>
  | MakeRequest<'task', import('./builtins/task').TaskInput>
  | MakeRequest<'tool_search', import('./builtins/tool-search').ToolSearchInput>
  | MakeRequest<'read_skill_reference', import('./builtins/skill-runtime').ReadSkillReferenceInput>
  | MakeRequest<'complete_skill', import('./builtins/skill-runtime').CompleteSkillInput>
  | MakeRequest<'activate_skill', import('./builtins/skill-runtime').ActivateSkillInput>
  | MakeRequest<'update_plan', import('./builtins/update-plan').UpdatePlanInput>
  | MakeRequest<'write_plan', import('./builtins/write-plan').WritePlanInput>;

type MakeRequest<Name extends string, Args> = {
  id?: string;
  name: Name;
  args: Args;
  reason: string;
  protectedCommand: string;
};
