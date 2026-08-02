# ADR-0063：无正文遥测与单维护者 fail-closed 运营

状态：accepted
日期：2026-08-02
决策者：`github:@ferqx`（Security & Privacy + Incident Commander，single-maintainer）
关联：D-03、Phase 3、ADR-0056、ADR-0060

## 背景

生产评估和事故响应需要低内容指标，但项目当前只有一位维护者，也没有已经批准的 remote telemetry、
SLO baseline 或分钟级远程控制面。历史 OTel/telemetry 方案允许 Workspace、命令或错误正文流入通用
serializer，不能作为当前生产实现依据。把“没有数据”解释为健康，或把本地合成演练冒充真实运营证据，
都会绕过 external rollout Gate。

## 决策

1. production observability 只使用版本化 allowlist metric；禁止 prompt、文件/Workspace path、命令、
   自由错误、secret 和用户正文。受控 alias 超出基数预算时折叠，不创建原始 label。
2. remote telemetry 默认关闭，并要求 release artifact、release-controlled flag、用户 consent 与 exporter
   四重授权。project 永远不能开启或授予 consent；admin 可关闭；canary 需要独立 opt-in。
3. Reporter 只有 bounded memory queue，没有磁盘 spool。exporter 故障不影响 Runtime；consent 撤回清空
   未发送样本。mandatory enterprise audit 是独立 admission，缺失时受管 session fail closed。
4. Dashboard 的 no-data 为 blocked。G0 固定零容忍；其他 SLO 阈值只能在看到 limited 结果前由 Owner
   预注册，包含最小样本、窗口和 error budget。未批准的 `null` 阈值不能被 verifier 当作零或通过。
5. single-maintainer Owner 为 `github:@ferqx`，backup 明确为 none。Owner 不可联系或控制面不可用时
   cohort=0，恢复批准 blocked。控制面只能关闭 capability、缩 cohort 或回滚制品，不能扩大 artifact ceiling。
6. 本地 table-top/contract replay 标为 synthetic 且 G4=`not_run`。真实 incident rehearsal、limited SLO
   observation 与第三方安全评审必须分别绑定实际时间、run 和 candidate identity。

## 备选方案

- 通用 Span/日志先采集再 scrub：拒绝，敏感正文可能在过滤前进入不受控对象。
- project 配置开启 telemetry：拒绝，仓库内容不能代表本机用户 consent。
- 无数据时沿用上一窗口绿色：拒绝，无法证明当前 artifact/route/cohort 健康。
- 单维护者兼任独立第三方 reviewer：拒绝，不具备人员独立性。

## 后果

默认安装没有远程运营数据，baseline 和 external rollout 会等待真实 consent/观察；但普通开发、exporter
故障或撤回 consent 不会破坏 Agent 主链路。单人项目必须保持小规模、可直接联系的 cohort，并接受
Owner 不可用时停止扩面和恢复的可用性代价。

## 回滚

可以关闭 flag/exporter、清空内存 queue、cohort 归零或回滚完整 artifact。不得回滚为内容 telemetry、
project 隐式 consent、无数据绿色、remote control 扩权或维护者自批第三方安全门禁。
