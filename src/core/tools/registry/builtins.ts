/**
 * 生产静态工具 Registry（ADR-0026）。
 * Production registry for static builtin tools (ADR-0026).
 *
 * 阶段 1.2 逐工具迁移：每个工具的 Schema、契约、解析、分类与执行器
 * 收敛到 spec；未迁移工具继续走 definitions.ts + tool-runner 旧路径。
 * `toolSpecRegistryV1` 关闭时本 Registry 只参与解析委托，不改变执行语义。
 */
import { readFileSpec } from './builtins/read-file';
import { createToolRegistry } from './registry';

export const builtinToolRegistry = createToolRegistry().register(readFileSpec);
