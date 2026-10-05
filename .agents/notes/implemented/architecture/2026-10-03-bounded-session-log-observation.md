# Agent Note: 会话日志保存事件当时的有限观察信息

Status: implemented

## Problem

客户端需要按需读准确原 Session 的日志，且翻页时不能被后续事件改变上界。现有 change event 的 payload 属于内部实现；从当前状态反推过去的状态会改写历史，直接发布原 payload 又会暴露正文、配置和私人恢复信息。日志中的 Model 链接也必须能由原主体合法读取，不能成为新的执行入口。

## Decision

Core 在原事件追加事务内保存私人闭合 `kite.session-log@1` envelope，包含事件发生时间、当时有限状态、类别和准确对象关系，原 payload 保在内部字段。既有 getChanges 对外继续返回原 payload；旧事件或未知格式不推测历史状态，而是保有限 unavailable/null 元数据。Core 不增加第二个事件库或恢复权威。

private Store 观察 API 绑定实际 expected Store、Session 和原 root creator subject。SQLite 同一只读快照验证 replay floor、固定 upper 和实际 snapshot cursor，按十进制64位游标分页。默认及最大200条，每页最多512 KiB；after 低于 floor 或高于 upper、upper 超过 snapshot 均明确拒绝，不能偷偷跳游标或丢项。GET 不 ACK、不创建 Command/Run/Execution、不调用 Provider、不读取 vault。

实际 Model 导航只在原 Model metadata/request/reference、Command/Run/root、attempt、subject 和封存 binding digest 均相符时给准确 Execution ID。当前关系漂移令导航 unavailable，事件当时的状态仍保持。完整模型正文和 Artifact 留在既有单独只读、显式确认的 Model Inspector，不放进日志 DTO。

Service 默认装配接 actual Store 的有限 source，只有存在该 source 才宣告 `session_logs`。公共 GET 的 query/response 严格闭合；Native SDK 只用原 bearer，Cookie Gateway 只沿原 Page 身份，Web 不接 native token。SDK 另核原 Store/Session、完整游标关系、逐项单调进度、导航合法关系和流式512 KiB上界。Web 按需打开/刷新/翻页，最多1000条及2 MiB显示元数据，保固定上界；错误保已读页并明确过期，关闭、隐藏、Session/Store 切换拒绝旧响应。日志读取不成为恢复授权。

## Alternatives considered

- 公开 change_event 原 payload：可能泄露正文、配置和内部事实，改为有限封存元数据。
- 每次读取从当前表反推历史状态：后续变化会改写旧日志，改为追加事务保存当时信息。
- 新建日志 SQLite 库或独立执行索引：增加第二权威及冷恢复关系，复用原事件与实际来源校验。
- 翻页采用不断变化的最新 upper：会将新写入混进原页集，首次读冻结 upper，显式刷新另开页集。
- 日志直接展开模型正文或自动恢复过期游标：扩大正文读取或掩盖缺项，保单独确认与明确失败。

## Consequences

实际 Core 三文件14/231覆盖原 metadata、旧/未来格式、scope、Model binding 漂移和外来 subject 导航拒绝。公共三测试78断言及六文件邻接22/413通过实际 SQLite、Native SDK、Cookie Gateway、Browser SDK 与默认 paired source main：超过200事件的固定上界、新写入仅在刷新可见、abort/cold readonly 零新业务效果。完整超过64 KiB模型请求与来源在项目源码后来变化后仍按原封存事实读取，Provider 只有原一次调用。SDK 当前2/76另核严格 DTO、MAX64、坏页/导航、512 KiB流式界及 undefined query 省略。

Web DOM 资格覆盖有限按需读取、旧响应隔离、过期保页和原 Model Inspector 第二次确认。实际 Codex In-app Browser 已用编译 Web、Cookie Gateway 和原 Service/SQLite 核 fixed upper 36→46 仅在显式刷新采纳、目录 pointer/键盘/偏好/折叠和620×800顶栏焦点 Escape。首次现场 Escape 失败已修，三文件17/192邻接保原行为。后续1280×800现场准确原 Model 导航与第二次确认读取完整189字节 sealed请求；观察前后原 Provider3、Messages4、Runs2、Executions4、cursor45不变，两个真实 Job 成功且所属进程正常结束。该 source main 不是源码外 installed 制品，也不代表任意尺寸/浏览器或 Linux/Windows、正式入口退役。

实际实现、边界与原日志归 [Store owner](../../../../packages/agent/src/storage/README.md)、[Service owner](../../../../apps/service/README.md)、[Client owner](../../../../packages/client/README.md)、[Web owner](../../../../apps/web/README.md)、[日志手册](../../../../docs/handbook/clients/web/guides/logs.md)与[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
