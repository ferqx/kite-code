# Agent Note: 模型工具表面与内部执行身份分离

Status: implemented

## Problem

普通 Agent 工具使用命名空间 ID、混合字段风格和多份同义等待入口。模型还要识别文件读取范围、精确编辑匹配次数以及启动、等待、取消的不同语义。直接全局改名会同时改变权限分类、配置选择、执行来源和冷恢复身份；只改一个 Provider 则无法覆盖固定模型及第三方 ModelAdapter。

用户确认本轮统一模型侧名称、参数和描述，收敛重复等待，并保留内部 ID、权限及执行恢复；明确不要求兼容旧会话工具消息。文件基线、Artifact 和操作键的引用简化留到下一阶段。本决定是新的 Agent 表面投影，不取代 [SDK 工具名传输编码](../../implemented/bug-fix/2026-10-16-compatible-tool-names.md)仍适用的协议字符和碰撞处理。

## Decision

各可信 ToolDefinition 通过纯数据 model 元信息声明公开名称、按 schema 声明属性的 snake_case 映射和必要收窄。通用 Agent 在唯一 ModelAdapter 边界投影实际声明、历史和 describeRequest；完整返回的调用先校验公开合同，再转回内部 ID 与参数，之后仍由原权限、来源、资源、业务和终态链路控制。AI 包不识别具体 builtin 名称。

内部 ModelRequest 与 Tool Execution 输入继续使用规范身份。每条新调用只持久化精简的原公开名称、实际激活字段路径和必要拒绝事实；下一轮和冷读按原调用描述重建公开形态，不从当前目录推断旧含义。原 Model metadata 封存当时公开工具表供只读 Inspector，公开正文重新计算自己的 hash，原执行回执验证仍使用完整私有原输入。上下文估算和压缩使用同一公开形态，不把精简私有描述计入模型 token。

字段转换只涉及 schema 声明且本次实参匹配的结构。Task input、Workflow input/output、远端 MCP arguments 等开放 JSON 保持原字节含义。组合分支按实际匹配选择；多个 anyOf 分支产生不同映射时明确拒绝。字段改名中的未支持引用或谓词结构在模型调用前拒绝，不猜测转换。每份有变换的 schema 使用独立校验空间，动态 MCP 的纯名称投影不改变或重复编译远端 schema。

任务等待只暴露 wait_agents(task_ids)，单目标也使用数组。wait_agent_event 只处理邮箱、输入或交互事件；旧 task_wait 与原内部目标分支继续注册，模型声明隐藏或收窄它们。内部可信调用和原恢复资格不因表面收敛改变。

## Alternatives considered

- 全局重命名 Tool ID 与原参数：会影响准确权限、JSONC 选择、执行回执和恢复，不符合本轮保留边界的要求。
- 只在 SDK adapter 改名：无法覆盖任意 ModelAdapter，且检查器和估算容易与实际请求分离，未采用。
- 对所有 JSON 深度转换 snake_case：会改写用户业务键、远端参数及 schema 数据，未采用。
- 用当前工具定义重建所有历史：动态目录撤销或重新发布后会改变原调用含义，改为在新调用保留精简原投影。
- 在本轮新增 baseline_ref 或自动替换操作 key：涉及真实文件基线、作用域和去重绑定，按用户要求延期。
- 为旧会话增加双名称和双参数解析：用户已明确无需兼容，未建立该分支；原内部执行与恢复合同仍保留。

## Consequences

没有新增 SQL 表、执行类型或权限入口。模型请求转换标记增加版本 2，公开 Service/Client schema 接受该版本；其余展示仍消费内部真实 Execution。文件修改保留完整 base 与准确匹配次数，Shell/Task 保留原操作键和精确取消引用。

当前实现、全部公开名称与限制由 [模型工具 owner](../../../../packages/agent/src/model-tools.README.md)维护，产品行为归 [工具手册](../../../../docs/handbook/features/tools-and-approvals.md)。本轮不加入正则搜索或 apply_patch，不扩张 MCP 搜索范围。既有 MCP 完整目录承诺与当前 selected search 的差异在[扩展手册](../../../../docs/handbook/features/extensions.md)明确记录，不用新名称掩盖未实现能力。

## Verification

2026-10-18，本机 macOS/Bun 1.4.2。[真实 Runtime 投影](../../../../packages/agent/test/isolated/execution/model-tools.test.ts)与[组合分支](../../../../packages/agent/test/isolated/execution/model-tools-branches.test.ts)覆盖名称/字段冲突、非法旧字段零效果、opaque JSON、实际激活数组元素、大正文、公开历史、冷只读 Inspector 和实测 token 基线。[真实 paired Service](../../../../apps/service/test/isolated/configuration.test.ts)使用公开 read_file/edit_file 完成读取、准确原基线、真实审批、磁盘变更及下一轮历史，审批和持久记录仍为 files.edit 与原参数。Shell、Task、Responses 及原执行恢复用例分别核对原生命周期和零重放。

原 HEAD 的 context-contributions 来源集合断言与 child 排队取消超时已在隔离只读快照复现。用户随后明确授权最小修复并要求默认全仓通过后提交：来源 fixture 改为选择同时含两次工具输入的完整批次，保留原来源与拒绝断言；排队取消修复原 child.start Command 的非法 cancelled 写入，按既有枚举结算为 rejected，unknown 仍为 needs_review。原零 child Model/Run、精确终态与 not_activated 回执分别验证，取消 owner 归 [Child storage](../../../../packages/agent/src/storage/sqlite/child/README.md)。工具投影另补共激活 allOf 字段碰撞、互斥分支和 name-only MCP 原 schema 保持回归。

[显式真实模型测试](../../../../tests/e2e/live/model/README.md)记录实际单模型文件读改写与准确任务等待；这与默认 mock/本机制品测试分别保留证据，不外推三平台、全部模型或全部远端 MCP 资格。
