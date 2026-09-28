# Agent Note: 测试归属与分层执行 V2

Status: implemented

## Problem
Workspace 已有 owner-local tests，但根 `tests/` 仍保存大量 package/App 单元测试和 Runtime 迁移期 parity
测试。默认 runner 依赖中央 ignore 列表、全局 `--max-concurrency=1` 与手工 isolated 文件集合，使测试归属、
发现范围和执行隔离成为同一个脆弱入口。

## Decision
1. 单 workspace 行为测试归 owner 的 `test/`；App/CLI/TUI/composition 测试归
   `apps/kite/test/`；跨 workspace 公共边界归 `tests/integration/`。
2. fault、soak、native 与安全 qualification 归 `tests/qualification/`；TUI system、E2E、release 和 golden
   保持专用套件。
3. 修改进程级环境、cwd、SQLite 文件或真实进程的测试进入 owner-local 或根 `isolated/`，逐文件独立执行。
4. 根 integration 只导入 package exports，不 deep-import package `src/`。不得仅为测试新增生产 public export。
5. 默认 runner 自动发现目录归属；parallel-safe workspace 与 integration 分层并行。原先所有 isolated 文件串行的决定由[逐文件测试受控并行](../testing/2026-09-28-controlled-parallel-isolated-tests.md)部分调整：安全文件可跨独立进程并行，共享资源文件仍全局独占。顶层命令和默认覆盖语义保持不变。
6. parity/cutover 测试只有在每条独有断言被 owner 测试承接后才能删除；历史兼容测试使用领域化
   compatibility 名称继续保留。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
- 新功能测试写入位置由 owner 决定，不再回到中央 Runtime 测试目录。
- 测试隔离由目录表达，不由 runner 内手工文件名单表达。
- 逐文件独立进程、目录归属、专用资格入口和不共享测试进程的理由继续适用。隔离文件的并发与独占条件由[后续决定](../testing/2026-09-28-controlled-parallel-isolated-tests.md)定义；PTY、fault/soak、native 和 live 测试保持独立。

## 回滚
可以降低并发上限或将有共享资源风险的文件移入 `isolated/exclusive/`，但不得恢复中央 ignore 清单、跨包 deep import、未分类根测试或
以删除断言换取速度。

## Historical relationships

决策者：用户直接指令

相关：[Agent Note 0128](../simplification/2026-08-23-pre-release-clean-cutover-module-boundaries.md)、[Agent Note 0140](2026-08-26-workspace-documentation-authority-v2.md)、`tests/README.md`
