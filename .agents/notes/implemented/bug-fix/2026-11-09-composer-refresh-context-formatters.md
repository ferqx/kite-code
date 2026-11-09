# Agent Note: 刷新保留输入弹层与只读历史结果格式器

Status: implemented

适用范围更新：本文的弹层意图／操作门禁分离和上下文读取退避仍有效。纯contextResultFormatters登记已由[封存输入与事实一致性](2026-11-09-context-estimate-sealed-input-consistency.md)替代并从源码撤回；以下涉及登记表的决定、备选和验证作为当时实现理由保留，不再指导新增工具接线。

## Problem

用户观察到Agent Loop过程中已打开的权限弹层自行关闭，并且有累计缓存数据的历史会话显示上下文未知。Composer在临时permission read gate、readOnly及观察范围变化时主动关闭菜单，ModelEffortSelector也在read gate开启时关闭；这是显示意图与操作准入混用。上下文hook把读取失败和暂未取得估算记为已观察的未知，没有同范围恢复重试。

默认Service将web_fetch的实际定义放入Run绑定，基础Runtime没有此定义。Run结束后，readContextEstimate不能核实历史网页结果展示器；即使封存输入和工具记录仍在，也会按原安全约束拒绝估算。本机development“问候”会话只读记录包含历史web_fetch，Core冷读回归复现缺失展示器的拒绝路径；这不等于已经重放该用户会话的完整后端查询。

## Decision

同会话临时读取门禁保留权限、模型、附件弹层的打开意图及节点，实际选择回调继续核当前资格。会话切换、用户关闭、真实业务交互接管按原规则关闭。Full确认继续绑定准确原范围；本次不放宽过期确认。

上下文失败或空估算按500ms起退避重读，最长间隔30秒；仅在当前范围和读取资格仍有效时继续，离开和scope变更取消原计时、读取及迟到发布。未知模型容量与无证据的估算保持未知，不借缓存率补造。

RuntimeOptions.contextResultFormatters是可信宿主提供的纯历史展示投影，仅含工具身份、Model展示元数据及formatModelResult，不含execute，不进入注册、发现、权限或派发。只读估算在原定义缺失时，按唯一且准确的工具版本和结果展示版本选择它，并继续比对封存正文；冲突、歧义及未捕获step定义仍拒绝。默认Service只保留web_fetch的这一投影，不为预测重新装配网络能力。

## Alternatives considered

- 每次刷新关闭弹层：原操作准入安全，但打断用户阅读与选择，拒绝。
- 为保持弹层而移除读取门禁或延续Full确认：会让旧观察影响写入，拒绝。
- 只增加估算重试：不能恢复已经释放的结果格式器，无法解决该后端路径。
- 把web_fetch完整工具加入基础Runtime，或为估算重新装配Run：扩大执行面或可能引入网络、配置读取副作用，拒绝。
- 无格式器直接信任现在的原始结果／封存文字：无法证明当前所选历史仍符合原结果展示契约，拒绝。

## Evidence and limits

[UI回归](../../../../packages/ui/test/isolated/permissions-dom.test.tsx)覆盖刷新保留节点、门禁期间零选择和切会话关闭；[上下文DOM](../../../../apps/desktop/test/isolated/native-context-usage-dom.test.tsx)覆盖失败与空结果无需新消息恢复。[Core冷读](../../../../packages/agent/test/isolated/context/result-presentation-estimate.test.ts)覆盖纯格式器恢复原Run预测、step无证明仍拒绝及模型／工具／能力读取计数不增加；[Service装配回归](../../../../apps/service/test/isolated/configuration.test.ts)核默认web格式器不含执行入口。

[隔离浏览器](../../../../apps/desktop/test/session-shell-browser-runner.fixture.ts)使用现有--permission-stability，跨深浅主题和宽窄窗口反复切换同会话刷新，检查三种弹层原节点及可见性；不是真实Provider或用户会话权限写入验收。当前负责说明见[上下文owner](../../../../packages/agent/src/context-estimate.README.md)、[Desktop owner](../../../../apps/desktop/README.md#输入区上下文占用)与[UI owner](../../../../packages/ui/README.md)。后端纯格式器修复需重新构建并启动Service，Renderer热更新不足以代证运行中的旧服务。

## Consequences

宿主须维护与实际工具共用的纯结果展示实现；版本不匹配、多个候选或封存正文冲突仍会使估算不可用，不能用扩大执行注册来回避。重试增加有界频率的只读查询，最迟退避到30秒一次，并随读取资格和组件生命周期取消。弹层在核对期间可以继续阅读，但当前范围未核实前不会提交选择。该变化不升级工具或协议版本，也不迁移和重写历史记录。
