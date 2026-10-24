# Agent Note: 会话保持原模型协议

Status: implemented

## Problem

用户确认同一会话不能在 Responses 与 Chat Completions 之间切换；同协议内仍可更换模型和连接，思考程度可从下一轮调整。仅凭当前设置或 Native 的模型偏好不能判断已有历史属于哪种协议，最近200项 Run 视图也可能丢掉真正的首次运行。

## Decision

默认 Service 从该 Session 最早实际 Run 的封存配置读取原选中模型，并按原显式协议归一化；缺省 Chat Completions，Codex 固定 Responses，不按模型名称推断。根运行在建立模型和读取凭据前独立核对协议。跨协议的新开始、后继与恢复明确失败；同协议的模型、连接和普通参数变化继续沿原规则生效，活动运行仍保持原冻结值。

协议依据只来自已有 Run，不为准备拒绝写锁、不建立新表或 journal。Store 在原只读事务返回最早 Run、最近200项与活动 Run 的去重并集，按原 rowid 顺序交付；不扫描或物化所有历史。Native 沿既有 View 读取同一首 Run，在原模型列表中排除另一协议，保留同协议选择与 effort 控件。旧历史继续可读；首 Run 配置无法核实时明确不可用，不跳到较晚记录或用当前默认补造原协议。恢复记录保留原 Store 出处，不能仅因其与当前 Store 不同而丢弃。

子任务与独立辅助模型有自己的绑定，不能把父 Session 的协议限制误用于它们的模型选择。原 Run 恢复仍须满足完整封存快照与 digest，不借协议相等放宽原恢复条件。私有 continuation 继续按原 Provider 绑定隔离，同协议换连接不获得旧 opaque state。

## Alternatives considered

- 固定整个会话的模型或账户：超出用户确认的协议限制，同协议内选择仍保留。
- 只过滤客户端：直接 API、配置变更与冷重建仍可跨协议，服务端必须独立校验。
- 写入新的会话协议字段或偏好账本：与既有实际 Run 形成第二事实源，改用首个封存配置。
- 用最近 Run 或当前默认推断：长历史、已有混合历史或设置变化会改变结论，始终核真正首 Run。

## Consequences

首次实际运行前仍可自由选择协议；已经开始但失败或取消的 Run 仍是实际运行。已有混合历史不改写，后续按其最早实际 Run 检查。切换协议需要新建会话。

该约束补充[显式 Responses 决定](2026-10-15-explicit-responses-protocol.md)，不取代其唯一 Agent Loop、显式传输与私有状态边界。实现与验证归 [Service owner](../../../../apps/service/README.md#会话模型协议)、[Desktop owner](../../../../apps/desktop/README.md#native-provider-与下一次模型选择)、[Store owner](../../../../packages/agent/src/storage/README.md#有界视图中的首次-run)和[模型手册](../../../../docs/handbook/features/models-and-configuration.md)。
