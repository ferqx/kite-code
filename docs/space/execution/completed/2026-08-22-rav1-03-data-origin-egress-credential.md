# RAV1-03 DataOrigin、Egress 与 Credential

状态：superseded by ADR-0127；DataOrigin/EgressAuthority/permit 已删除，真实 CredentialBroker 保留

范围：把 provenance、destination egress 与 credential authority 接入 Model 五 purpose 和 remote HTTP MCP 的真实逐 operation path；CredentialHandle 保持 opaque、purpose-bound，secret 不进入 Grant/Receipt/Event/Notification/log。

实现：SPI 定义 DataOrigin、deny-wins join、destination-specific EgressAuthority 与 CredentialBroker；Builtin Context/Gateway 构造 Observation→Artifact→Fragment→Payload→Egress lineage，缺 Project/Origin/authority 必拒。Builtin MCP Manager 是 remote egress 唯一 owner；App 只组 immutable permit/persistence input。一个 Builtin CredentialBroker 私有持有 Native store，Manager/Auth/OAuth 共用 opaque handle；environment/raw material/direct-store fallback 已清零。

本地 Gate：SPI egress、Model provider policy/Gateway、MCP egress/credential/OAuth/manager/concurrency、secret absence、nonce replay、transport=0 negatives 与 full default/TUI/typecheck/build 通过。

完成证据：implementation SHA `604db49d0d32e55bc6761e181856967759cbbb1e`；[Platform Capability Probe 32587639601](https://github.com/ferqx/kite-code/actions/runs/32587639601)、[OSS Release Candidate 32587641939](https://github.com/ferqx/kite-code/actions/runs/32587641939) 与 [Runtime Resilience Qualification 32587644604](https://github.com/ferqx/kite-code/actions/runs/32587644604) 均绑定该 SHA 并成功，正式 7 case × 8 measured report 及独立 verifier 已通过。
