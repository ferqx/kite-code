# Agent Note: 按闭合 schema 区分真实回退与旧版拒绝

Status: implemented

## Problem

0002-recovery-audit 在原事务内增加持久审计对象。原 a2b／837 只接受准确0001 schema；同 format major 1 和未变0001 checksum不能使它们识别新增对象。实际Terminal回退被 store_incompatible 拒绝，Native随后投影为 required_capability_missing。继续要求这对固定版本可写同一个新库，会与现行增量恢复安全和完整schema准入冲突。

## Decision

用户2026-10-16确认保留0002审计，明确版本兼容边界。兼容A→B→A→B固定真实合并提交4a4c0e440b2098e5b4ec58c5831452773b39228f，11项lock／workspace／patch与两份SQL必须原字节相同，SQL另核固定checksum；不开放任意ref、不改旧源码或builder。30e7缺UI Markdown清单，21fd缺0002，不能替代该组合。新旧物化入口共用原闭包、clean source、源码删除和平台进程／期限。

原a2b／837、历史SHA、准确映射及原拒绝反例继续保留。a2b实际Terminal另核0002安全拒绝和原数据不变；Native以两个独立Profile分别核Core0002拒绝和Core0001配DB9的私有拒绝，避免Core先拒绝却声称验证了private路径。数据由当前公共Store／生产PrivateData owner或原a2b Store产生，不直接造资格SQL、不复制／恢复／降级。正常进程退出、真实EX、完整bytes／inode、配置和零重放仍为成功条件。

原兼容整例的三真实任务、完整正文／原身份／冷读／后续工作、真实双builder和Mac Main／renderer差异保留；原360／420秒整例、120秒driver、15秒窗口、60秒冷段及Windows1140000ms绝对期限不变。新增旧版拒绝整例独立有限预算，不延长原链。

## Alternatives considered

- 改旧reader／切换为合成标签或恢复旧DB：破坏原始来源或同Store完整数据链，未采用。
- 停用0002并仅扫描剩余历史：会失去首次冷读前删除／移动的持久成员证据，并失去有界审计性质，未采用。
- 退出时删表／改迁移记录，或另建旁路证据库：分别破坏崩溃／维护字节边界或同WAL原子性，未采用。
- 将任意manifest或迁移差异都解释为兼容：关闭原依赖和schema守卫，未采用；只准固定真实提交的完整同字节输入。

## Consequences

15项完整输入单元继续核原历史SHA、精确拒绝及新兼容输入；新旧入口职责和provenance可独立追溯。2026-10-16在本机macOS按原隔离协议运行完整Terminal与Native文件，分别2 pass／153.20秒和2 pass／1303次断言／300.59秒；包含新增真实旧版拒绝，原业务与安全断言／时限保持。兼容Native仅在隔离测试制品调用已有testDiagnostics构建选项；普通dev／prod和Windows正式资格制品仍关闭。

有限Provider夹具明确支持100万token窗口，保留三次原始业务请求及全文，不将自动摘要误算为其中一次任务。两代真实代码分别需要的Profile和user配置同字节生成并受原字节保护。旧Native seed进程退出且WAL缺失或为空后，migration观察才可使用immutable只读URI；它不是活动库或生产Store的读取回退。

新增Native旧版拒绝沿完整文件既有darwin／linux范围执行，复用准确runtime路径的进程观察，并按平台传递Electron分发目录及Linux显示环境。原DB8／DB9额外旅程仍保其原macOS范围；新Linux拒绝分支只有源码与静态核查，不声称本机已执行。

Windows caller同步精确兼容ref和隔离模型输入，本机只核静态与适用短测。根与8workspace类型／构建、默认全量、文档／边界／API／测试归属／发布证据检查仍为交付门禁，不能由两个局部资格文件替代。

本地未发布代码比较不授已发布predecessor／T029或Win／Linux原生资格。format major保持1只表达当前已支持闭合版本集合，不承诺任意旧writer。历史运行证据按原提交保留，不自动算作4a4c新组合通过。当前owner归[Terminal](../../../../apps/cli/docs/terminal-release.md#验证边界)、[Native](../../../../apps/desktop/docs/native-release.md#真实代码升级与冷回退)与[release control](../../../../docs/active/release-control.md)。
