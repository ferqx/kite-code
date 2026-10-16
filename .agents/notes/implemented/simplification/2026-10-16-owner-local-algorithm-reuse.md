# Agent Note: 新架构按 owner 复用算法并保留独立证明

Status: implemented

## Problem

新架构的包边界已经分开，但同一个 owner 内仍有多份完整的文件读取、权限树遍历和正文分片循环。Native 后台目录另写一套已有的快照分页算法，配置管理为复用纯参数校验反向引用整套默认装配。这些重复使相同边界容易漂移；把所有相似代码搬进一个公共工具包又会混淆不同的身份、关闭和失败合同。

测试也存在同一固定 Provider 和 DOM 全局安装的多份实现。部分旧夹具不再提供当前必需的 Change scope，或未声明自己的模型窗口，却假定整个固定 Files 旅程不会发生自动摘要；这会在到达原业务断言前失败。

完整清单检查还发现旧测试把 Profile 模型文件当成默认源、遗漏已登记的第二份迁移资产，或期待重复完成诊断自动终止主 Run。这些都已有独立的当前产品合同，不能通过生产 fallback、减少迁移资产或恢复旧重试上限来适配。

## Decision

- Maintenance 的六份 Files／MCP intent document reader 复用[内部读取器](../../../../packages/agent/src/maintenance/intent-document.ts)，仅集中原 held-FD、16MiB、实体前后复核、严格 UTF-8、闭合 envelope 和 `closePrivate`。各记录 codec、摘要格式、manifest 分支和域错误仍归原模块。`caller-intents` 的实体字段、漂移错误、O_NOFOLLOW 和 boolean 返回不同，继续独立。
- Permissions 的[内部遍历器](../../../../packages/agent/src/permissions/dispatch-scope.ts)按原 LIFO 顺序逐个产出叶子，保留 8192 节点和 parent／child 形状。采用惰性遍历，使当前叶子的错误仍先于尚未访问的坏子树；Shell 与 Files 自己核 kind、能力和最终 scope，不把解释元数据变成 grant。
- Native 后台目录复用 Client 已有的[快照 collector](../../../../packages/client/src/directory.ts)，保留三次尝试、原 25／50ms 可取消退避和原连接 generation；Browser 继续默认不等待。不同调用者的身份验证保持原位置。
- Desktop 的四个完整正文 reader 复用[分片字节算法](../../../../apps/desktop/src/native-body-chunks.ts)，只管原 readId／kind、base64、64KiB、offset 和准确 EOF。open／close、scope／generation、SHA、严格 UTF-8 和业务验证继续属于各 reader；扩展保留格式与完整性两类错误。
- Service 的[模型参数校验](../../../../apps/service/src/model-options.ts)成为纯 leaf，由 Run 绑定和配置管理直接消费。原 `/configuration` 的导出保持，配置管理不再为纯函数依赖默认装配；同一候选的 preset 只解析一次。
- 测试仅在同域复用[后台 DTO](../../../../packages/client/test/fixtures/background-directory.ts)、[Files Provider](../../../../apps/service/test/fixtures/file-checkpoint-provider.ts)、[Native Change](../../../../apps/desktop/test/native-change.fixture.ts)和 [Web global descriptor](../../../../apps/web/test/globals.fixture.ts)。业务步骤、原身份、完整字节、零重放、scope 切换和超时仍由各原场景断言。固定 Files Provider 声明有限合成窗口；默认自动压缩继续由专属真实 SDK 场景验证。
- 默认源夹具使用已有 owned user configuration 与同一个 HOME／spawner；需要保护的旧 Profile 文件及准确字节断言仍保留。固定大正文 Provider 声明足够的合成窗口，完整输入、调用次数和原期限不变。当前必需的迁移资产与默认工具完整清单按真实发布合同核对，不减少资产或隐藏默认能力。
- 长任务夹具在真实 `completion_diagnostic` Model 请求处观察同一 Run、原未满足义务和零越权效果，再明确取消原 Run 并核准确终态，不期待诊断去重自动失败。故障 Provider 保留五次真实失败后第六次成功，逐次核原 ModelExecution、HTTP 次数、前驱和 `maxAttempts:null`，证明没有恢复旧主 Run 上限。

这些决定延续[默认 Service 与 Agent 装配精简](2026-10-11-service-agent-default-composition.md)的职责分工，不改变公开 HTTP、权限模式、持久格式或产品能力。

本轮另核实 Native HTTP 410 会清空当前正文，与手册既有阅读保留承诺冲突。该项作为独立行为修复归[历史 reset 阅读决定](../bug-fix/2026-10-16-native-history-reset-reading.md)，不把它归为纯算法提取，也不修改原窗口断言来接受空正文。

## Alternatives considered

- 建立跨 workspace 的通用 reader／controller：会引入策略参数和额外包依赖，转移不同宿主的 authority 与生命周期。本次只合并同 owner 下语义已等价的算法；Client 直接使用已有 collector。
- 统一所有 intent reader 或 SQLite transaction wrapper：caller reader 的实体和错误合同不同，SQLite 的 deferred read 与 immediate write、rollback 错误策略也不同。为了少几行增加特例或改变失败表面，净维护成本更高，保留原实现。
- 先收集权限树全部叶子再校验：会让后面的结构错误覆盖先遇到的业务叶子错误，改变原失败优先级，因此保留交错遍历与校验。
- 让正文 helper 同时管理打开、关闭和 hash：各业务的租约、晚回包处理和关闭归属不一致。共享字节填充即可去除重复，独立证明继续留在调用者。
- 为陈旧测试添加生产 fallback 或关闭默认压缩：会改变普通客户端行为。改为给 mock 提供真实 Change DTO、给固定本地模型提供明确窗口，并依据产品手册核完整默认工具列表；原业务检查保持。

## Consequences

重复算法各有一个内部负责位置，没有新增依赖或公共配置；业务 adapter 继续清楚表达自己的身份和失败合同。域 codec、平台 ACL／进程证明、事务、取消和恢复记录没有因表面相似而合并。

当前实现说明归 [Maintenance](../../../../packages/agent/src/maintenance/README.md)、[Permissions](../../../../packages/agent/src/permissions/README.md)、[Client](../../../../packages/client/README.md)、[Service](../../../../apps/service/README.md)、[Desktop](../../../../apps/desktop/README.md)和 [Web](../../../../apps/web/README.md)。本机回归只能证明相应代码与断言；本次不据此授予 Linux／Windows 原生、真实远端 Provider、完整发行或性能资格，也不把入口／主链审查表述为全部代码逐行审计。
