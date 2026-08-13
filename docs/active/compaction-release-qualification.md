# Compaction Release Qualification 边界

状态：active
读取时机：修改 compaction case、事实 matcher、结构 adapter、无压缩 handoff 或 compaction Runtime 时。
验证：`bun test tests/evals/compaction tests/runtime/context-compaction-e2e.test.ts tests/release/capability-profile.test.ts`、
`bun run typecheck`。
相关：ADR-0021、ADR-0022、ADR-0024、ADR-0057、ADR-0069、Phase 4。

## 当前本地 contract

`CompactionCaseV1` 只接受 versioned synthetic transcript、1–5 轮增量、分类 critical/important facts、
exact/normalized/semantic matcher、forbidden claim 和可选 continuation。fact ledger 只存在于测试，
不会进入 production checkpoint 或创建第二份正文。

结构 adapter 覆盖 direct/incremental/reset、tool pair、transcript immutability、checkpoint digest/replay/
revision、lease/environment drift、summary rejection 和 system/tool/Plan/Verification/Runtime 权威重注入。
Controller 必须从 source projection 重新计算 checkpoint 的 before/after token estimate，不能信任 compactor
自报的缩减值；RuntimeStore effect lease 保证同一 `thread_id + compaction_id` 跨连接只 dispatch 一次
Provider，snapshot revision CAS 拒绝 stale writer 和删除后的晚到写入。失败保持原状态；invalid checkpoint、
orphan tool result 或状态损坏为 G0。

deterministic matcher 优先 exact/normalized；critical loss、forbidden claim、approval/Verification/Plan
反转都不能被任何语义分数覆盖。旧 blind semantic authority、continuation qualification、route registry、
rollout/shadow evidence 和无 authority workflow 已删除：这些路径始终 blocked，且 ADR-0069 后不再产生
milestone 或产品决策。真实模型兼容性继续由显式 opt-in 的 `test:model:live` 验证；它不是正式 route 资格。

## Route、handoff 与 Gate

无资格时 manual/auto 都关闭，禁止 silent compact；handoff contract 要求保留 transcript 并可保存
diff、Plan、checks、pending，超长任务明确 unsupported，`/clear`/新 session 不能冒充成功压缩。

`manual-compaction-v1.json` 与 `auto-compaction-v1.json` 现与其他 capability profile 一样固定
`under_development/off`、空 route/platform allowlist、freshness=0。Manual 只按当前本地 route/handoff
contract 工作；Auto Compaction 首版不受支持并默认关闭。以后若要支持 Auto 必须重新立项，不能继承
旧 rollout 或 promotion 记录。
