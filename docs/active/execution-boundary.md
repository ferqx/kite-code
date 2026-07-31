# Production execution boundary contract

状态：active

读取时机：修改 `ExecutionBoundaryV1`、production composition root、sandbox capability
projection、release-controlled execution policy 或对应 feature flag 时。

验证：`bun test tests/sandbox/execution-boundary.test.ts tests/config/features.test.ts`、
`bun run typecheck`、`bun run check:core-boundary`。

相关：ADR-0051、ADR-0054、ADR-0061、`execution-platform-support.md`。

## Schema ownership

`src/core/sandbox/types.ts` 是 `ExecutionBoundaryV1`、逐维 backend capability strength、
qualification registry 和只读工具 effect contract 的类型来源；
`src/core/config/execution-boundary.ts` 是严格解析、canonical digest、单调收紧和技术能力评估的
规范实现。`src/core/config/execution-qualification.ts` 只从仓库固定路径读取 release-pinned
qualification registry，并校验 revision 和 digest；调用方不能提供 registry 路径、批准 digest
或 production qualification。同一 OS/Bun/backend/network admission key 只能有一个
qualification，resolver 也只接受恰好一个匹配。Digest canonicalizer 显式重建每一层字段，
使用与 locale 无关的 code-unit 排序；JSON 对象字段插入顺序不能改变结果。

用户、project config 和 CLI 不能提供 boundary。普通 `loadAgentConfig()` 不接受或投影
execution artifact，只服务现有开发入口。production composition root 必须使用
`loadProductionAgentConfig()`，同时提供 release profile 的 boundary 与 flag ceiling；只有
artifact ceiling 和合并后的 rollout flag 都为 `true` 才进入 sealed admission。任一层为
`false` 都只能收紧；显式 user、project、CLI/App 层按逻辑与组合，缺少全部显式 rollout 时默认
关闭，因此后层的 `true` 不能提升前层的 `false`。production loader 使用 boundary 对应的
canonical Workspace 加载 project config，不使用进程启动目录代替该 identity。

## Fail-closed admission

production root 在创建 Runtime、Shell、writer、Skill child 或 local stdio MCP 之前必须通过
`loadProductionAgentConfig()`；它内部调用 sealed `admitProductionExecutionBoundaryV1()`。
准入同时要求：

- flag 开启且 boundary 严格有效；
- boundary 与实际 Workspace 的 canonical key 一致；
- 仓库固定的批准 registry 对实际 OS release/version、architecture、Bun、backend 和入口给出
  精确 qualification；
- native probe 与 runtime resolver 共用 `readExecutionEnvironmentIdentityV1()`，并要求同一
  qualification 同时绑定 TUI 与 foreground CLI 入口证据；
- backend 按 filesystem、network、process-tree、child inheritance 逐维报告 `enforced`；
- production boundary 要求 sandbox 配置和 CLI/App runtime restriction 均未关闭，且当前不接受
  `full_access`；成功返回的 `ProductionAgentConfigV1` 把 sandbox 固定为 enabled，并携带
  release-approved qualification proof。

任一条件失败返回全 false capability surface，不进入审批。审批、`full` interaction mode 或
裸 shell fallback 都不能改变结果。

成功 surface 的 `network`、`process`、`write`、`shell`、`skillChild` 和 `localStdioMcp`
是彼此独立的能力轴，不得合并成一个“只要仍有 process 就全部披露”的条件。例如原生
`read_only` 可以保留受 sandbox 约束的 Shell process，但 `write=false` 仍必须在模型 disclosure
和 Runner dispatch 两层拒绝进程内 writer，`network=false` 同样拒绝进程内网络工具。两层门禁
都消费 Registry Capability Descriptor 的 declared/effective effects；Shell 的保守 `unknown`
descriptor 只由显式 `process + shell` surface 接管，实际 filesystem/network 继续由 native
sandbox 强制。带外部 path 参数的进程内文件调用在任意 production surface 下都拒绝，不能因
保留 process capability 绕过 canonical Workspace identity。

`read_only_only` 是独立受限 surface：registry 必须携带 digest 校验通过的非空工具 catalog；每个
工具都固定 `workspace_read + network:none + process:false + write:false + externalPath:false`。
其 capability surface 保留 catalog revision/digest、每个 descriptor revision 和完整 effect
contract，而不是只列 tool ID，并显式关闭 network、process、writer、Shell、Skill child 和
local stdio MCP。模型工具 disclosure 和执行 runner 都会把当前 builtin capability descriptor 的
revision/effects 与该 catalog 精确匹配；不匹配、外部路径或动态 MCP 工具均 fail closed。技术
fixture evaluator 只返回 `technical_evaluation` 标记，且不从 Core config
barrel 导出；production loader 只接受带 registry proof 的 `release_approved` decision。当前批准
registry 是空支持集，因此所有 production 配置加载都在返回可运行配置前拒绝；现有 TUI/CLI
仍是开发入口，不构成生产旁路。

## 单调组合与 identity

`tightenExecutionBoundaryV1()` 只执行权限交集/限制收紧；不同 Workspace 禁止组合。解析后的
Workspace realpath、排序去重后的 host allowlist 和所有安全字段进入
`computeExecutionBoundaryDigestV1()`。字段、Workspace identity 或有效 allowlist 变化都会改变
digest，使旧 release evidence 失效。

## Native filesystem projection

macOS Seatbelt profile 在生成任何 allow rule 前 canonicalize Workspace 与受控 runtime temp。
每次 invocation 使用独立的 `0700` runtime directory；executor 在返回前先请求终止已跟踪的
process group，未确认退出时结果 fail closed 并保留 runtime，确认后再以不跟随 symlink 的物理
遍历恢复 hostile mode/BSD immutable flag 并删除该目录，删除不能确认时同样 fail closed。并发调用不能共享该目录，writable temp 也不进入 executable-map
allow root。`workspace_write` 只允许 Workspace 与该 runtime root 写入；`read_only` 不允许 Workspace 写入。系统与当前 Bun/Node runtime 依赖只有
显式只读 root；除此之外的 Workspace 外 read/write/create/unlink、指向外部的 symlink，以及
Workspace 内 `.git`、Agent/MCP 配置、credential、shell profile 等 protected path 均由
Seatbelt deny，`checkDangerousPaths()` 只保留为 defense-in-depth。Shell child 会继承相同
profile。

`createSandboxExecutor()` 的 `unavailableFallback='fail'` 返回稳定拒绝而不返回裸 `shellTool`；
production consumer 必须使用该策略。现有开发 TUI/CLI 仍保留显式 legacy bare-shell fallback，
但它们不通过 production composition root，不能形成 production qualification。

Linux bubblewrap 使用同一 `filesystemScope` 投影 canonical Workspace 的 rw/ro bind，并显式
绑定 invocation runtime。Linux runtime 清理另起只包含该 runtime 与只读系统工具的 mount
namespace；这只收紧开发实现，不构成 Linux production qualification。protected path、seccomp、
process-tree 与入口/child inheritance 未有完整原生证据前，Linux 仍 fail closed 为 `excluded`。
