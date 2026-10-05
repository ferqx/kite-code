# 显式中断与原 Tool 历史

[recovery-operations](../recovery-operations.ts) 在原 root Session OS 锁和 generation 复核下，把本次未终态执行、active Run、Interaction、消息、事件与 recovery receipt 放在同一事务中。原同 command 回执先于锁和全文读取返回；重查不追加消息、不增加 change cursor，也不重新派发。

原 Model 已完整产生调用、其 Tool 尚未派发便被显式中断时，Execution 保存准确 `cancelled` 事实，历史还须保存配对的 Tool 结果。否则下一次同 Session 的新输入会带着未配对 assistant tool call 到 SDK，在 Provider 请求前失败。取消结果只报告原中断事实，不代表 Tool 已经执行或成功。

[私有 history reader](../recovery-history.ts) 只观察本次待恢复、同 Store、有 Run、`planned/dispatched=0` 的准确取消候选 Tool，以及它的原 Model 和唯一完整 assistant message。它复用 recovery 原有的本次操作闭包上限：最多 4096 个未终态 Execution、active Run 或 partial message，观察使用 4097 项判断越界。这不是累计 Session/Run 历史额度，不扫描已终态历史，也不以视图窗口推断完整性。观察端口不取得 owner、不派发，未向 Extension 或 HTTP 暴露。

普通 inline 调用在 SQL 内核对 Model/Tool 的原 Store、Session、Run、origin Command、root work、原 call ID/name/完整参数 digest，及 assistant 与 Model result 一致。封存 ModelOutput 的完整调用由 [Runtime](../../../runtime.ts) 沿既有原 Store/主体/Execution 的 immutable reference、hash 和媒体完整 reader 读取；读取失败直接拒绝中断提交。完整正文和 arguments 不复制到新的 Worker 请求，也没有新的正文截断或传输额度。

Runtime 重建原请求字段，丢弃 caller 自报私有 proof。Worker 只传有限 metadata/ref/digest；最终 recovery 事务独立重读当前绑定、原 result revisions 和 immutable ref，核准完整目标 proof 集合才采用。观察之后绑定或目标集合发生变化时，拒绝并保持原字节、消息、事件和回执。该 proof 仅证明原调用历史，不提供权限、takeover 或恢复派发授权。

原 Model 调用的取消 Tool 结果使用准确 `callId` 和 `sourceIds:[原Execution]`。`completion_decision` 沿正常 terminal 语义保存低信任 user execution result；runless Tool、Job 和 Model 不生成虚构的 assistant Tool 结果。已经派发或跨 Store 的 Tool 仍保存 `outcome_unknown`，不伪造配对 Tool 结果，也不因缺少完整 Model 调用证明阻止准确 unknown 中断收束。原 unknown 阻挡条件和原 Execution ID/revision 不放宽。准确取消候选缺少完整原调用绑定时不补猜调用或成功结果。

[Store 测试](../../../../test/isolated/recovery/history-followup.test.ts) 验证准确取消、真实 unknown 仍拒绝 owner 接管、completion decision/runless Action→Tool 的消息区别、观察后 revision 漂移、同 command 幂等和故障回滚零半消息。[真实进程测试](../../../../test/isolated/recovery/history-followup-runtime.test.ts) 使用所属子进程 SIGKILL、本机实际 SDK Provider，核 inline 与完整大正文 ModelOutput 的原 Session 后继、原媒体损坏零提交、caller proof 不被采用及原回执零全文重读。[owned Service/PTY 测试](../../../../test/isolated/recovery/history-followup-owned-service.test.ts) 通过显式制品 SHA、独立 profile 和实际 80×24 PTY，在原 Session 中断后提交新输入，独立普通 Ask 批准后只执行新 Tool 一次；原取消 Tool 保持取消。

当前资格是 macOS 本机开发制品、mock Provider 和所属隔离 profile，不代表生产 Provider、安装制品或其他平台。已由旧实现提交的 recovery receipt 不自动回填历史；原 receipt 重查仍严格只读。
