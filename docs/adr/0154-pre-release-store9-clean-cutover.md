# ADR-0154：未发布 Store 9 采用 clean cutover

状态：accepted

日期：2026-08-30

决策者：用户直接指令

相关：ADR-0128、ADR-0151、ADR-0152、ADR-0153。

## 背景

ADR-0152为Store 7/8、旧companion process和filesystem Artifact设计了完整离线迁移、跨版本停止、`kite.next.sqlite`恢复、
first-write rollback fence与启动期source cleanup。Kite Code仍处于未发布阶段；ADR-0128要求clean cutover，不为旧内部格式保留长期
compatibility façade。上述迁移机制还进入正式CLI和每次Service启动，超过了首发产品需求。

## 决策

1. 正式CLI、release entrypoint和candidate不提供Store 7/8迁移或legacy Web recover；旧Coordinator、Worker、Gateway release
   entrypoint及其release-side manager被删除。
2. 正常Service启动只打开当前`kite.sqlite`、取得native endpoint、reconcile当前Controller并发布ready。它不扫描、迁移或删除旧DB、
   layout、Artifact、process state或`~/.kite-code-coordination`。
3. Store 9只保留current schema/format metadata与有生产消费者的领域表。删除`first_write`、fresh `store_origin/migration_phase`和无运行时
   reader的`service_operation_receipts`；普通写入直接使用现有`BEGIN IMMEDIATE` transaction。
4. `web_status`是只读状态查询，不mint launch token。只有`web_ensure`创建一次性launch URL；TUI `/web`调用ensure/open语义。
5. 旧未发布home数据不自动删除。需要保留本机开发数据时，由开发者在明确授权下单独备份或使用不进入正式发行物的一次性工具；当前
   不预建该工具或兼容接口。

## 后果

- 正式产品只有单Service、单Store 9和当前Web lifecycle，不携带旧拓扑的升级控制面。
- clean cutover可能不读取alpha/internal home中的旧Session，但旧文件保持原样，不会被新Service自动删除。
- 原子Runtime transaction、Controller recovery、typed Artifact表、asset-first Web preflight、PID/start identity和三平台原生验证继续保留。

## 替代关系

本ADR替代ADR-0152的离线迁移、启动期source cleanup、first-write rollback和transition `web recover`部分；ADR-0152的单Service、单SQLite、
typed Artifact与最小OS runtime决定继续有效。ADR-0151的asset-first和typed diagnostic继续有效，独立Gateway恢复只作为历史实现事实。
