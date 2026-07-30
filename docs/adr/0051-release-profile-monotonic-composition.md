# ADR-0051：Release Profile 使用正交成熟度与发布范围并按字段单调组合

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Release + Security，single-maintainer）
关联：Agent 生产就绪 RFC、D-05、Phase 2A

## 背景

普通 feature flag 不能表达能力成熟度、发布范围、平台支持、权限与预算的共同上限。项目、
用户或 CLI 若能覆盖 artifact 安全上限，会让同一制品产生不可审计的生产行为。

## 决策

1. `ReleaseProfileV1` 把 capability maturity 与 rollout 正交表示；`stable` 不自动等于
   `general`，`canary` 也不改变能力成熟度。
2. embedded artifact profile 是最大权限。rollout、enterprise、user、project 和 CLI
   配置只按字段语义求更严格值，不能抬高 ceiling。
3. boolean capability 求逻辑与；allowlist 求交集；denylist 求并集；预算与 retention 取更小
   上限；approval/verification 取更严格偏序。未知字段、未知枚举或无法比较的值 fail closed。
4. `ReleaseProfileV1` 由 2A 唯一定义资源字段与 composition；1C 只消费有效累计预算，1B 只投影
   process-tree enforcement，App 只加载和展示。
5. profile、实际解析后的默认配置与 capability contract 进入 behavior identity。任何行为字段
   变化使旧 evidence 失效。

## 备选方案

- 只使用 feature flags：拒绝，缺少 artifact ceiling、成熟度和证据身份。
- 后写配置覆盖前写配置：拒绝，来源顺序会放大权限。
- 用单一等级同时表示 maturity/rollout：拒绝，无法独立回滚 cohort。

## 后果

schema 和 composer 需要 property/golden tests；新增字段必须先定义组合偏序。配置层可以继续
收紧能力，但不能用于实验性放宽。

## 回滚

可以把 capability 或 rollout 收紧为 `off`，或回退整个 artifact/profile；不能恢复“项目/CLI
覆盖 embedded ceiling”或未知字段按允许处理的旧路径。
