# Agent Note: Sealed Files timeline and confirmed restore baselines

Status: implemented

## Problem

恢复后的原像会产生新 inode。若下一次恢复仍使用旧 preimage inode作为当前后像，就会拒绝真实合法的恢复链。session-only Fork 又可能留下未选中后序 Tool 的物理后像；仅按 selected trigger 聚合会丢掉该证据。已经恢复过的路径还需要该 restore 之前的完整字节，才能解释更早边界之后的文件变化。[恢复定义](../../../../docs/handbook/features/recovery.md)与[Files owner](../../../../packages/agent/src/business/file-checkpoints/README.md)维护这些行为。

## Decision

Files 纯 namespace rebuild 保存有限原 point/head/file、已知恢复 journal与 effect ledger 的完整业务 metadata，不重标原 Store/Session/Source IDs。通过[通用 readonly source delegation](2026-10-03-sealed-readonly-fork-sources.md)转交准确 Tool/自动 Model与恢复 Job/媒体，只从当前 anchor打开原来源。当前 selected aliases 决定 point 资格，真实未选后像仍可作为连续性证据；后续源 head变化不改旧 snapshot。

新恢复写 v2 journal，保 actual runless carrier的 rootWorkSeq、可空 expected baseline与 confirmedPost wrapper。wrapper null 表示未确认，`{baseline:null}` 表示实际确认缺失。restore/remove/unchanged 均核真实返回/读取；恢复后的 hash/size/inode是新 baseline，不能拿预期原像冒充。旧 v1按原闭合结构只读，绝不补造 rootWorkSeq或confirmedPost。

逐文件在物理 IO 前持久 job-scoped完整 before-image和 pending effect ledger，再核真实发布结果、封存confirmed effect与journal。时间线按真实顺序衔接 capture与restore，任何 partial、pending、unknown、scope/媒体/基线漂移继续拒绝。只有 v2 failed、首文件failed/其余not_started、全部confirmedPost空且完整 ledger为空的有限事件，才能在准确原 failed Job/定义/inputDigest/rootWorkSeq/原scope/完整结果核实后作为no-op；事件与原来源均保留，不能直接丢弃失败事实。

## Alternatives considered

- 仅聚合 selected points：会丢掉 session-only留下的真实后像，改为 selected eligibility与全部已封存恢复证据分开核实。
- 恢复成功后沿用原 inode或仅保存预期 bytes hash：没有实际 post-confirmation，采用真实 Files返回与逐文件confirmed ledger。
- 每个 failed journal永久阻断或只凭failed就跳过：前者阻断可证明的零效果故障，后者可能隐藏已发布效果；仅空ledger与准确原终态共同证明no-op，pending仍拒绝。
- 为恢复再增同 Run capture segment schema：审查核实 active Run不能恢复代码、inactive Run不能resume，所推窗口不可达，没有据推演新增协议。

## Consequences

新增有限原 metadata与恢复前完整 bytes的存储成本；不承诺整批文件或code/Fork两步骤原子。完整旧15项与三个真实新增窗口最终18/231/0，包含 later→earlier→新Run、新inode、零effectfailed与pendingledger丢回执拒绝。原失败日志保留；最后 pending反例使用显式等待核同一错误，未放宽生产条件。默认服务新三项3/316/0覆盖两层Fork、codeB成功后Fork再恢复earlyA、同Session selector变化，受影响Browser七文件29/570/0另为独立运行。

Web当前只读目录/detail/status已有实际Cookie/SDK/DOM/IAB资格；完整字节由Service只读核验，Browser展示metadata，不下载或恢复。[完整设计](2026-10-03-sealed-readonly-fork-sources-and-file-restore.md)的 CLI/TUI/Native 开发路径三种范围与持久两步骤 caller 已有各自实际 carrier/window 资格；底层组合与正式入口/完整发行资格仍分别维护。
