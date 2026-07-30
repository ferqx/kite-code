# ADR-0056：本地日志 metadata-first，telemetry 无正文，Provider/MCP 接收方独立治理

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Security & Privacy + Release，single-maintainer）
关联：D-02、D-03、D-14、Phase 1A、Phase 3

## 背景

本地日志、产品 telemetry、模型 Provider 和远程 MCP 是不同接收方。仅在 exporter 末端 scrub
正文，不能防止上游采集、队列或错误路径泄露；“遥测无正文”也不表示模型/MCP 没有接收正文。

## 决策

1. production 本地 session logging 默认 metadata-only，owner-only ACL，版本化 rotation 与
   retention；权限或 retention enforcement 不可验证时 logging=`off`。
2. remote telemetry 默认 off，只能由低基数 allowlist mapper 从 typed metadata 构造；
   prompt、源码、路径、命令、summary、tool/MCP content 和任意错误正文不得先采集后 scrub。
3. `ProviderDataPolicyV1` 由 1A 唯一生产，记录 route/endpoint/operator、region、credential
   owner、数据分类、retention/training/content use、subprocessor/DPA/consent 和失效条件。
4. 模型 Provider、每个 remote MCP 与 secondary evaluator 分别授权。remote MCP content egress
   还需要绑定 invocation/server/revision/arguments digest/data class/payload kind 的短时单次
   permit，普通 tool approval 或模型 consent 不能替代。
5. 2A 只消费 canonical Provider policy snapshot/digest；3 只消费无正文 mapper，不复制 schema。
6. route identity、region、retention/training 条款或 endpoint 改变时旧资格失效；未知 schema、
   policy 或接收方 fail closed。

## 备选方案

- 全量采集后集中 scrub：拒绝，敏感正文已进入不必要的处理面。
- 一个 network consent 覆盖 Provider/MCP/evaluator：拒绝，接收方与副作用不同。
- 运行时抓取供应商网页作为 policy：拒绝，不可复现且不可审计。

## 后果

diagnostics 可读性降低，需要 typed reason code、digest 和显式本地 opt-in；每条 production route
需要版本化审核。

## 回滚

可以关闭 logging、telemetry、route 或 remote egress；不能恢复全量正文默认、通用 serializer/
scrub、跨接收方 consent 继承或未知 data policy 继续调用的旧路径。
