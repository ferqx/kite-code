/**
 * 生产静态工具 Registry（ADR-0026）。
 * Production registry for static builtin tools (ADR-0026).
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
