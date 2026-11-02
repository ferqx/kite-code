# Agent Note: 自定义 MCP 启动声明与命名环境引用

Status: implemented

## Problem

用户需要按 MCP 官方的命令／参数配置本地服务，并为 HTTP 服务提供标头与环境变量认证。原 Native 用户 Add 只收 URL 或绝对 command，缺少 argv 等字段，直接填写 npm 包名会被当成错误路径。只补输入框无法通过 Main、Service、SQL 与 Source 的闭合校验；直接继承全部宿主环境或把令牌保存为普通字段会破坏既有秘密和来源边界。

## Decision

用户设置采用有限结构化 STDIO／HTTP 声明，Main、Service、SQL 与 Source 共享非秘密声明校验。参数逐项保存、保持顺序，不解析任意 Shell 命令串。保存时解析明确命令名并固定实际可执行文件；Windows 已知 npm／npx 包装器转换为 Node 与 CLI 脚本，传输 port 继续只收绝对 `.exe`，不发现 COMSPEC 或回退执行任意批处理。保存不启动程序或安装包，明确连接才执行。

Electron Main 通过 `@kite-ai/agent/mcp-entry` 独立入口消费纯校验。曾从整个 config barrel 导入，会将 JSONC UMD 的动态相对 require 带进 Node CJS，实际启动报缺失 `./impl/format`；不通过复制松散依赖或全局改写 bundler 解析来掩盖，而是缩小 Main 的依赖闭包。真实 Node 的无源码目录执行回归覆盖相同构建格式及有效／无效请求。

用户来源可显式记录环境变量名，值只在准确原连接准入之后通过私有 port 读取并复核 freshness。HTTP 可组合非秘密标头与命名标头／Bearer，STDIO 可组合非秘密 literal env 与额外命名传递。最小系统运行变量采用固定平台名单；proxy／loader/runtime 注入名和已知敏感 literal 键继续拒绝。来源摘要绑定声明而非环境秘密，实际值不进持久配置、journal、SQL、registry或普通结果。项目来源明确拒绝这些新标头和环境权限，普通项目批准不能扩大为读取宿主变量。

这只扩展[全局用户设置](../architecture/2026-10-24-user-global-extension-settings.md)的声明能力；[普通 Source Add 原申请](../architecture/2026-10-05-original-mcp-source-entry-mutation-intents.md)的 basic 工具输入及定义版本保持。原 Scope、read-set、creation marker、未知不重放、owned OAuth 和真实工具调用权限仍适用，不增加公开版本、数据库表或测试入口。

## Alternatives considered

- 只添加表单字段：持久层仍会拒绝，采用完整字段链路与真实连接验证。
- 接受任意启动命令串并交给 Shell：丢失准确 argv 与程序归属，采用命令和参数分离及确定的启动器解析。
- 自动继承全部进程环境：会扩大每个 MCP 的秘密读取能力，采用固定运行名单和逐项明确引用。
- 将 Bearer 和敏感环境值直接保存到配置或申请：违反既有非秘密记录约束，采用环境变量名称，保留原 Vault 认证作为独立路径。
- 让项目来源通过普通批准取得宿主环境：原批准展示及权限并未覆盖此能力，保持仅用户来源可用。

## Consequences

表单分别保留两类草稿，沿公共组件和透明侧栏布局。字段和值的校验、变量缺失与连接超时有有限提示；STDIO 首次 npx 安装可能超过原10秒握手，设置初始化改为有界60秒并保原取消。环境引用不冒充登录状态或授予 OAuth，移除来源不修改 OS 环境。

Windows 已实际核 Node argv／cwd／变量、官方 memory MCP 的首次 npx 安装、工具目录和断开；HTTP 真实回环核私有变量进入 wire 且不进入持久记录。完整命令、证据及已有 Windows Source／Run 回归限制归[Service owner](../../../../apps/service/README.md#自定义-mcp-表单与启动配置)，UI证据归[Desktop owner](../../../../apps/desktop/README.md#native-mcp-完整设置)。本次结果不代表其他平台、完整 Run 或正式安装发布资格。
