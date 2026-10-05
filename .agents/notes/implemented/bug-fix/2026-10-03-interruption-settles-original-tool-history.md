# Agent Note: 中断事务关闭准确未派发 Tool 的原模型历史

Status: implemented

## Problem

恢复已正确取消原未派发 Tool，却没有给原 assistant tool call 追加配对结果。原 Session 后继 Model 因未闭合历史在 SDK 的 HTTP 前失败，Provider 调用数仍为1；新 Session 输入通过不能证明原会话恢复正确。sealed ModelOutput 还需要全文与原 binding 校验，不能只读有限描述或接受调用者自报 call。

## Decision

Runtime 在原恢复 OS 锁与 owner/generation 边界内，只为本次当前 Store、planned/dispatched=0、有原 Run 的真实取消候选读取私有 history metadata。observer 复用本次 recovery 已有4096闭包边界，不扫描 settled 历史或增加累计 Session quota。model_decision 使用既有完整 ModelOutput reader 核原 Model/assistant/call 与完整输入摘要，封存有限 ref/revision/digest proof；忽略 caller 自报 proof。

最终 SQLite 中断事务重读完整候选集合与不可变原 binding/ref/revision/digest，并独立核原 owner fence。准确取消结果和 Execution/Interaction/Run/recovery receipt 原子提交；Model Tool 使用正常 role:tool 与原 callId，completion_decision 使用正常低信任 user execution_result，runless/Job/Model 不造 Tool message。trigger 或 proof/source/body 损坏导致全事务回滚，无半段历史或原 receipt。

attempted、dispatching/running、跨 Store 和缺 Model 的 unknown 沿既有中断收束，不要求虚构的 call proof，不追加假 Tool结果，也不解除 unknown gate。同 command 已有 receipt 只读查回，绕过全文重读、追加消息与 cursor变化。旧实现已提交的 receipt 不追溯回填；本目标不要求旧数据兼容，该限制不成为当前新恢复的旁路。

## Alternatives considered

- 更换 Session 避开未闭合历史：拒绝，它隐藏原会话回归。
- 放宽 AI SDK 的 tool-call 配对：拒绝，缺的是 Core 持久历史，SDK 契约正确。
- 只修 inline 或相信 sealed descriptor/caller callId：拒绝，原全文与绑定才证明实际模型调用。
- 为全部 unknown 强制读取 Model：拒绝，真实 effect-before-result 的 owned Tool 可没有可恢复 Model，必须仍能中断并保未知。
- 事务后补消息或重查 receipt 时回填：拒绝，会形成部分历史与只读查询写入。

## Consequences

真实 owned Service SHA、原 Profile、80×24 PTY 与固定 SDK 验证：原 Session interrupt 后后继任务到达 Provider，独立 Ask 后文件效果一次，原 Tool 仍 cancelled、新 Run completed，Provider共3calls。inline/sealed SIGKILL、完整正文、sealed hash损坏、绑定revision漂移、trigger rollback、同ID零全文读/零cursor变化，以及unknown_missing_model与旧effect-before-result fixture均通过。最终14文件107/1307，Agent类型/构建和边界/归属/docs检查通过，原失败与稳定删除修复反例日志保留。

资格仅macOS隔离开发制品与固定本机 Provider；未外推 installed 或其他平台。history proof是私有恢复事实，不进入公共 DTO，不授予工具、核实或自动重放权限。旧 receipt 查询继续严格只读。

原公共投影由[公共中断记录](../architecture/2026-10-03-public-session-interruption-projection.md)指导；实现与scope归[恢复 owner](../../../../packages/agent/src/storage/sqlite/recovery/README.md)，原日志归[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
