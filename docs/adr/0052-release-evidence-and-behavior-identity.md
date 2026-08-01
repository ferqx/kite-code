# ADR-0052：Release Manifest、Evidence 与 Gate 绑定同一行为身份

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Release + Platform，single-maintainer）
关联：D-06、D-12、Phase 2A

## 背景

只绑定 commit 或外层压缩包 hash，不能证明测试结果对应实际 payload、Runtime 调度策略、系统/
工具契约、Provider policy 和默认测试入口。把 manifest 放进被自身 hash 的 payload 还会产生
自引用。

## 决策

1. 发布 bundle 分为 immutable payload、detached canonical `ReleaseManifestV1` 与可选 detached
   signature/provenance；`payloadSha256` 只覆盖 manifest 之外的 payload bytes。
2. canonical JSON 使用版本化、跨平台确定的 UTF-8 字节表示；未知 schema/value、重复 key、
   identity mismatch 或 canonicalization mismatch 一律阻断。
3. behavior identity 至少绑定 Release Profile、agent/system contract、model-visible Tool
   Registry、实际默认配置、Provider Data Policy、Gate policy、build recipe/default test
   runner、Runtime schema 与 Runtime 导出的 `RuntimeSchedulingPolicyV1` snapshot。
4. 1C 从实际 Runtime 导出 scheduling snapshot；2A 只 canonicalize、hash、打包和 smoke compare，
   不复制 scheduler allowlist、barrier、permit 或 terminal 语义。
5. `ReleaseEvidenceV1` 只接受与同一 manifest/payload/route/platform/suite identity 匹配的结果。
   G0/G1 不可普通 waiver；缺失或陈旧结果为 blocked，不选择“最近绿色”补位。

## 备选方案

- 只记录 Git SHA：拒绝，构建输入与实际 payload 可能不同。
- manifest 内嵌 payload 后再自 hash：拒绝，产生循环身份。
- release script 手写调度快照：拒绝，会形成第二套 Runtime 事实。

## 后果

任何 contract、schema、runner、route policy 或 canonicalizer 变化都会主动失效旧 evidence；
构建与 Gate 需要更多 golden、tamper 和 cross-platform fixture。

## 回滚

可以回退完整 payload/manifest/evidence bundle；不能恢复未验 payload、跨 identity 拼接 evidence、
未知 schema 继续启动或 G0/G1 普通 waiver 的旧路径。
