# RAV1-06 new epoch cutover

状态：completed

切换：App bootstrap 现在创建未被旧 header shim 占用的独立 `.runtime-state26-store5.db` target path，并使用 State26 codec projection、Store5 profile 与 epoch `kite-runtime-modularization-v1-2026-08-19`。旧 `.runtime.db` Store4 path 与 `.runtime-v5.db` header-shim path 不被 target bootstrap 读取、修改、迁移或双写。

Fail-closed：target adapter 的 format marker 必须为 State26/Store5/target epoch；旧 session 不通过 target path restore，缺失与 invalid/corrupt/writer-mismatch/old-format 明确区分。只有无 marker/event/snapshot 的真正不存在 Session 才 fresh。App/Host/coordinator 全部使用 State26，named snapshot/fork/rewind/delete 经同一 Store5 owner；explicit legacy metadata 直接拒绝，没有 compatibility normalization、installation-key gate 或 old/new fallback。

本地 Gate：frozen install、format/lint、7 workspace typecheck/build/test、runtime package/core/docs/manifests 全部通过；全仓 default 为 3546 pass/6 platform skip/0 fail，完整 TUI system 39 isolated PTY files 全过，fault 35/35、local CI soak 7/7、installed OSS candidate（含 invocation-local MCP wrapper）均通过。Runtime 不创建或读取 installation authority key。

完成证据：implementation SHA `604db49d0d32e55bc6761e181856967759cbbb1e`；[Platform Capability Probe 32587639601](https://github.com/ferqx/kite-code/actions/runs/32587639601)、[OSS Release Candidate 32587641939](https://github.com/ferqx/kite-code/actions/runs/32587641939) 与 [Runtime Resilience Qualification 32587644604](https://github.com/ferqx/kite-code/actions/runs/32587644604) 均绑定该 SHA 并成功，正式 7 case × 8 measured report 及独立 verifier 已通过。 本完成记录与总计划形成 final documentation commit；该 docs-only final SHA 还要再次运行相同三套 Gate，且之后不再创建提交。
