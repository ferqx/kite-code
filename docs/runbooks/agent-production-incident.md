# Agent production incident runbook

状态：active
Owner：`github:@ferqx`
Backup：`none (single-maintainer)`

本 runbook 只允许 containment、能力关闭、cohort 归零、artifact 回滚和 metadata evidence 保全。
它不启用全量日志，不允许维护者自批 G0 例外，也不代表存在 remote automatic kill switch。

## 1. Detection and classification

G0 包含未授权副作用、sandbox/Workspace trust 绕过、credential/正文外传、Runtime/checkpoint
损坏和 critical compaction fact loss。任一 G0 立即按 critical 处理；无数据或 telemetry 不可用
不能判为健康。

## 2. Ownership and escalation

Owner 为 `github:@ferqx`。当前无真实 backup；Owner 不可联系时 cohort 必须保持 0，恢复批准
blocked。External release 前需要不同真人完成、绑定 candidate identity 的第三方安全评审。

## 3. Containment

按影响面执行 capability off、cohort 0、停止新高风险 invocation；必要时回滚完整
payload/manifest/evidence identity。控制面不可用时保持 embedded ceiling，不扩大能力。

## 4. Evidence preservation

保留无正文、低基数 metadata evidence、artifact identity、run/attempt、时间和 action receipt。
不得为调查自动开启 content logging；正文证据需要单独合法授权。

## 5. Credential and key rotation

隔离受影响 Provider/MCP route，撤销或轮换真实 credential。不要把 token、header、authorization
code 或 private key 写入 incident report。Keyless release identity 变更需要新 ADR/Gate evidence。

## 6. User notification

通知必须说明受影响 capability/cohort、已确认与未知边界、建议动作和后续更新时间；不得把未知
状态表述为零影响。

## 7. Recovery verification

在 clean environment 重放对应 Gate、artifact verifier、rollback/schema rehearsal 和定向
conformance；G0/G1、identity mismatch、unknown external effect 或残留进程均阻止恢复。

## 8. Reopen rollout

只有 evidence 与 Owner 决策都有效时才重新开放；single-maintainer external release 还需要真实
第三方安全评审。恢复不能越过 embedded artifact ceiling 或提高原 cohort。

## 9. Postmortem

记录 detection/containment/recovery 时间、影响范围、action receipts、stale process/session、
runbook gap 和跟进 Owner。正文、路径、命令、用户身份与 secret 不进入默认报告。
