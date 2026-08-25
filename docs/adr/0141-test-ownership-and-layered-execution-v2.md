# ADR-0141：测试归属与分层执行 V2

状态：accepted

日期：2026-08-25

决策者：用户直接指令

相关：ADR-0128、ADR-0140、`tests/README.md`

## 背景

Workspace 已有 owner-local tests，但根 `tests/` 仍保存大量 package/App 单元测试和 Runtime 迁移期 parity
测试。默认 runner 依赖中央 ignore 列表、全局 `--max-concurrency=1` 与手工 isolated 文件集合，使测试归属、
发现范围和执行隔离成为同一个脆弱入口。

## 决策

1. 单 workspace 行为测试归 owner 的 `test/`；App/CLI/TUI/composition 测试归
   `apps/kite/test/`；跨 workspace 公共边界归 `tests/integration/`。
2. fault、soak、native 与安全 qualification 归 `tests/qualification/`；TUI system、E2E、release 和 golden
   保持专用套件。
3. 修改进程级环境、cwd、SQLite 文件或真实进程的测试进入 owner-local 或根 `isolated/`，逐文件独立执行。
4. 根 integration 只导入 package exports，不 deep-import package `src/`。不得仅为测试新增生产 public export。
5. 默认 runner 自动发现目录归属；parallel-safe workspace 与 integration 分层并行，isolated 串行。顶层命令和
   默认覆盖语义保持不变。
6. parity/cutover 测试只有在每条独有断言被 owner 测试承接后才能删除；历史兼容测试使用领域化
   compatibility 名称继续保留。

## 后果

- 新功能测试写入位置由 owner 决定，不再回到中央 Runtime 测试目录。
- 测试隔离由目录表达，不由 runner 内手工文件名单表达。
- 并发只用于已证明不修改进程级全局状态的套件；PTY、fault/soak、native 和 live 测试保持独立。

## 回滚

可以降低并发上限或将不稳定文件移入 isolated，但不得恢复中央 ignore 清单、跨包 deep import、未分类根测试或
以删除断言换取速度。
