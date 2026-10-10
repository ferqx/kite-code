# Agent Note: 离线备份在稳定维护锁内发布验证候选

Status: implemented

## Problem

活动 SQLite 数据可能仍在 WAL 内，仅复制 core.db 会遗漏已提交事实。数据库之外的不可变媒体也需要完整核实，锁对象不能随可替换 profile 数据移动。备份失败必须留在无效候选范围，否则后续恢复可能选择不完整数据库或媒体。V1.3 §23.3 要求一致数据库、从副本引用枚举媒体、明确跨介质采集边界及不包含凭据/锁资产。

## Decision

已交付的 [maintenance owner](../../../../packages/agent/src/maintenance/README.md) 使用显式离线 `createProfileBackup` 与 `inspectProfileBackup`。它取得现有外部 profile-use 排他锁；busy 有界失败，未完成恢复 journal 和 SQLite rollback journal 拒绝开始。生成 VACUUM INTO 候选，再由副本枚举 blob_ref，完整复制和验证 64KiB 分块媒体；数据库 schema/checksum、integrity/FK、清单和摘要全部验证后 fsync，最后发布 ready 标记与独立备份目录。

Core与Desktop现在在同一稳定排他权内，先完整复制原DB与实际存在WAL到本次私有scratch，SQL只打开该副本作原schema/capture/VACUUM。原配对的presence、完整bytes/SHA与dev/ino/ctime/size/mode/uid/nlink在采集、每个文件复制之后及SQL回调前后核对；缺失WAL保持缺失，SHM不复制，scratch在后续验证和发布前删除。该边界不取代原Store/Node严格关闭或Profile排他权，不放宽原全部指纹、格式与ready守卫。

维护自身的 strict-close 也必须确认，不能因为错误已返回就交出 Profile EX 或删除仍被打开的 scratch。backup／inspect／restore／reconcile／GC 共用每次调用内的资源 owner，登记原 SQLite、fd、Dir、Windows pin 和临时发布句柄；只有实际关闭成功才解除 pending。未关闭对象与原 EX 保强引用至实际宿主退出，另一 Profile 不受这次维护权阻塞。Windows fd先确认关闭并删除旧映射，再关闭 pin，避免 fd复用错误；原多个 closer仍全部尝试，处理与关闭双错保留原出处。该 owner不改变SQL、清单、restore journal和新Store／来源边界，也不构成Windows原生资格。

原 Store、origin、业务 ID 与序列不修改；VACUUM 物理 rowid 不被承诺为业务身份。v2 清单分别采集现有 config.jsonc 原字节、desktop-private/data.sqlite 一致副本与 TUI owner 的 ui/tui.json，独立记录采集时间、存在状态和完整摘要，不声称跨介质同时原子。Desktop 验证原 application ID、版本、闭合 schema 与 integrity；保留原草稿/创建身份。TUI 文件验证闭合 version 1、原 Store/Workspace/Session 和由原 scope 计算的 ID、Decimal64 revision 与完整原文；缺文件如实记录 absent，不创建示意内容。清单排除独立凭据 vault、未采集宿主私有文件、coordination 和 locks；配置原文可能包含敏感内容，因此仍是私有0600数据，不将原文备份误称为脱敏。备份 leaf 不派发活动任务，也不增加运行期循环或 Store。

后续 DB5 人类答案随整份一致私有 SQLite 纳入 closed v7，独立行验证与冷查询边界见[原答案资产决定](2026-10-04-original-human-answer-intent-assets.md)。 实际存在独立 MCP 选择 journal 时使用 closed v8，原完整元数据与字节保留、旧格式白名单不扩大；独立 codec 和新 Store 冷 reader 的证据边界见[原 MCP 资产决定](2026-10-04-original-mcp-selection-intent-assets.md)。本页 v2 原始决定及稳定维护锁、vault 排除、跨介质采集限制仍适用；新格式不把旧行重标成新 Store authority。

## Alternatives considered

- 复制活动 core.db：不能覆盖 WAL 已提交状态，不采用。
- 直接以readonly打开原已关闭WAL库：实际selected3.51.3新owned Profile证实，原DB整字节与dev/ino不变，但原缺失的WAL/SHM可被读取新建为0/32768bytes并触发backup_source_changed。SQLite[只读WAL规则](https://www.sqlite.org/wal.html#read_only_databases)允许该行为，因此改为关闭后排他权内DB/WAL配对副本，不以immutable忽略WAL、原库checkpoint、预热或GC消除反例。[文件复制约束](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active)的无活动事务与配对WAL仍必须满足。
- SQLite Online Backup API：方案允许且支持渐进复制，但当前显式离线维护已取得排他应用权；使用 SQLite 提供的 VACUUM INTO 一致候选，避免引入另一套驱动备份绑定。后续真实发行引擎资格仍独立验证。
- 借用在线 Store 的 shared authority 或将 SQL EXCLUSIVE 当作应用关闭证明：不能与稳定 profile-use 恢复协调边界等价，不采用。
- 仅以 ready.json 或 SQLite 命令成功证明有效：不能证明完整媒体、清单或发行原子性，不采用。

## Consequences

一次备份要完整读取数据库与引用媒体，期间相关profile保持离线排他权。私有DB/WAL副本增加暂存空间与完整读取成本，原完整指纹与实体核对不为节省I/O省略。取消在DB/WAL及媒体64KiB异步复制检查点响应；VACUUM是同步命令，不能声称逐指令可取消。全部原资源确认关闭后，失败只删除本次staging/scratch；未确认时保留临时目录和维护权至实际宿主退出，源profile不修改。完整媒体SHA/hash验证使用固定分块内存；前后观察不能声称阻止所有不合作外部writer。

[实际测试](../../../../packages/agent/test/isolated/maintenance/backup.test.ts) 在 macOS/Bun 1.4.2 通过 SQLite/WAL、17MiB 原媒体、大整数/未知原文、第二进程占锁、journal 拒绝、篡改/取消无 ready、源码树外临时 bundle 的实际 create/inspect；严格关闭和失败预检回归也已加入。备份/恢复/recovery/取消最终组合通过 28 项、306 个断言。它不证明 GC、平台发行、断电或完整 W19。

完整包外实际联验曾发现 Store 关闭后 DB/WAL 仍变化。Bun 默认 Database.close(false) 可将 prepared statement/连接留到 GC；Worker terminate/close 事件不证明底层资源已经退出。Worker close ACK、失败 open、preflight 和 baseline 临时库均改为 close(true)，然后再释放原 profile 锁。原文件指纹检查没有移除，也没有用 sleep 等待消除失败；多查询→close→backup 与失败预检回归、完整包外 create/inspect 已实际通过。后续显式恢复持同锁和 journal 的决定由[显式恢复决定](2026-10-02-journaled-profile-restore.md)记录，当前 config/UI 独立采集不代表完整 TUI 持久状态、GC、安装或三平台资格。

本机引擎 source ID 与官方同名 3.51.0 不同；官方 WAL-reset 修复的供应商补丁映射仍未验证。不能用本次绿色测试或版本名完成多连接 WAL、安装和三平台资格。当前准确实现、引擎事实与官方来源保持在 maintenance owner。

恢复后原Artifact读取曾因当前Store准入与原引用来源混用失败，现分别核实两者，原内容/来源保持；公开HTTP全文与19入口完整manifest复验1/49通过，同时核v2原配置hash/字节和恢复新Store。后续同一包测试加入实际 TUI JSON 原字节/摘要及大 revision，恢复后仍属旧 Store，不重新绑定到新 Store。完整Desktop UI恢复与七个SIGKILL窗口使用实际Node私有库owner，保原133份草稿及unknown creation；这些事实仍不代替全部调用者或平台资格。

2026-10-05在公开Artifact SH/reverify和引擎选择后的实际SQLite3.51.3上，原两个维护测试文件共24项348断言通过：真实Core Store.close与Desktop owner关闭后不重开原库预热，backup/inspect保原完整字节和原WAL/SHM缺失，已有WAL事实、草稿/unknown creation、媒体与取消无ready保持。当前源码外Source PTY的公开v10 create/inspect/restore A→B亦实际通过，精确范围归maintenance/CLI owner与当前进度。这些证据不包含跨文件替换barrier、scratch/lease清理故障注入、安装包和三平台资格；外层staging清理/release异常可能覆盖原错误的限制仍保留。

当前原两文件的测试准备已改为真实公开SQLite engine leaf＋正式release builder＋公共initializer，每个isolated文件在首DB/Worker前核选定引擎；新增setup hook60秒不改变原业务5秒/30秒。它不依赖旧candidate或integrity-only假库，外部已有selected资产只复验，自有资产保留至最后DB关闭后才删除。loaded selection不能reset，因此仅声明每文件独立进程生命周期，不新增同进程多文件兼容框架。独立Source资产文件继续默认引擎，准确memory测版本/sourceId，并保存关闭后Core DB/WAL/SHM全部presence和已存在完整bytes，在backup/inspect后分别核不变。这样缺失副文件和供应商关闭后保留副文件两种事实都受验证，不把默认关闭状态误当selected3.51.3。

2026-10-05当前真实macOS原三文件28项418断言、正常Root/Agent types均通过：两qualified文件24/348，独立default文件4/70且原WAL0B/SHM32768B保持。精确SHA、actual日志与此前完整默认第24轮红保留在当前进度；当前整轮默认仍待重新验收。此新增测试准备不扩大生产Agent依赖、manifest、维护权限或平台资格。
