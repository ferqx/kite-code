# ADR-0048：安全配置、Secret 与诊断数据采用用户级 Ceiling

状态：accepted
日期：2026-07-28
决策人：项目所有者（RFC 转实施确认）

## 背景

当前项目配置可覆盖用户的 interaction mode、sandbox、auto-review 和 feature flags。Workspace trust 会允许读取项目配置，但不应等价于允许仓库内容提升权限。stdio MCP transport 当前继承完整 `process.env`。Session logger 默认保存模型正文、工具参数、命令和失败输出，regex 脱敏无法可靠覆盖任意结构化 secret。

## 决策

1. 配置字段携带 `default | user | project | cli | admin` provenance。
2. 安全字段采用用户/admin ceiling：
   - project 只能收紧 sandbox 与 Windows Bash；
   - project 不能提升 `accept_edits → auto/full`；
   - full access 只来自当前用户交互或显式 CLI；
   - `autoReview.failOpen` 在 0.1.0 移除或强制 false；
   - project 只能开启不扩大权限的 feature allowlist。
3. Workspace trust 允许读取项目配置和能力声明，不授予安全边界降级。
4. stdio MCP 默认只继承启动必需的最小环境 allowlist。Secret 通过 credential reference 或逐项批准的 env-name 引用注入。
5. 本地 Session 日志默认 `metadata_only`，不保存 prompt、reasoning、final、文件内容、Shell command、Tool Result 或环境值全文。
6. `diagnostic` 必须由用户显式短期开启并持续提示；结构化字段 scrub 在进入 writer/exporter 队列前完成，regex 只作第二层补救。
7. 日志、telemetry 和 artifact writer 均有容量与磁盘配额，不能因辅助数据失败形成无界内存。

## 备选方案

- Project 无条件覆盖 user：拒绝，仓库内容可降低安全边界。
- Workspace trust 后允许全部覆盖：拒绝，信任项目不等于授权提升。
- MCP 继续继承完整环境并依靠 server 自律：拒绝，违反最小权限。
- 保留正文日志并加强 regex：拒绝，结构化和未知 secret 无法可靠覆盖。
- 完全关闭诊断：拒绝，预生产仍需要受控故障证据。

## 后果

- Config merge 从对象覆盖变为字段级 provenance/ceiling。
- MCP server 可能因未显式声明所需环境而启动失败，需要明确诊断。
- 默认日志的调试信息减少，但泄密面显著降低。
- 需要安全配置、MCP env isolation 和日志内容回归测试。

## 回滚

安全 ceiling 不允许通过普通 feature flag 回滚为 project 可放宽。若诊断需要临时扩大，只能使用显式、短期、可审计的 user diagnostic 配置。MCP 环境兼容问题通过增加逐项 allowlist 解决，不能恢复完整 `process.env` 继承。
