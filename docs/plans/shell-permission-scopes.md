# Shell 与联网的三策略接线

状态：本机实施切片已完成，Win/Linux 原生资格仍未闭合。用户确认以 Codex CLI 的保守解析、系统沙箱和审批链为参考；本切片不宣布 V1.3 阶段退出。

实际用户入口为 CLI、TUI、Native 的权限选择与正式 `shell.launch`、`web_fetch` 调用，Web 继续只读原结果。新入口只展示请求批准（`accept_edits`）、自动审核（`auto`）、完全访问（`full`）。正式类型、HTTP/IPC、持久控制、Client 与调用者不再接受第四种 `ask`，旧输入/控制记录明确拒绝，不作兼容映射。

正式 Shell 默认在工作区可写、无网络的系统范围运行。调用可以明确请求文件系统与网络范围；请求数据不等于授权。请求批准策略自动允许工作区内的 Shell，外部写入或联网需要当前调用的人工批准。自动审核保留实际模型审核，明确拒绝不执行并显示原因；审核不可用和明确请求用户决定按原交互回退。完全访问允许普通宿主读写和联网，仍先执行极危险操作拒绝与 Runtime 权限对象保护。

Shell Tool 将同一请求传到普通 Job；最终 Store 接纳的授权快照决定实际系统范围。权限、命令、请求范围、环境、执行与解析资产、控制读取发生变化时，旧审批不复用。父子权限交集取更窄范围。外部写入批准不附带联网授权，联网批准不附带外部写入授权。

解析使用固定版本 Bash Tree-sitter 的有限字面量 AST；复杂表达式保留为不透明命令，不能证明只读、联网或写入效果。固定危险拒绝扫描与安全证明分开。不透明命令在请求批准的默认范围运行，由 OS 拦截越界；不在失败后自动扩大范围重放，避免部分效果重复。`web_fetch` 继续使用正式 network 能力描述、相同审批/审核入口和原 SSRF 限制。

负责模块为 Service 权限与 Shell 装配、Agent Shell Tool/Job 和平台准备、共享客户端权限入口。macOS 验收真实工作区写入、外部写入/网络独立批准与拒绝、Auto 审核拒绝零效果、Full 固定危险拒绝、正常完成与清理；保留旧断言，收束时完整回归。Linux 采用同一范围并接到 bubblewrap 与 seccomp，Windows 缺正式 Shell 后端继续失败关闭；实际 Win/Linux 执行交后续 Actions，本地不 dispatch。

原 RSS 超阈值、完整观测缺项、Windows Shell 合同与平台资格仍为未闭合门禁。必要验证对应当前错误与上述验收；本切片不重复已闭合故障矩阵或参数对照，不 push、PR 或发布。

macOS 原正式 Shell、真实 web_fetch、三策略消费者与已完成 Auto 审核的冷恢复已通过必要定向验证及原完整默认回归。旧严格 raw ask 已从正式类型、HTTP/IPC、Store、Client 与产品入口退役；原审批、拒绝、取消及零效果断言保持。实现理由归[已实施 Note](../../.agents/notes/implemented/architecture/2026-10-11-shell-per-call-permission-scopes.md)，本次准确证据及真实失败归[进度](unified-agent-refactor-v1-progress.md#2026-10-11shell-三策略与旧模式退役)。

本计划仅保留已确认的后续平台资格：Linux 原生编译、namespace/seccomp 与真实独立范围执行；Windows 正式 Shell 后端及原合同。共享策略和原生测试已接三 OS Actions，本次不 dispatch。后置平台、RSS 与观测门禁不妨碍本机切片交付，也不能据本机通过宣布这些门禁或 V1.3 阶段退出。
