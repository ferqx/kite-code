# Agent Note: MCP 与 Skills 的用户级全局设置

Status: implemented

## Problem

桌面 MCP 与 Skills 页面原先借当前 Session 反查 Workspace，再消费项目来源与会话 Action。没有会话时设置不可用，切换会话会改变目录；这与用户确认的“全局设置只管理用户级配置，项目空间配置不显示”冲突。仅隐藏项目行仍会读取项目文件、依赖 trust 和释放会话读租约，不能实现该产品边界。

## Decision

Skills 增加独立的 user metadata 接口与 capability，合并 defaults、用户配置和可信宿主 explicit，只读取用户配置根与 Profile Skills 中明确声明的位置。分页、revision 和路径校验保留，DTO 不含 Session、Workspace、Workflow 或项目来源。原 Workspace 目录及实际 Run 的 Skill 选择继续使用原合同。

MCP 由 Service 的明确用户级 owner 管理配置、认证和设置连接。请求绑定实际 Store、认证 subject、原 read-set 与 command ID，使用现有 HostMutation 保存操作与闭合结果，不创建隐藏 Session／Workspace，也不通过普通模型工具执行。HTTP 与 stdio 端口采用明确的 user transport binding，保真实进程和连接收尾；设置连接只初始化及读取工具目录，没有工具调用权限。全局用户认证只适用于同一用户来源与准确凭据域，不能扩大项目来源或旧 Workspace 绑定。

Native 两页的身份由 Store／连接 generation 决定，会话选择与工作区移除不撤销其读取。关闭、断线或全局身份替换继续隔离迟到结果。MCP 原意图使用 DB7 现有表中的显式 version 2，与 version 1 Session 记录并存，容量与未知保护共享。冷行只按原 ID 显式查询，不重新取得热 POST 权；可确证 user 的旧未决操作仍互斥，项目记录不进入配置列表，来源不明确的历史连接只保原结果查询。

准确停止本 owner 已持有的连接不依赖来源文件继续存在或配置可读。GET 保安全失效行和清理观察，Native 对这种已观察连接只开放 disconnect，普通错误及其他写入门禁保持。原申请的停止须明确记录并等待真实证明，未知仍保 owner；不能把删除来源当作进程已停止，也不能为了停止而重新授予连接／配置权。

本决定部分替代[原 Native MCP 设置](2026-10-07-native-mcp-settings-and-original-records.md)与[原 Skills 目录](2026-10-07-native-readonly-skill-catalogue.md)的当前 Session 页面绑定；原请求身份、未知不重发、完整读取、业务执行权限与历史恢复理由仍适用。当前行为及证据分别归[桌面手册](../../../../docs/handbook/clients/desktop/README.md)、[Native owner](../../../../apps/desktop/README.md#native-mcp-完整设置)和[Service owner](../../../../apps/service/README.md)。

## Alternatives considered

- 在旧 Session API 上过滤项目行：仍需读取项目和取得会话身份，无法支持空 Store，拒绝。
- 自动创建或借用会话作为设置载体：会把用户设置伪装成会话行为，并污染目录、权限和历史，拒绝。
- 只展示全局目录而移除认证、连接和未知恢复：会丢失现有用户能力，采用真实 owner 与原持久操作链。
- 给全局操作另建 journal 或数据库表：已有 HostMutation 和 DB7 可以用闭合版本明确区分身份，保留原表及容量约束。

## Consequences

设置连接与实际任务连接由不同的明确 owner 管理；设置 ready 不能授予 Run 工具执行权。Service 关闭必须停止全局连接并等待所有已启动操作，未知停止不能报告资源已释放。新的全局凭据身份与旧 Workspace 身份分别核验，旧记录不自动转换。没有会话时可管理用户配置，但仍需要真实 Store 与可信本机认证连接。当前本机受控验证不代证外部账号、人工系统浏览器登录、签名安装或其他平台资格。
