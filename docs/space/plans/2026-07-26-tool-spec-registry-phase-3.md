# ToolSpec Registry 阶段 3 实施计划

状态：archived
创建：2026-07-26
优先级：P0
依赖：ADR-0043、ADR-0044、ADR-0028

## 目标

完成原 RFC §6 的控制平面方向项：Plan 门面 / Runtime Action 化与 Skill 生命周期事件化。保持模型 Schema、事件 discriminant、Artifact 与回放形状不变。

## 实施切片

- [x] **S3.1 Runtime Action 发射协议**
  - 建立统一成功/拒绝结果与事件发射 helper；
  - Plan/Skill specs 不在 `projectResult` 重算事件；
  - 增加“拒绝零领域事件、成功事件顺序稳定”测试。
- [x] **S3.2 Plan Runtime 门面**
  - 把 read/save/submit/progress、Artifact I/O、版本检查和 sibling cancellation 从 specs 收口到 Core 门面；
  - `read_plan` / `write_plan` / `update_plan` 只保留 Schema、契约、effects 与门面调用；
  - 保持 Plan review、replan、Task ownership 和 Artifact 测试通过。
- [x] **S3.3 Skill 生命周期服务**
  - 把 activation、active-frame lookup、reference boundary、close 与 Verification 请求收口到服务；
  - inline/fork 使用同一 close 命令；
  - catalog drift 与失败路径显式事件化，禁止 controller/spec 私自修改 frame 语义。
- [x] **S3.4 Controller 收尾**
  - 删除 Plan/Skill 领域结果重算与重复 terminal mapping；
  - 保留 disclosure、approval、fork adapter 与事件原子提交边界；
  - 补齐 Registry/Controller/Runtime replay conformance 测试。
- [x] **S3.5 文档与全量验证**
  - 更新相关 `docs/active/` 与完成记录；
  - 执行 typecheck、定向测试、全量测试、Core boundary 和文档门禁。

## 完成定义

Plan 与 Skill 的领域状态转换只由各自 Core 门面/服务产生；ToolSpec 是模型适配器，Controller 是治理与提交编排器；阶段 3 的定向测试、全量验证和文档门禁共同通过。

完成记录：[`docs/space/execution/completed/2026-07-26-tool-spec-registry-phase-3.md`](../execution/completed/2026-07-26-tool-spec-registry-phase-3.md)。
