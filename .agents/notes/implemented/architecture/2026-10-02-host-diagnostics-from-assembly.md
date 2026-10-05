# Agent Note: 从实际宿主装配提供有限诊断

Status: implemented

## Problem

旧客户端的执行、发行与遥测状态来自旧运行时交接，新客户端只有连接身份而缺实际状态查询。仅显示已注册工具或 API capability 容易被误读为授权、沙箱生效或发行资格；通过查询重新装配 Run 又会访问凭据、启动外部连接或改变任务状态。状态入口需要保持既有用户能力而不恢复旧执行链。

## Decision

Service 的实际配置工厂提供只读宿主诊断 source；进程装配将它与 Runtime 参数分离，公共 HTTP/Client 返回有限、闭合的 HostStatus。连接身份、Store 可用性和准确目标 scope 与执行、发行、遥测分别核对。权限读取只访问原主体的真实控制事实。Shell 的进程组监督与 sandbox 独立显示；未绑定发行 manifest、不具备 exporter 如实记录，不从 buildId 或配置字符串猜资格。

普通配置与 HTTP 请求不能注册诊断权威。GET 不创建 Workspace、Session、Command 或 Run，不调用 Model、凭据后端、Shell 或 MCP。Store 不可用仍保留安全身份和宿主诊断，相关权限事实局部 unavailable。Client 核原 instance/build/profile/Store/目标，不推进 SSE 游标。

CLI 三状态保持先核 Workspace 信任；只有显式 --trust-workspace 才登记缺失 Workspace 和原信任 CAS，不创建会话或任务。状态正文为单个 JSON，原信任意图和宿主关闭提示使用 stderr。TUI /status 显示实际配对/共享来源、连接与观察状态；断线保最后确认事实并明确未知，晚返回不能覆盖新 Session，不关闭 Service。

## Alternatives considered

- 用 API capabilities 或工具列表代替执行状态：注册不是具体请求授权，更不证明 sandbox 或发行资格。
- 复用旧 App Control/Runtime carrier：保留待退役交接和旧宿主权威，违背统一公共 Client 边界。
- 状态查询运行普通配置 resolver：可能打开凭据和外部连接，而且状态读取不应产生执行。
- 创建临时 Session 读取权限：污染业务记录；准确默认值和已有 Session 的有限读取足够。
- 只放抽象诊断 port：默认用户仍只能看到不可用，必须同时接真实默认装配与实际 CLI/TUI。

## Consequences

CLI三状态和TUI /status已使用统一只读诊断，默认装配可实际查询，数据不可用仍保留安全宿主事实。GET不创建业务对象或调用Provider/凭据/MCP，CLI只有显式trust才独立保存Workspace与信任，不为状态读取创建Session。状态是读取时事实，不是后续执行grant；实际派发仍复核权限与来源。

HostStatus采用独立的有限闭合响应校验，额外敏感字段或未定义资格只使该查询失败，不放宽其他响应的已有可扩展读取策略；增加此诊断版本的语义仍需同步schema/Client资格。真实Shell资产校验与普通装配共享函数，source封存原可信options，不能被调用者后改alias影响。只观察的事实与实际授权继续分开。

当前宿主没有发行attestation、全局sandbox或遥测exporter装配，必须如实显示未验证/禁用；不能据诊断接口已接通声称这些功能或正式发行迁移完成。当前macOS证据不扩展为其他平台资格。

## Verification

2026-10-02自有隔离profile、固定loopback模型：HTTP/Client6项101断言，含实际Shell和权限回归18项255断言；真实编译CLI配对/共享2项129断言，原CLI完整17MiB输出/resume2项46断言；TUI最终5项32断言含3个真实80×24 PTY，另含原controller组合14项96断言。查询不新增任务、Provider或凭据backend访问；shared保持原实例和在途Tool，paired退出核所属PID，失联保最后facts。

冻结源码的完整统一回归254个作业通过（parallel81文件、isolated237、exclusive0），根与26workspace构建/类型检查、API生成、边界、归属和文档门禁通过。实现归[Service](../../../../apps/service/README.md)、[Client](../../../../packages/client/README.md)、[CLI](../../../../apps/cli/README.md)和[TUI](../../../../packages/ui/src/tui/README.md)，日志与全V1.3剩余范围归[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
