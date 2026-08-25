# ADR-0124：Runtime Modularization 与 Authority/Format 分期实施

状态：accepted

日期：2026-08-20

决策者：用户直接指令

相关：Runtime Modularization V1 RFC、ADR-0123、RMV1 implementation plan、RAV1 implementation plan

## 背景

ADR-0123 和已接受 RFC 建立了 Client/Host/Kernel/Provider 的最终目标权威，并把 Project identity、composition identity、Grant/Receipt、cross-Host fencing、DataOrigin/Egress/Credential 与 State 26/Store 5/new epoch 一并放入原 RMV1 实施计划。

六方复核确认目标架构方向和 operation owner/delete matrix 正确，但指出单个 P0 同时承担物理分包、Host/Kernel/SPI迁移、安全体系重建、跨Host协调和持久格式重写，会再次形成巨型任务、巨型Host和全有或全无cutover。用户决定保留最终方向，但拆成两个连续计划。

## 决策

1. 实施分为：
   - `RMV1: Runtime Modularization`：只做物理包边界、App/Contract、Host、pure Kernel、Runtime SPI、Builtin迁移、ExecutionTraits Scheduler、静态领域Reducer和Legacy删除；
   - `RAV1: Runtime Authority & Format`：在RMV1完成后实施Project/Composition identity、Grant/Receipt authenticity、DataOrigin/Egress/Credential、Project resource fence、State 26/Store 5和新epoch。
2. RMV1 全程保持Runtime State schema `25`、Store schema `4`、epoch `kite-runtime-2026-08-18`，保留当前Project identity、Egress/Credential/Sandbox与Session恢复行为。RMV1可以迁移Policy/Intent/authorization decision的物理owner，但不得创建target Store 5，也不得切换本ADR后移的Project/composition/sealing/cross-Host/Egress/Credential/environment fallback语义。
3. 已接受RFC继续作为最终架构umbrella，不改写其历史正文。ADR-0123的最终authority和format方向继续有效，但其“同一RMV1立即实施”被本ADR的分期顺序取代。
4. 目标内部包名调整为：
   - `capability-provider-api` -> `runtime-spi`；
   - `builtin-capabilities` -> `builtin-runtime`。
   两者继续是`private: true`内部编译边界，不是公开Extension SDK。
5. Runtime Host只拥有Session、Mailbox、transaction、Effect supervision、Recovery、Notification和module lifecycle等通用机制。具体Context compilation、Prompt assembly、Model routing、Compaction、Skill/MCP/Filesystem/Sandbox/Verification/Subagent领域语义由builtin-runtime实现并通过port交给Host。
6. RMV1信任Kernel/Host/builtin-runtime为同进程可信代码。Package export和static import gate不是恶意同进程代码的安全隔离。V1通过包边界、静态检查、运行时契约和负向测试共同约束；统一cryptographic sealing后移到RAV1，并只部署到真实序列化、持久化或进程外边界。
7. RMV1 manifest分为：
   - 人工维护的operation owner、legacy delete、source migration、architecture exceptions；
   - 从TypeScript AST/schema、SQLite DDL、workspace graph和package exports自动生成的State/Event/Store/package/export shape。
   自动事实禁止手工重复维护。
8. Agent Kernel在RMV1使用编译期固定的领域Reducer拆分central state/event/reducer ownership，但不建设动态State Slice、Plugin Runtime或namespaced persisted module state，也不改变State 25序列化形状。
9. 正式56-probe Runtime qualification仍是Release Qualification Gate；RMV1架构完成需要fault与CI soak，但不得把未运行的正式qualification登记为通过。
10. 两个计划都使用自动stop-and-report Gate，不需要人工reviewer签署。RAV1在RMV1 completion record存在前保持blocked。

## 替代范围

- 替代ADR-0123中“State 26/Store 5/新epoch与Runtime物理模块化在同一RMV1计划中切换”的实施分期；不取消其最终format目标。
- 替代accepted RFC中`capability-provider-api`、`builtin-capabilities`作为实施包名的默认值；四条Client/Host/Kernel/execution边界保持不变。
- 推迟ADR-0123的approval前environment/no-post-approval-fallback行为切换到RAV1；RMV1 Shell/Sandbox只迁移owner并保持当前active行为。
- 不改写既有ADR历史；RMV1未迁移行为继续由当前源码、测试和active文档约束。

## 后果

- RMV1失败或回滚不需要数据库格式迁移，不影响旧Session恢复；
- RAV1失败不破坏已经完成的package、Host、Kernel、SPI和Builtin边界；
- Host不会因吸收Context/Prompt/Skill/Model领域语义成为新的巨石；
- 统一identity、sealing、cross-Host fence和Store 5会在稳定owner边界上单独评测和切换；
- RMV1-00设计与分期关闭已经完成；当前可立即开始的工作只有RMV1-01精简baseline/manifest，不能提前执行RAV1内容。
