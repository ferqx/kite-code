# 当前规则：真实模型测试边界

状态：active
最后更新：2026-08-01
最后验证：2026-08-01

读取时机：新增真实网络/模型测试、修改测试发现规则、package scripts 或声明 provider 端到端验证结果时。

验证：`bun test tests/test-discovery.test.ts`、`bun run typecheck`。

相关：`model-provider-boundary.md`。

## 当前状态

仓库注册了显式 opt-in 的 `test:model:live` package script，用于真实 Provider 的 context compaction direct/incremental summary 验证。默认 `bun run test` 通过 `scripts/run-default-tests.ts` 只运行确定性的本地/mock 测试：主 suite 使用 `--max-concurrency=1 --only-failures` 限制 Bun 共享进程中的测试和输出资源竞争，并排除 PTY 与 spike；每个 test process 都获得独立临时 `HOME`/`KITE_CODE_HOME`（Windows 同步 `USERPROFILE`），不得读取或修改开发机真实 Kite 配置、Plan 或 Session Log。会临时修改进程级 cwd 或 `KITE_CODE_HOME` 的少量路径测试还会逐文件启动独立 Bun 进程，避免进程级状态互相污染。不得改用 Bun per-file isolate；当前 Ink/Yoga ESM 在该模式下不能稳定初始化。`test:mock` 明确运行当前 context compaction Runtime E2E，同样不访问真实 provider。未实际执行 live runner 时，文档、PR 或完成记录不得表述为真实 provider 已验证。

TUI system 使用 `@xterm/headless` 只在测试进程内解析本地 PTY 控制序列；它不会建立 Provider
连接，也不会改变 live test 发现边界。`tests/tui-system/scenarios/` 仍只连接隔离的本地 mock
model server，不能据此声明真实模型或公网 Provider 已验证。

## E2E 目录归类

`tests/e2e/` 按外部边界分为：

- `local/`：使用本地隔离 fixture 的确定性跨进程 E2E，由 `test:e2e` 执行；
- `live/mcp/`：访问公网或外部 MCP 的显式 opt-in 套件，只能使用 `*.live.ts`；
- `live/model/`：消耗真实模型 Provider 配额的显式 opt-in 套件，只能使用 `*.live.ts`。当前维护 context compaction direct/incremental summary runner；它不属于 Required CI，历史或单次通过也不能替代持续的 provider/model 兼容与语义保真验证。

`test:e2e` 必须显式指向 `tests/e2e/local/`，不得以整个 `tests/e2e/` 为目标。TUI PTY 继续位于 `tests/tui-system/scenarios/`，因为它有独立的串行 harness 和测试标准。公网 MCP 验证不等于真实模型验证。

Required CI 固定分为 `quality`、`unit`、`compaction-contract`、`runtime-e2e` 与 `tui-system`。其中 `runtime-e2e` 只执行 `test:e2e` 的本地隔离套件，TUI scenarios 只由 `tui-system` 执行；`quality` 同时运行文档完整性、文档影响和 compaction legacy symbol 门禁。

`*.live.ts` 是独立 runner，必须由显式 package script 使用 `bun run` 调用；不能用 `bun test` 调用，因为 Bun 的测试发现只执行测试命名文件。

## 新增真实套件的要求

1. 文件必须放在 `tests/e2e/live/model/`，并使用不会被 Bun 默认发现的 `*.live.ts` 名称；不得使用 `*.test.*` 或 `*.spec.*`。
2. 必须提供使用 `bun run` 的显式 package script/wrapper，且默认测试不能调用它。
3. Wrapper 必须限制并发和超时，不得硬编码 provider、密钥或代理清理策略。
4. Provider/model 可显式选择，连接信息来自用户环境或隔离配置。
5. 测试输出不得记录 API key、完整请求、敏感 prompt 或用户配置。
6. 必须更新 `tests/test-discovery.test.ts` 防止真实套件进入默认发现。
7. 完成记录应注明 provider、模型、日期、网络条件和实际运行命令。

真实套件不存在或未运行时，只能报告本地 mock/contract 验证结果。
