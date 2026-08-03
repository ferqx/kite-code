# ADR-0067：单维护者发布采用 candidate-bound 自审，第三方评审改为可选增强

状态：accepted
日期：2026-08-03
决策者：`github:@ferqx`（Release + Security & Privacy，single-maintainer）
关联：ADR-0060、ADR-0062、Phase 2A、`MS:LIM-APPROVED`

## 背景

项目当前只有一位维护者，并计划以开源方式开发和接受外部 Pull Request。ADR-0060 原本允许
Phase 0 由单维护者签署，但把 external release 前由另一位真人完成的安全评审设为硬门禁。该要求在
没有第二维护者、没有预算聘请评审人的现实条件下，会让已经通过自动化安全、供应链、制品身份和
回滚验证的候选版本永久无法发布；它也把组织职责分离误当成单人开源项目必须具备的技术能力。

取消强制第三方评审不能变成取消安全评审，或允许维护者绕过 G0/G1、制品身份、签名、真实测试和
回滚证据。需要一个符合单维护者实际情况、可公开审计且不伪造人员独立性的批准模型。

## 决策

1. 项目继续使用 `single-maintainer` 治理模式。`github:@ferqx` 可以作为 Release Owner 和 Security &
   Privacy Owner，对同一个不可变 candidate 分角色完成一次 candidate-bound maintainer security review。
2. `MS:LIM-APPROVED` 和后续公开发布不再要求另一位真人或独立第三方签署。第三方安全评审改为可选
   assurance evidence；缺失时不得产生“已独立评审”的声明，但不阻塞 Task、milestone、RC、limited 或 GA。
3. maintainer review 必须绑定 candidate commit/ref、payload、manifest、profile、route/platform、Gate
   policy、strict candidate-bound rollback/compatibility report 与 verifier receipt，并覆盖 architecture、security boundaries、artifact identity、
   rollback 和 adversarial bypass 五个范围。候选身份或上述安全材料变化后旧 review 失效。
4. 自审只能在所有适用自动 Gate 已经根据真实 evidence 重建后给出批准。G0/G1、required Verification、
   artifact/signature/attestation mismatch、unknown external effect、未验证平台或未关闭 P0/P1 仍不可由
   maintainer review、exception 或文本声明覆盖。
5. review record 必须使用维护者的已认证 GitHub release identity；workflow actor 和 reviewer
   identity 均必须精确为 `github:@ferqx`，并绑定 canonical repository/ID、workflow path/ref/SHA、
   tag 与 run/attempt，然后进入 Release Gate decision digest。review、自动 evidence 与 Gate 时间必须落在
   GitHub API 认证的真实 run 时间窗口内，且在 verifier 当前时间仍满足 freshness。
   producer/review run 必须先完成；独立 admission run 只能查询已完成的前序 run，不得要求当前尚在
   执行的 run 已经是成功终态。
   不再要求单独的 reviewer Cosign key、reviewer public-key protected variable 或伪造的独立 reviewer trust
   root。GitHub OIDC/keyless Sigstore、artifact attestation 和平台发布者签名继续按 ADR-0062 独立验证。
6. P2 必须修复或在 candidate-bound review 中记录明确处置、影响和回滚条件。存在未关闭 P0/P1、身份
   mismatch、过期 review 或任一必需 Gate 非 passed 时，批准固定 fail closed。
7. 维护者不可联系时仍停止发布、扩 cohort 和事故恢复批准，并保持 cohort=0；本决策不制造 backup 或
   on-call 冗余。
8. 外部贡献者或安全研究者未来提供的真实第三方评审可以作为额外 evidence，并可触发更高 assurance
   标识；它不是默认发布依赖，也不取代 maintainer 对最终 candidate 的责任。

本 ADR 取代 ADR-0060 决策 4–7、备选方案中的“永久取消独立评审”结论及对应回滚限制，也取代
ADR-0062 决策 8 中“第三方评审是 external release 硬门禁”的部分。其余 single-maintainer、无虚假
backup、keyless release signing、artifact identity 和 fail-closed 决策保持有效。

## 备选方案

- 保持强制第三方评审：拒绝；在当前人员和预算条件下形成不可消除的组织性发布阻塞。
- 用维护者备用账号充当第三方：拒绝；制造虚假的独立性。
- 完全删除人工 review：拒绝；最终 candidate 仍需要具名、可审计的风险接受与回滚确认。
- 允许 review 覆盖失败 Gate：拒绝；人工批准不是 G0/G1、签名、identity 或真实 evidence 的替代品。

## 后果

- 单人开源项目可以在真实技术 Gate 全部通过后自行批准和发布，不再依赖不存在的第二位真人。
- 发布记录必须诚实标记 `single_maintainer_review`，不能声称 independent/third-party reviewed。
- 若未来加入第二维护者或建立正式安全计划，可以新增 ADR 把第三方评审恢复为特定发行级别的要求。

## 回滚

可以把 rollout/cohort 收紧为 off/0，或新增 ADR 恢复双人/第三方签署。不能回滚为跳过 candidate-bound
review、允许自批 G0/G1 例外、接受未绑定制品的笼统批准，或把 maintainer self-review 宣称为独立评审。
