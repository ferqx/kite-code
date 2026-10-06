# Agent Note: Native 完整已保存 Job 输出与默认执行资格分开

Status: implemented

## Problem

正式 Native 的已保存执行只有结果摘要，不能完整消费已存在的 stdout/stderr/progress。默认新 Shell 后端尚未满足普通开发子进程与权限/清理契约；若把所有历史读取都排在其后，会使可独立迁移的只读用户入口长期缺失。另一方面，公开输出页只有 items/highWaterSeq，正常行与 per-stream coalesced gap 可重叠，不能以一个有限页或终态摘要冒充完整输出。

当前依据是[执行手册](../../../../docs/handbook/features/execution.md)的执行/实际停止区别与环境不可用不自动退为不受限，以及[会话手册](../../../../docs/handbook/features/sessions.md)的原身份、迟到隔离和历史零重放；具体实现归 [Native owner](../../../../apps/desktop/README.md#native-job-完整已保存输出)。

## Decision

Native 从实际选中准确 Job 详情提供完整保存输出的主动读取、刷新和关闭。Main 在任何 GET 前登记原观察 lease，核 fresh Execution 及每页前后 Service；512 KiB 有限 IPC 不能改变首次 H，过大的 normal-row 页只在相同 after/H 下缩小 limit。renderer 与 Web 共用 Client 的纯 Decimal64 覆盖规则，取 max(throughSeq)、保留合法跨 stream gap/普通 chunk，仅覆盖全部 H 后发布。原字段 NULL 不补零，完整指保存内容与缺口，不恢复已丢字节。关闭、折叠、切换、reset 和冷读取不产生业务取消、句柄恢复或重执行。

真实 producer 与 cold consumer 分别验收：显式可信 Full Shell 在正常 Runtime/Store 产生真实 Job，结束后默认 Native/Service 从同一原 Store 读取。该资格不授予默认新 Shell Job 或任意 escaped descendants 的清理证明。原 ordinary factory 只监督原进程组，受限 factory 固定 deny-fork，两者均不能仅补装配参数就宣称满足普通开发默认契约。

## Alternatives considered

- 等待默认 Shell 完整后端才实现任何 Native 输出：新输出生产依赖后端，但既有公开持久 GET 直接读 Store，无派发/恢复依赖；因此先交付独立消费者并保默认执行缺口。
- 复用显式普通 Full Shell 为默认后端，或把 confined 改为 allow-fork：前者没有非 Full 写入边界及普通启动环境过滤；后者有真实 setsid 后代逃出原组的反例。均不能借用当前 groupStopped 证明扩大默认资格。
- 一次大响应或固定总行数：无法保证所有已保存输出，也会使合法 chunk 的 JSON 编码与 IPC 限制冲突；改用有限页、固定首 H 和无累计截断。
- 各客户端独立复制覆盖算法：Web 已有合法重叠 gap 语义，重复实现容易错误推进或丢弃原记录；提取公共纯规则，同时保持各自实际身份、网络和 UI owner。

## Consequences

已有真实输出的正式 Native 用户入口可独立迁移。保存预算与 producer 丢弃不可逆，页面准确显示缺口；有限传输预算不成为累计数据 quota。期间产生的新输出须显式刷新。消费者不获得执行权，不替代原精确取消 journal。

本机真实 producer、搬迁 source-free 默认冷窗口、普通所属 Service 退出及原 public readonly Store 的证据见[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07正式-native-job-完整已保存输出)。默认后端、持续负载、其他平台和旧路径最终退役仍按[阶段范围](../../../../docs/plans/unified-agent-refactor-v1.md#3022-当前-native-job-完整已保存输出消费者)处理，单个消费者通过不推出完整 V1.3。
