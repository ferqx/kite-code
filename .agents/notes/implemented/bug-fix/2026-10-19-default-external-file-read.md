# Agent Note: 普通宿主默认提供外部文件只读工具

Status: implemented

## Problem

Native `+` 将用户选中的外部 ini 路径正确加入提示词，但模型仅取得工作区工具目录，无法按内容回答。此前证明越界 `read_file` 正常失败而模型继续的测试，只覆盖错误恢复，没有覆盖附件可用需求。用户明确要求能够读取外部文件；[工具手册](../../../../docs/handbook/features/tools-and-approvals.md)已有独立绝对用户文件工具及原权限契约。

Git 记录显示：`c1714314`（2026-10-05）建立新 Workspace Files 时即限制相对根；`632786a2`（2026-10-15）新增 `files.read_path/write_path/edit_path`，同日 `19e13cd2` 新增普通默认清单时遗漏外部工具。问题来自 capability selection，不能用 Electron ACL、关闭沙箱或放宽项目上下文读取解释。

## Decision

[普通默认选择](../../../../apps/service/src/configuration-defaults.ts)只补齐 `files.read_path`／`read_user_file`，用于用户明确引用的准确绝对文件。保留最小嵌入默认，保留用户显式禁用／移除；不默认开启外部写入和编辑。Native 继续只传原文件 URI，不另造上传协议或持久授权。

实际读取复用既有原生父对象锚定、准确目标证明、权限复核、owner／单链接和 protected/private 检查；不扩大 `read_file` 的 Workspace 根，不因外部路径加载同目录项目说明，不让文字引用生成额外执行权。当前装配归 [Service owner](../../../../apps/service/README.md#默认装配与业务规则归属)。

## Alternatives considered

- 只让越界失败后模型继续解释：避免 `context_source_unavailable`，但附件仍不可读，未满足需求。
- 直接放宽 Workspace `read_file` 的根或自动回退：混淆现有工作区与绝对路径的权限、原生身份和检查点合同；已有独立只读工具可满足需求。
- 选择后自动读取并上传全文：违背已确认的“`+` 仅发送路径”输入方式，并引入额外正文／格式协议。
- 同时默认开放外部写入／编辑：本次只需读取，原外部 mutation 仍按独立工具选择和权限策略处理。

## Consequences

普通 CLI／TUI／Desktop 的新 Run 多一个只读请求能力，显式工具禁用仍可收紧；已有 Run 的封存配置与恢复不改写。工具可见不保证任意受保护文件或二进制正文可读。

2026-10-19 Windows x64／Bun1.4.3／Electron44.3.0，默认真实 `deepseek-v4-flash`／chat-completions，在独立普通 Native 窗口由系统文件选择器选工作区外 ini，普通提问实际触发一次成功 `files.read_path`，后续 Model 以准确文件内容回答，Run completed；完整输入未含同目录未选中的项目说明。准确执行与局部验证归 [Native owner](../../../../apps/desktop/README.md#markdown-与附件输入)及 [Service 回归](../../../../apps/service/test/isolated/configuration.test.ts)，不授其他模型／平台或完整发行资格。
