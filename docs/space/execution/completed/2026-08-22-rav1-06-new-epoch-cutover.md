# RAV1-06 new epoch cutover

状态：completed

切换：App bootstrap 现在创建独立 `.runtime-v5.db` target path，并使用 State26 codec projection、Store5 profile 与 epoch `kite-runtime-modularization-v1-2026-08-19`。旧 `.runtime.db` Store4 path 不被 target bootstrap 读取、修改、迁移或双写。

Fail-closed：target adapter 的 format marker 必须为 schema 5/target epoch；旧 session 不通过 target path restore，缺失或不匹配 marker 直接抛出 typed format incompatibility。State25 coordinator 只接收 Host 归一化的 typed compatibility view，named snapshot/fork 也经同一 view 验证。没有旧/new fallback。

Gate：全 workspace typecheck、docs-impact/docs/core-boundary、golden tests、Store4 regression suite（21 passed）、Store5 target conformance（5 passed）、bootstrap/SessionManager/CLI suite（144 passed）、focused TUI cutover suite（5 passed）、fault suite（33 passed）及 CI soak（7/7 cases passed）通过。全仓 default `bun test` 仍有既有环境依赖失败，未作为成功证据。

边界：State26 projection 保留 Kernel 的确定性 typed state 语义，新增 format/project binding 在 storage boundary 处理；后续正式 7×8 fault/soak qualification 仍需使用受信 CI evidence，不以本地 evaluation 替代。
