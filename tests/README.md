# 测试体系

本页是测试归属、发现和默认执行模型的 current authority。

## 环境基线

Required CI、release/platform smoke 与正式 Runtime qualification 统一使用 Bun `1.4.0`。性能对比只有在
相同 Bun 版本和同类 runner 环境下才可作为正式基线证据；其他本地版本只提供补充诊断。

## 目录归属

- `packages/<owner>/test/`：单 package 行为与 contract。
- `apps/kite/test/`：App、CLI、TUI、配置、Session 和 composition。
- `tests/integration/`：跨 workspace 公共边界，只导入 package exports。
- `tests/qualification/`：fault、soak、native 与安全 qualification。
- `tests/isolated/` 和 owner-local `test/isolated/`：修改进程环境、cwd、SQLite 文件或真实进程的逐文件测试。
- `tests/tui-system/`、`tests/e2e/`、`tests/release/`、`tests/golden/`：稳定专用套件。
- `tests/fixtures/`、`tests/helpers/`、`tests/reliability-harness/`：非测试辅助资源。

根 `tests/` 不保存散落测试文件，也不使用泛化 `tests/runtime/` 作为第二 owner；clean checkout 中该目录
必须不存在，不能依赖 Git 不跟踪的本地空目录满足 discovery gate。

## Import 边界

- Owner-local tests 可以相对导入自己的非公开源码。
- Root integration 只能使用 workspace package exports 或 App 的正式测试/client surface。
- Root tests 不得相对 deep-import `packages/*/src/`。
- 不得仅为测试便利增加 production public export。

## 默认执行

`bun run test` 保持 deterministic 默认覆盖：

1. 以独立进程并行运行 workspace/App parallel-safe tests；
2. 并行运行 root integration；
3. 逐文件、逐进程串行运行 owner-local 与 root isolated tests。

并发上限是 `max(1, min(4, availableParallelism()))`。每个子进程使用独立临时
`HOME`、`KITE_CODE_HOME` 和 Windows `USERPROFILE`，结束后清理。

默认测试排除真实 PTY、fault/soak、native sandbox、spike 和 live Provider；这些使用已有显式命令。

## 稳定命令

- `bun run test`
- `bun run test:all`
- `bun run test:runtime:fault`
- `bun run test:runtime:soak`
- `bun run test:e2e`
- `bun run test:tui:harness`
- `bun run test:tui:system`
- `bun run test:sandbox:smoke:native`

## 迁移期测试

Parity/cutover 测试只有在每条独有断言映射到 owner 测试后才能删除。State 26 read-side compatibility、
fail-closed 和历史恢复测试继续保留，但使用领域化 compatibility 名称；schema 数字只出现在测试数据和断言中。

本次 V2 已删除两个不再比较独立实现的迁移 harness：

- 原 Agent Kernel package parity 的 State bytes、codec、129-case reducer、recovery、scheduler 与 completion
  断言分别由 `packages/agent-kernel/test/agent-kernel.test.ts`、`codec.test.ts`、`recovery.test.ts`、
  `state-migration.test.ts`、`core-reducers.test.ts` 和 `completion.test.ts` 承接；
- 原 event-type parity 的 discriminant、required-field 与 unknown-event 断言由
  `packages/agent-kernel/test/agent-kernel.test.ts` 和 `codec.test.ts` 承接。

其余改名为 conformance 的测试继续验证真实跨 owner seam，不是同一实现的自比较。

## 门禁

`bun run check:test-ownership` 验证目录、deep import、root 散落、isolated 分类和 test discovery。
`bun run test` 验证默认执行，系统/qualification 使用各自显式命令。
`tests/integration/scripts/ci-bun-baseline.test.ts` 验证所有 `setup-bun` workflow 与 formal qualification
共同 pin Bun `1.4.0`，Required workflow 只取消同一 PR/ref 的过期运行，并确保 native keyring smoke 的
path filter 与执行命令共同指向 `tests/qualification/mcp-keyring-platform-smoke.test.ts`。
