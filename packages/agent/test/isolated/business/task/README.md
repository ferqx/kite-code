# Task 业务测试

[task.test.ts](task.test.ts) 使用真实 SQLite Worker、普通 Tool、固定 Model 与私有临时 profile，证明角色封存、原 key 去重、shared Loop 单槽等待、父拒绝零 child Provider、detached 父完成后继续与实际取消终态。fixture 在 finally 关闭 Runtime/删除临时目录；read 重试 cursor 与调用计数保持不变。

[capacity.test.ts](capacity.test.ts) 验证原 ChildSlots 公平预留；task.test 的真实 Core 场景另外验证默认三个 slot 满后即时失败、零第四 Session/Provider。readAgent 真实投影持久 deadline 与 selection。

[messages.test.ts](messages.test.ts) 证明私有 direct-child QueueOnly 邮件 在同一 Loop 下一 Model 使用精确唯一 command sourceID，公共 child input 零写拒绝。[follow-up.test.ts](follow-up.test.ts) 验证已终态/仍活动 predecessor 的新 carrier 与 Run、原 Session 创建血缘与历史、新固定期限、root-stop 先提交迟到激活零第二 Model、私有临时 SQLite 的 durable delete 标记阻止迟到激活，以及双 successor 唯一前台、旧 Task 取消不误伤新 Run、并发同 key 只启动一次。delete 测试只核既有 final SQL 门禁，不代表新增公共删除 API。只读查询 cursor 与调用计数不变；没有新 Loop 或 SQL 伪造执行资格。私有 input follow-up 不自动接纳未绑定邮件。

[mailbox.test.ts](mailbox.test.ts) 验证实际双向父子 QueueOnly 邮件：12 封完整正文只存原 execution 私有 Artifact，实际后继 Model 精确使用唯一低信任 source；当前源 Tool 成功结算后才可接收。真实 SQL trigger 覆盖接收整体回滚与原 id 重试、发送结算整体失败及明确恢复，未伪造执行资格或新造成功事实。idle、失败 sender、未知 sender、取消目标不自动注入/启动；列表和 wait 时 receivedMessageId 仍可为空，prepared 由真实 Model 请求证明。历史 parent 查询遇后来人类 Run 返回 null，cold readonly 查询零 Provider/写。idle follow-up 由 mail-adoption.test.ts 覆盖；根父 after_turn 由下节覆盖；完整 retry/delivery 仍未覆盖。

[required.test.ts](required.test.ts) uses actual Core, SQLite and explicit ordinary Tool gates to verify default required settlement: two staggered children produce one later Model request; known failed children preserve their state while the parent can report and complete; a real child terminal-commit fault yields one status-only unknown diagnosis without satisfying the obligation. It also verifies wait-any leaves the other detached child running, required cancellation accepts only a status source, and ordinary suppressed background delivery produces no source. SQL only installs rollback triggers; it never fabricates result, obligation or permission rows. 该用例不覆盖邮件；QueueOnly 邮件由 mailbox.test.ts 单独验证，根父 after_turn 由下节单独覆盖。

The actual followup_task test verifies a new default-required carrier, a second Run in the original child Session, exactly one new obligation, and a bounded parent wait followed by one Model request containing its accepted result. Attached ordinary Tool unknown effects prevent known carrier settlement even after the child Run fails; an independent detached unknown Job remains outside that carrier domain.


[coordination.test.ts](coordination.test.ts)验证实际 70 child 的权威目录分页与完整边界、原引用缓存缺失后的终态查询、readonly 冷重开零 Model/零写，以及 Store/subject/namespace/ref 拒绝。准确 interrupt 的同 ID重试不产生额外写；真实 Store 请求前 barrier 允许旧 Run 结束并启动新 follow-up，再提交旧 interrupt，最终事务拒绝旧目标且新 Run 保持 active。cleanup 使用准确新 carrier 取消并等待真实终态，不把无输出或请求回执当已停止。此用例不证明完整 mailbox/after_turn/retry。

同一 fixture 还验证 wait-any 对已存在的 carrier 审批与孙级 Tool 交互准确早醒，实际 human answer 前零 child/Tool 效果；普通单目标 wait 仍等待真实终态，回答后原工作正常完成。交互关系来自原 Store/rootWork 与持久 ancestry，不以任意 Session 卡片作为目标的权限证明。

required.test.ts 同时验证活动 result.include 与 steer 一样使 task_wait 早醒；排队选入不取消 child，只有原 Run 的安全 checkpoint 应用来源。普通 operations.wait 保持终态等待契约。邮箱 checkpoint 每次仍读取实际快照；没有接收邮件时复用该页的 receivedSeq，避免额外相同观察查询，发生接收后仍重新读取最终水位。

[mail-adoption.test.ts](mail-adoption.test.ts) 使用真实 Core/SQLite 与固定 Model，51 封已确认邮件跨 50 项接收页，完整 Artifact 正文只在准确新 Run 以唯一低信任 source IDs 进入 Model；原 same-key 重试不扩大集合，晚确认的低序号与晚发送邮件留队。错 Store/carrier/selection 零新 Run；实际根 Rewind 保持 child 的原选择域，普通后来人类 Run 不接纳 unbound 邮件；新 carrier 权限 barrier 的根 stop 保留原接受事实但零新 child Model。

[after-turn.test.ts](after-turn.test.ts) 使用真实 Core/SQLite、固定 Model 与独立策略，验证原父完成后的唯一因果报告、已知失败保留但可如实汇报、unknown 零续轮、policy deny/无可信 policy 零 child、已接纳人类优先、报告先启后人类独立排队、Rewind/根停止抑制、冷 pending 目录零 Provider/写，以及原 binding 的准确 disposer。真实 INSERT Run trigger 证明报告创建、结果接纳和回执整体回滚，保留已成功 carrier 的原事实；查询不恢复执行。未覆盖嵌套 after_turn 或完整 retry/delivery。

[nested-after-turn.test.ts](nested-after-turn.test.ts) 验证嵌套三层同 Loop、新追问 carrier 的 after_turn、准确低信任 source、资金期限不续签、原 carrier 不复活与 disposer 恰好一次。结果早于父完成只登记申请；显式追问先提交抑制旧报告；真实 Run INSERT trigger 证明报告创建/来源接纳整体回滚且 carrier 成功事实保留。现有 after-turn.test.ts 继续覆盖 root 的拒绝、unknown、Rewind、根停止、冷只读与控制变化，不将这些局部测试作为全部恢复资格。
