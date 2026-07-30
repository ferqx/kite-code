# ADR-0060：单人维护模式以外部发布前第三方安全评审替代 Phase 0 双人签署

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`
关联：Agent 生产就绪 RFC §16、D-13、Phase 0、`MS:LIM-APPROVED`

## 背景

项目当前由 `github:@ferqx` 单人维护，没有由另一位真人控制的 Release 或 Security
repository identity。把同一维护者的第二个账号登记为独立签署人，或把同一人登记为自己的
backup，既不能形成职责分离，也会制造错误的事故响应保证。

Phase 0 的目的仍是冻结决策、schema ownership、Gate 和严格默认值；要求在此时虚构第二位
维护者只会阻止内部工程准备。另一方面，单人自审不能成为 external limited 或 GA 的安全独立
证据，尤其不能为 G0 提供 waiver。

## 决策

1. 项目进入 `single-maintainer` 治理模式。Capability、Release、Security & Privacy、
   Platform、Evaluation/Product 和 Incident Commander 均可由 `github:@ferqx` 承担。
2. 没有真实 backup 时必须登记 `none (single-maintainer)`，不得把同一人或其另一个账号伪装成
   backup。维护者不可联系时，发布、扩 cohort、事故恢复批准和高风险 capability 晋级全部
   fail closed。
3. Task 0.5/M0 可以由单一维护者按角色逐项签署；M0 只授权后续内部实现，不产生 external
   release 结论。
4. `MS:LIM-APPROVED` 前必须取得由不同真人完成的独立第三方安全评审。评审证据至少绑定：
   - reviewer 的可审计 identity 与利益冲突声明；
   - candidate payload/manifest/profile、commit、平台和 route identity；
   - sandbox/network/protected path、日志/telemetry、Provider/MCP data policy、预算/取消、
     supply chain、rollback 和 incident runbook 的审查范围；
   - findings、修复状态、未关闭风险和明确的 approve/block 结论。
5. 第三方 reviewer 不成为常驻 repository owner，也不需要接触用户正文、credential 或私人
   incident 联系方式。只保存安全的 review record URI/digest 和批准 identity。
6. G0/G1 仍不可普通 waiver。维护者不能批准自己的 G0 例外；存在未关闭 G0、reviewer
   不可联系、review identity mismatch 或评审过期时，`MS:LIM-APPROVED` 不得产生。
7. candidate 的 behavior identity、安全边界、Provider policy、supported platform/route 或
   Gate policy 发生变化时，第三方评审失效；纯文案或不影响上述 identity 的修订由 Release
   Evidence 规则判断。
8. 若未来加入第二位长期维护者，可新增 ADR 转回常驻双人签署；不得改写本 ADR 的历史结论。

## 备选方案

- 使用同一人的两个账号：拒绝，不具备人员独立性或事故冗余。
- 永久取消独立安全评审：拒绝，单人自审不足以支撑 external release。
- Phase 0 就聘请常驻第二维护者：不作为硬要求；项目可以先完成内部工程，但 external release
  仍受第三方评审 Gate 约束。

## 后果

- Phase 0 不再因缺少第二位常驻维护者而单独阻塞。
- 单人不可用时没有运营冗余，因此 external cohort 必须保持小且可直接联系，并具备自动
  fail-closed/kill switch。
- external candidate 增加一次有成本的独立评审，且关键 behavior identity 变化需要重新评审。

## 回滚

可以新增 ADR 恢复常驻 Release/Security 双人签署，或把所有 external rollout 收紧为 `off`。
不能回滚为伪造 backup、同一人双账号冒充独立确认、允许单人自批 G0 例外，或在缺少有效第三方
评审时产生 `MS:LIM-APPROVED`。
