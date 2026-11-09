# Agent Note: 上下文统计复用封存输入并保持事实一致

Status: implemented

## Problem

用户原会话重启后上下文仍未知，但原模型输入、工具终态和统计结构均未变化。重新调用当前工具格式器依赖已释放的Run绑定，不能稳定重建过去实际送入模型的正文。用户要求新增工具自动统计，并明确不增加兼容路径，同时保持相同数据事实的统计一致。

## Decision

只读预测直接复用原Model输入中的工具正文，核既有Store／Session／Run、Execution、toolCallId和单一消息来源，以及稳定终态结果与原持久消息正文的一致性。Store拒绝不同终态结果覆盖，原终态即不可变事实；不新增快照字段、SQL迁移、工具或协议版本。Run／step工具与主／子Agent共用Core路径。未进入该封存输入的新增工具结果仍使用原有呈现及来源校验，真正缺少原请求或来源冲突继续不可估算。

## Alternatives considered

- 每工具登记纯格式器：已撤回，新增工具需要额外维护，格式器变化还会重解释历史。原弹层与退避修复仍适用，见[前次记录](2026-11-09-composer-refresh-context-formatters.md)。
- 新增私有结果摘要与revision证明：在本轮迭代中考虑后撤回；原数据没有这些字段也应可统计。其字段／Artifact和Inspector隔离理由及局部验证保留在[已拒绝方案](../../rejected/bug-fix/2026-11-09-generic-tool-context-proof.md)，不作为当前统计前置。
- 为旧记录追加兼容格式器：用户明确不需要；既有原模型输入本身足够，不应按新旧记录分支。
- 未核来源直接接受任意正文：不能保证准确会话与执行事实，仍保留身份、完整正文和选择边界校验。

## Consequences

统计结构及既有metadata键不变，不修改原数据或消费统计。相同事实在运行结束、冷读和重启后采用同一口径。只读过程不运行工具、不装配动态能力、不增加Provider调用。缺原请求、损坏Artifact、非终态或来源不符仍明确未知；本地预测不伪装成Provider实测或账单。

## Evidence and limits

[Core冷读](../../../../packages/agent/test/isolated/context/result-presentation-estimate.test.ts)与[子Loop](../../../../apps/service/test/isolated/child-configuration.test.ts)两个完整文件13项／123断言通过，核metadata字段不变、冷读前后计数相等、当前格式器不运行、终态／正文／来源冲突拒绝及子Loop自己的工具预算。[HTTP／压缩](../../../../apps/service/test/isolated/context-token-estimate.test.ts)4项／64断言通过，含205次本地模型调用及冷读。

Windows本机原会话数据库只读核对为42944／262144 tokens（约16%），前两次请求42434与42450，业务游标保持不变，无迁移、无工具或模型重放。该查询证明原数据可统计；不单凭此宣称运行中Electron已加载当前后端。当前实现归[Core owner](../../../../packages/agent/src/context-estimate.README.md)，界面过程证据归[Desktop owner](../../../../apps/desktop/README.md#输入区上下文占用)。
