# MCP、Skills、Subagent 与验证

这些能力由 Builtin 提供语义，Service 注入外部依赖，Kernel/Host 决定治理与生命周期。共享入口是[Runtime module 注册](../src/index.ts)与[SPI registry](../../runtime-spi/src/registry.ts)。

## MCP

[manager](../src/mcp/) 维护实际 Server 能力，配置和认证由 Service control plane 拥有。发现/搜索、绑定、执行和结果验证是不同阶段；catalog 出现工具不代表已获授权。revision 改变时旧 binding 不能静默适配新声明，read-after-write 必须检查同一能力版本。

MCP Tool 在 transport admission 与持久 write guard 的等待之后、SDK 请求发送之前，再次核对 callable、connection generation、当前 descriptor revision／availability 与工具存在性。同 generation 的 `tools/list_changed` 也会使旧调用失效；此时 Provider 尚未收到请求，不产生外部 unknown outcome。验证见 [派发前目录变化回归](../test/mcp/stale-dispatch-boundary.test.ts)。

[模型内置盘点](../src/model/runtime-module.ts)在未指定 `limit` 时返回完整匹配清单；显式正安全整数 `limit` 继续使用 cursor 分页，但不受旧默认 50／最大 100 条额度收紧。Provider／Tool 名称仍过滤控制字符、非法 Unicode 和多余空白，不再按 96 字符截断；真实可调用名称及其绑定身份不由展示文本推断。`read_mcp_resource` 和动态 MCP Tool 的有效结果不再在模型可见投影处按 128 KiB 截成 partial；Provider receipt、schema、revision、policy 和授权验证保持原路径。大结果仍受实际模型上下文窗口和物理传输能力约束。

[stdio transport](../src/mcp/stdio-transport.ts)按换行拆分 JSON-RPC 数据帧，可接收同一块中的多条合法消息；发送队列到轮次后才序列化，避免排队时同时分配多个大编码缓冲区。Host wrapper 对数据帧取消原 1 MiB 单行与 16 MiB 进程累计额度，逐帧执行严格 JSON、UTF-8、生命周期和身份校验，输出队列使用消费背压；固定 schema 的私有控制帧仍保留 1 MiB 校验。单条完整 JSON 消息的解析内存仍与该消息本身大小成正比。[Builtin 帧回归](../test/mcp-stdio-large-frames.test.ts)与 [Host 实进程回归](../../runtime-host/test/mcp-stdio-process.test.ts)覆盖合并帧及超过旧额度的往返。

## Skills

[catalog](../src/skills/catalog.ts) 发现可用指导，[workflow](../src/skills/workflow.ts) 编译工作流，[activation](../src/skills/activation.ts) 处理激活。能力开关、effect 和输入 contract 仍须满足；不能仅凭 Skill 文件存在启动任意工作。仓库文档同步 skill 的执行规则属于开发流程，不改变产品 Skill Runtime。

工作流读取完整 `SKILL.md` 与声明的文件；不再因单文件／合计字节或条目数量的固定额度丢弃有效指导。YAML manifest、实际文件路径、dependency revision、capability ceiling 和授权仍须通过校验；忽略缓存、构建产物等扫描目录仍是发现规则。[Skill 工作流测试](../test/skills/workflow.test.ts)覆盖超过旧额度的有效文件。

工作流刷新仍读取全部当前文件；相同路径和字节序列可复用已计算的文件集合摘要，任何内容或路径变化都会重算。缓存只减少重复哈希，不作为文件新鲜度证明。

[Skill reference reader](../src/skills/lifecycle.ts)读取已激活 Skill 目录内的完整引用文件，不再因旧 128 KiB direct-read 限额拒绝。Workflow 编译时绑定 canonical root 与目录对象身份并纳入 revision，已发现的 root alias 保持支持，编译后换绑则失效。引用读取沿该根目录检查下级目录对象与真实路径，以 no-follow FD 读取普通文件并复核读取前后身份，拒绝 snapshot 后的中间目录 symlink 与目标替换；输出继续明确标记 UTF-8 或 base64 编码。验证见 [引用边界回归](../test/skills/reference-boundary.test.ts)。

[Capability schema compiler](../src/skills/capability-domain.ts)对 MCP 与 Skill 的对象根 JSON Schema 执行可序列化检查和 AJV 编译；旧 256 KiB、32 层、4096 节点和 1024 属性的本地额度不再拒绝有效 schema。非法、循环或无法解析的 schema 仍失败封闭，执行时仍使用完整 revisioned schema 校验参数。[Schema 回归测试](../test/capability-schema-authority.test.ts)覆盖大 schema 与无效输入。

## Subagent

[role 与 context](../src/subagent/)、[runtime module](../src/subagent/runtime-module.ts) 将 task、角色上限和明确输入交给 child driver。独立 step/tool identity 保持 live 与 replay 对应；审批挂起记录来自已解析工具参数，恢复不重建另一份未经验证的 invocation。并发子任务不共享不受约束的 mutable caller state。

[终态结果 Artifact](../src/subagent/task-artifacts.ts)列举时对每项只读取并解析一次，直接从通过 canonical、引用完整性、owner 和 task 身份校验的 payload 取得 taskId 与结果；损坏或跨 owner 的记录继续失败封闭。[回归测试](../test/subagent-result-artifact.test.ts)核对每项单次读取与跨 owner 拒绝。

## Web

HTML 提取是被动 DOM 解析，不执行页面脚本或加载子资源。Bun 原生发布编译由 [release compiler](../../../scripts/release/oss-candidate.ts) 精确适配 jsdom 的同步 XHR 实现，避免导入时解析产物中不存在的 `xhr-sync-worker.js`；同步 XHR 明确拒绝，正常抓取仍使用已准入 transport。上游已知语法变化会使构建失败，不静默跳过适配。[原生提取回归](../../../tests/release/web-extraction-compiled.test.ts)实际编译可执行文件、删除入口源码后在独立目录运行，验证正文、链接、脚本及子资源行为；取舍见 [Agent Note](../../../.agents/notes/implemented/bug-fix/2026-09-30-native-web-parser.md)。

网络机制要求 App 显式注入不可变策略和逐调用决定记录端口。普通开发期的 `public` 机制策略允许公开 DNS 主机，继续校验全部解析地址、固定连接地址并逐跳记录准入；该值不进入封存 `ExecutionBoundary`，封存策略仍只接受 `off`／`allowlist`。完整边界见 [执行边界](../../../docs/active/execution-boundary.md#network-projection-and-durable-admission)。

[Web extractor](../src/web/extractor.ts)在未给出 `max_chars` 时返回完整提取正文，模型结果不再施加第二次
固定长度裁剪。显式内容选择仍受尊重。有效重定向链不设旧的默认三跳额度，实际循环会被拒绝；每跳仍由
网络执行边界与 SSRF 检查授权，整个抓取／HTML 解析受请求时限和取消约束。长显式时限分段使用宿主 timer，
不能因整数溢出退化为 1ms 超时。单次外网响应体的 5 MB 解析安全上限在流读取期间按真实字节核对并取消超大
流，避免先无界读取后检查；此限制不参与 Run 累计 Artifact 计量。

时限从调用入口开始，覆盖 robots 检查、同域请求排队、页面传输与提取。robots 缓存和排队等待接受取消；排队记录在完成后清理，不以累计域名数拒绝或跳过请求。robots 规则在 500 KB 文本解析安全范围内完整检查，不因先前固定 100 条规则边界忽略后续 `Disallow`。

验证：[完整网页与安全边界](../test/web-content-boundary.test.ts)。

## Verification

[deterministic executor](../src/verification/deterministic-executor.ts) 使用文件、命令、schema、MCP 或 receipt/Artifact 等证据，缺失或无法验证的结果明确 inconclusive。Kernel 决定 required、完成、repair/waive/compensation，Builtin 不自行宣布任务完成。

新 `unboundedCumulativeUsage` 主 Run 与 `durationOnlyChildRun` 子 Run 的 required 验证不因累计 repair 次数耗尽而停止；每次失败仍需产生真实修复与复验，直到通过、用户豁免或 Run 的时间／取消条件结束。历史有限 Run 保留其持久 repair 规则。`required` 的完成门禁及仅用户可签发的 waiver 不变；实现边界见 [Kernel repair policy](../../agent-kernel/src/domains/verification/repair-policy.ts) 与[跨包验证治理](../../../docs/active/verification-governance.md)。

验证：[MCP callbacks](../test/mcp-tool-pipeline-callbacks.test.ts)、[Skill workflow](../test/skills/workflow.test.ts)、[Subagent context](../test/subagent-model-context.test.ts)、[Subagent operations](../test/subagent-operations.test.ts)。跨包规则见[验证](../../../docs/active/verification-governance.md)与[MCP 治理](../../../docs/active/mcp-runtime-governance.md)。
