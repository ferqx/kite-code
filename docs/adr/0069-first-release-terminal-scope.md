# ADR-0069：首发终态范围与无后续资格路线图

状态：accepted
日期：2026-08-04
决策者：github:@ferqx
取代：ADR-0068 中把 external cohort、长期 SLO/error-budget、internal dogfood、canary、maturity、
Auto Compaction rollout 与发布后 GA observation 保留为 `optional_post_release` 的部分

## 背景

ADR-0068 已把 Kite Code 收敛为单维护者、本地运行的开源 TUI/CLI，并用 G0/G1 取代企业式首发
资格。但路线图仍留下 21 个发布后可选 Task。它们依赖真实用户 cohort、长期观察窗口、分阶段
promotion 或企业 authority，与当前产品形态无关，也会让已经完成的首发方案继续保留没有明确终点的
治理尾项。

## 决策

首个开源版本的生产路线图以 G0/G1 通过为终点，不再保留发布后资格阶段：

- 删除 Limited cohort SLO、长期 SLO/error-budget observation 与对应 milestone；普通故障处理、issue
  triage 和安全修复属于日常维护，不构成 release qualification Task。
- 删除 Compaction、Verification、MCP write 与 Skills 的 internal dogfood、external canary、
  beta/stable maturity promotion 路线。
- 删除 Auto Compaction external shadow/live/canary/maturity 路线。Auto Compaction 继续不受首版支持且
  默认关闭；以后若要成为产品能力，必须从新的 RFC/ADR 开始，不继承旧 milestone。
- 删除企业式 GA capability selection/profile assembly 和发布后 observation 路线。普通候选包通过 G0/G1
  后即可由维护者在单独授权下发布。

原 21 个 `optional_post_release` Task 全部标记为 `superseded`，不登记为 `completed`，因为对应 cohort、
观察或 promotion 事实从未发生。108 个历史 Task 的终态为 83 `completed`、25 `superseded`、0 optional。

旧 schema、verifier、workflow 或测试如果仍能证明 authority 为空时 fail closed，可以作为不可达的历史
安全资产保留；它们不再是当前产品规则、发布 Gate、milestone producer 或未来工作承诺，也不能产生
canary、maturity、SLO 或来源认证结论。

本决策不放宽运行时安全边界：secret、Workspace 越界、未知 external effect、MCP write、destructive
操作和 Verification false pass 继续 fail closed；capability profile 不能扩大 embedded ceiling；MCP
write、effectful Skills、remote telemetry 与 Auto Compaction 继续默认关闭。

## 备选方案

1. 在正式发布前伪造 cohort、SLO 或 maturity 证据。拒绝：不存在的外部事实不能登记为完成。
2. 继续把 21 项留作发布后可选。拒绝：这与“首发前整体方案完结”的维护目标冲突。
3. 删除所有旧 fail-closed contract。拒绝：删除安全资产没有必要；只需移除其发布权威和路线图地位。

## 影响

- 路线图和状态注册表不再有 pending、in-progress 或 optional Task。
- G0/G1、普通维护者检查清单和三平台候选仍是唯一首发判断依据。
- 不再要求或规划 external cohort、长期 SLO/error-budget、canary、maturity 或 GA promotion 系统。
- 未取得的签名、attestation、第三方评审或外部运营证据仍不会被表述为已经取得。

## 回滚

未来若产品形态扩展为托管服务、多用户系统或正式运营平台，必须新增 RFC/ADR 和全新的 Task 集；不得
恢复已 supersede 的 Task、沿用旧 milestone，或把本决策前的 synthetic contract 追认为真实运营证据。
