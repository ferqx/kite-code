# RAV1-06 new epoch cutover

状态：qualification_pending

切换：App bootstrap 现在创建未被旧 header shim 占用的独立 `.runtime-state26-store5.db` target path，并使用 State26 codec projection、Store5 profile 与 epoch `kite-runtime-modularization-v1-2026-08-19`。旧 `.runtime.db` Store4 path 与 `.runtime-v5.db` header-shim path 不被 target bootstrap 读取、修改、迁移或双写。

Fail-closed：target adapter 的 format marker 必须为 State26/Store5/target epoch；旧 session 不通过 target path restore，缺失与 invalid/tampered/key-loss/old-format 明确区分。只有无 marker/event/snapshot 的真正不存在 Session 才 fresh。App/Host/coordinator 全部使用 State26，named snapshot/fork/rewind/delete 经同一 Store5 owner；explicit legacy metadata 直接拒绝，没有 compatibility normalization 或 old/new fallback。

本地 Gate：frozen install、format/lint、7 workspace typecheck/build/test、runtime package/core/manifests、全仓 default（3545 pass/6 platform skip/0 fail + 7 workspace）、完整 TUI system（38 isolated PTY files）、fault（35/35）、local CI soak（7/7）、installed OSS candidate（含 authenticated MCP wrapper）均通过。

待闭合：先提交并推送唯一 implementation SHA；再在该 SHA 运行 Windows/OSS/platform 与正式 7 case × 8 measured qualification+verifier。completion records 绑定 implementation SHA 后形成 final documentation commit，并在 final SHA 再跑受信 Gate；在此之前计划保持 active，记录不得标 completed。
