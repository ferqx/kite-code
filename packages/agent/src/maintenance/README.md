# 显式离线备份

Profile 的 `mcp.json`、`mcp-approvals.json`、`mcp-auth-bindings.json` 任一实际存在时，当前创建 closed manifest v16；准确 raw 资产与恢复后消费者合同见[Profile MCP 配置资产](#profile-mcp-配置资产与-manifest-v16)。三者均不存在时才使用下述 v5–v15 条件，旧 v2–v15 白名单不扩大。

没有上述 raw MCP 文件时，当前 Native MCP 私有 DB7 使用专属 closed manifest v15；原申请字节合同见[DB7 与 manifest v15](#desktop-db7-与-manifest-v15)。

没有上述 raw MCP 文件时，历史 Desktop 私有 DB6 创建专属 closed manifest v14，携 v13 全部准确资产项并保存新增配置原意图与 Session 模型路由；v14 必须真实 present DB6，DB6 不能重标为 v2–v13。DB1–5 和无 Desktop 资产继续按下述历史条件创建版本，旧 grammar 不扩大。具体见[DB6 合同](#desktop-db6-与-manifest-v14)。

现有 `ui/caller-intents.json` 实际含闭合四类 `mcp.auth.login/refresh/clear/revoke@1` 请求时创建 closed v13；它保 v12 全部资产字段与物理白名单，不新增认证 journal。未含 Auth 时继续下述条件版本，旧 v2–v12 的原请求语法和准确格式不扩大。

未含 Auth 而来源条目变更申请实际存在时创建 closed backup v12，携完整 v11 项并增加独立 `mcpSourceMutationIntents`。否则依次按实际存在的重连、来源决定、连接、选择文件创建 v11/v10/v9/v8，其余沿原 Desktop/Files 的 v7/v6/v5 规则；不创建缺失 journal。准确字段和旧物理白名单分别按下文资产合同验证，当前可检查 v2–v16，新版本不扩大任一旧版本。

独立 MCP Source 决定申请资产与条件 backup v10 已实施；旧 v2–v9 白名单保持，当前格式见[Source 资产 owner](#mcp-来源决定申请的独立离线资产)，本片取舍与已完成的有限验收见[Source 决定](../../../../.agents/notes/implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)。

实际存在独立 `ui/mcp-connection-intents.json` 时创建 closed manifest v9，携新增 `mcpConnectionIntents` 与原 v8 全部资产项；没有连接文件而实际存在 `ui/mcp-selection-intents.json` 时创建 v8，携 `mcpSelectionIntents` 与原 v7 全部资产字段（包括明确 absent 的 Files journal）。否则当前创建通常输出 v5；Desktop 私有 DB5 输出 v7，携与 v6 同组准确资产字段；实际存在 `ui/file-recovery-intents.json` 或 Desktop 私有 DB4 时输出 v6。v6 必须带 `fileRecoveryIntents:{path:'ui/file-recovery-intents.json',present,capturedAt,proof,format}`，文件缺失时 proof/format 为 null，不创建替代 journal。v5 继承 v4 的 callerIntents 并接纳准确 DB3；v6 另接纳DB4。历史清单的精确字段、物理白名单和Desktop DB版本保持原契约：v2仅DB1，v3/v4为DB1/2，v5为DB1/2/3，v6–v13接纳DB4和Files文件，v7–v13接纳DB5，v8–v13接纳MCP选择文件，v9–v13接纳连接文件；v10–v13另接纳Source决定文件，v11–v13接纳重连文件，v12/v13接纳来源条目变更文件。新字段、文件或SQL格式不能通过改写旧版本或格式声明混入旧备份。

Service 显式 Workflow flags 的 `skill-workflow.jsonc` 是独立受控资产。closed v3–v16 manifest 必须包含 `skillWorkflowConfiguration`，记录准确 path、absent/present、采集时间与完整 proof；缺项拒绝，旧 v2 仅按原字段和路径精确读取。备份和恢复保留原始 JSONC 字节，包括注释、未知字段及损坏内容，不解析 flags、不开启 Workflow、不接触 vault；缺失文件保持缺失。备份根白名单只增加该项明确存在的 `skill-workflow.jsonc`。资产测试覆盖原字节、缺失、清单篡改、链接与权限；既有 SIGKILL 恢复日记 fixture 同时携带备份原 flags 与后续 flags，complete 和 rollback 分别核对对应原字节。

`@kite-ai/agent/maintenance` 的 [createProfileBackup / inspectProfileBackup](index.ts) 是宿主明确调用的维护入口，导入不打开资源。创建只接收明确 profile 和目标目录，不借用已打开 Store 的 shared 权限。它取得 profile 外部稳定 `profile-use.lock` 的 exclusive 权限；busy 立即返回，不强杀 Service，不升级现有共享锁。未完成恢复 journal 和 SQLite rollback journal 均拒绝开始。目标禁止落在原 profile 或 `.coordination` 内。

[backup.ts](backup.ts) 在原 profile-use 排他锁内，先由 [files.ts](files.ts) 将完整 Core DB 与实际存在的 WAL 配对复制到本次私有 scratch，只打开该副本，核原 schema/capture 后执行 `VACUUM INTO` 生成一致候选。原 DB/WAL 的完整字节、存在状态及 dev/ino/ctime/size/mode/uid/nlink 在配对采集、每次复制之后和 SQL 回调前后重新核对；缺失 WAL 不创建替代，原 SHM 不复制，任何变化均拒绝发布。SQL 不打开原库，因此关闭后没有副文件的原 Profile 不会因只读 SQLite 连接而新建 WAL/SHM。scratch 在后续候选验证和发布前删除，不进入备份树。

候选的 `blob_ref` 与 `blob` 决定被引用媒体，以 64KiB 块复制并核对完整长度与 SHA-256。Store、来源 ID、业务序列和未知原始文本保持原值；VACUUM 可能重分配没有 INTEGER PRIMARY KEY 的物理 rowid，备份不把它当业务身份。数据库必须匹配当前基线 schema/checksum，通过 integrity/FK 检查；清单和媒体清单使用 Decimal64 计数、摘要与准确引擎版本/source ID。DB/WAL 完整复制增加临时磁盘占用和读取成本；复制在异步分块检查点响应取消，同步 SQL 不能抢占。配对守卫不声称阻止不遵守应用锁的外部写入者。

仅本次创建的私有 staging 会在失败时删除。数据库、媒体、清单完成验证和 fsync 后才发布 `ready.json`，最后将 staging 改名到独立备份目录并同步父目录。检查备份重新核对数据库、媒体清单、每个媒体完整 hash 和目录内容，不能仅凭 ready 标记认定有效。文件要求私有、当前主体持有、非软链接、单一硬链接；媒体不可写。检查失败不会修改原 profile。

[assets.ts](assets.ts) 独立采集实际 profile 的 `config.jsonc`、三份 raw MCP 配置、`desktop-private/data.sqlite`、`ui/tui.json`、`ui/preferences.jsonc` 和明确的请求 journal，每项记录 path、present、capturedAt 与完整 proof；缺文件记录 absent，不创建替代配置/UI。配置保留精确原字节，包括 BOM、注释、未知字段、credentialRef 和损坏 JSONC；不解析或 redact，也不读取 vault。原配置本身可能包含敏感内容，清单明确 `configurationMayContainSensitiveContent:true`，备份 0600，不承诺原配置没有秘密。Desktop UI 沿同一私有 DB/WAL 配对复制 helper，只在 scratch 上执行 VACUUM INTO 和格式读取；校验 application_id 1263888689、准确 v1 两表、v2 三表、v3 四表、v4 五表、v5 六表、v6 八表或 v7 九表 schema、实际 user_version 与 integrity/FK，单独记录格式和采集时间。未知 UI 格式/rollback journal 拒绝，源 DB/WAL 完整指纹、实体与缺失副文件状态保持。配置、Core、UI 各有采集边界，不宣称跨介质同一瞬间原子。兼容闭合 manifest v2–v16；准确版本与资产白名单按首段契约验证。

清单排除 credentials、credential vault、未列入白名单的宿主私有文件、coordination 和 locks。Desktop私有库是明确的采集例外，不复制该目录其他文件。TUI 的真实用户数据由 CLI host 持久 owner 写入 `ui/tui.json`；清单分别记录存在、采集时间、完整摘要及 `{version:1}` 格式。严格核对完整 JSON、Decimal64、原 Store/Workspace/Session 与 scope hash；完整文本原字节保存，不改绑新 Store。真实终端偏好由 CLI host 的独立 owner 写入 `ui/preferences.jsonc`；备份按原始 JSONC 字节记录存在、采集时间和 proof，包括注释、未知字段及损坏文件，不解析或修复偏好，不创建缺失文件。恢复仍保原字节。`ui` 目录仅白名单采集 `tui.json`、`preferences.jsonc`、`recovery.json`、仅 v4–v16 的 `caller-intents.json`、仅 v6–v16 的 `file-recovery-intents.json`、仅 v8–v16 的 `mcp-selection-intents.json`、仅 v9–v16 的 `mcp-connection-intents.json`、仅 v10–v16 的 `mcp-source-approval-intents.json`、仅 v11–v16 的 `mcp-reconnection-intents.json` 和仅 v12–v16 的 `mcp-source-mutation-intents.json`，不复制其他文件；新增偏好资产不放宽 `tui.json` 的严格格式验证。未发布基线的 closed v2 manifest 必须带独立 `tuiPreferences` 项；旧缺项清单拒绝，不猜测偏好存在或提供旧格式兼容。本入口不派发旧任务或提供在线GC。完整并发安全要求每个打开UI库的Node宿主也持同外置profile共享使用权至库关闭；该宿主生命周期与平台资格由Desktop/平台owner独立实际验证，不能仅据复制测试认定完成。

SQLite 官方 [VACUUM 说明](https://www.sqlite.org/lang_vacuum.html) 定义 `VACUUM INTO` 为一致快照，提示中断可能留下损坏候选、非整数主键 rowid 可变，并说明 synchronous FULL 的输出同步。实现仍独立验证与同步，不以命令完成代替发布证明。实际发行 SQLite/驱动版本、已知缺陷、Linux/Windows、安装包和强杀发布窗口仍需 W19/W20 资格验证；Windows Bun x64 文件端口已接入，原生验收与正式安装资格尚未取得，具体见下节。

Linux 当前 installed Terminal 的有限验证使用准确 selected Bun builtin SQLite 3.53.2：两个公共 Worker 完成 24 次并发 WAL 写，实际安装 CLI 的 backup/inspect 保源 DB 完整字节，restore 后 cold readonly 核新 Store、原业务历史、配置原字节和 Session fencing，status 无未完成 journal。维护不增加模型调用，`profileComplete:false` 保持。环境、完整安装链与原生 CI 未验范围见 [Terminal owner](../../../../apps/cli/docs/terminal-release.md#linux-当前引擎与安装维护链)；它不替代 Native 私有资产、Windows 或全部 W19/W20 资格。

SQLite 的[只读 WAL 说明](https://www.sqlite.org/wal.html#read_only_databases)允许只读连接在可写目录创建 WAL/SHM；[文件复制说明](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active)要求没有活动事务并保留配对 WAL。当前复制依赖已关闭数据库和现有排他 Profile 权，保留严格源检查；不以 immutable 忽略 WAL、原库 checkpoint、预热连接或 GC 消除变化。2026-10-05 通过公开 Artifact SH/reverify 和引擎选择，在首个 DB 前实际装载候选 SQLite 3.51.3 / `2026-03-13 10:38:09 737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618`，原两份维护文件顺序通过 9项84断言与15项264断言。真实 Core `Store.close` 和 Desktop owner 关闭后，没有重开原库预热；backup/inspect 保原完整字节及 WAL/SHM 缺失，已有 WAL 的提交事实、133份原草稿/unknown creation、17MiB媒体与取消无ready保持。精确输入与日志见[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)；未注入跨文件实体替换 barrier 或 scratch/lease 清理故障，不据此完成发行和三平台资格。

[真实引擎测试准备](../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture.ts)现由两份原文件各自在首 DB/Worker 前构建真实公开 SQLite engine leaf，复用正式 release builder 与公共 initializer核准确 version/sourceId、库字节和 selection；已有外部 selected 资产只复验，不删除。新 setup hook 有限60秒，原业务5秒/30秒预算保持；文件最后 DB/Store 关闭后才清理自有资产。它只供默认 runner 的每文件独立进程，loaded selection不能reset，不声明清理后同进程继续另一文件可用。2026-10-05无需外部preload实际两文件24项348断言通过，自有引擎均为上述3.51.3，清理确认。

独立默认进程的[Source资产验证](../../test/isolated/maintenance/mcp-source-approval-intents.test.ts)实测本机未合格默认引擎为3.51.0、下述原sourceId；public Store严格关闭后Core DB290816字节、WAL0字节、SHM32768字节都已存在。create/inspect后逐项核全部presence及已存在文件完整bytes不变，再单独验证新Store恢复原Source意图；4项70断言通过。两种引擎范围合计三个文件28项418断言，第27轮当前534文件/432唯一主任务完整默认已通过；没有通过删除副文件、预热原库或跳过断言制造absence。

2026-10-02 本机 Bun 1.4.2 的实际引擎返回 `3.51.0` / `2025-06-12 13:14:41 f0ca7bba1c5e232e5d279fad6338121ab55af0c8c68c84cdfb18ba5114dcaapl`，与 [官方 3.51.0](https://www.sqlite.org/releaselog/3_51_0.html) 的 source ID 不同，不能据版本名认定供应商分支已经包含官方修复。[官方 WAL-reset 缺陷说明](https://www.sqlite.org/wal.html#walreset) 指明多连接同时写入/checkpoint 的相关缺陷在 3.51.3 及后续版本修复；本机供应商补丁映射尚未验证。当前离线备份取得排他应用锁且不对原库写入/checkpoint，其测试通过仅证明上述范围，不能替代整体多连接 WAL 与发行引擎资格。

[隔离验证](../../test/isolated/maintenance/backup.test.ts) 在 macOS、Bun 1.4.2 使用真实 SQLite/WAL、17MiB 媒体、超过 2^53 的业务序列和未知原文；验证原文件未变、媒体完整性、第二进程占锁、其他 profile 可取得锁、缺媒体/硬链接/取消失败无 ready、restore journal 和 SQL journal 拒绝、数据库/清单/媒体篡改拒绝。测试不打开用户旧数据、凭据库或 Provider。执行：`bun test packages/agent/test/isolated/maintenance/backup.test.ts`。

同一测试还按 `root=src` 构建独立 maintenance leaf，并复制现行 `storage/migrations/0001-baseline.sql`，从源码树外 consumer 通过包名导入实际创建和检查备份。这证明源码与 bundle 下的迁移资产相对位置；临时制品不替代完整发行包、安装和平台资格。关闭及失败预检回归加入后，2026-10-02 备份、恢复、同 Store 显式 recovery/强杀及取消组合实际通过 28 项测试、306 个断言。

## Windows 维护文件端口与验收边界

同一公开 maintenance leaf 和 CLI 开发入口现接入 Windows Bun x64；备份、完整检查、新 Store 恢复、status 和显式 complete/rollback 沿原清单与 journal 合同。普通宿主共享使用权与维护排他权继续在 Profile 外的稳定 LockFileEx 文件上，不随目录移动。Windows ARM64 仍不支持；Node/Electron 的私有库、正式 Windows launcher/installer 与 Native 加载前身份门禁由各 owner 独立负责。

[files.ts](files.ts) 的私有读端口在 Node/Bun FD 生命周期内保留 [Windows 原文件与祖先 HANDLE](../platform/windows-path-security.ts)：实际 current SID、FA DACL、regular、nlink1、非 reparse 和 volume/file identity 决定准入，祖先拒绝 delete sharing，文件拒绝 write/delete sharing。关闭前重核身份、ACL、完整长度和时间；Native close 失败保留未关闭资源以便重试。读取完整资产不使用配置 scope reader 的 8MiB 上限，各资产原有 128 records/16MiB、fatal UTF-8、闭合字段及内部摘要校验仍独立执行。只读 Core/UI SQL 连接另保留同一原文件 pin 至 `Database.close(true)`；SQL 仍只打开维护 scratch 或候选，原库及其 WAL 不由 SQL 打开。

媒体采用已有的 [Windows immutable publisher](../platform/windows-artifact-files.ts)，完整 64KiB 流、EOF/hash/size 与精确 protected current-SID FR DACL 保持；仅新 temporary 可减权，既有 blob 不修 ACL。普通 metadata 仍要求 FA，不能借只读媒体政策放宽配置、journal 或锁。新媒体 writer 使用 write-through 原 HANDLE，在关闭前完成 flush 和相对 no-overwrite rename。

私有 metadata 以具有 GENERIC_WRITE 的原生文件句柄调用 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。ready、journal 和 Profile 目录切换使用 [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) 的 WRITE_THROUGH，保持 same-volume，不允许 COPY_ALLOWED 或 deferred reboot；祖先保留至移动结束，发布路径须仍对应原 source HANDLE。`syncDirectory` 在 Windows 只核私有目录，持久发布依赖上述文件和 move 屏障，没有 POSIX directory-fsync 或断电资格承诺。最后 path 核验和路径 move 仍不构成对不合作编辑器的原子 CAS；失败或未知发布保原 journal 和目录，不自动选择恢复决定。

[Windows 维护测试](../../test/isolated/maintenance/windows.test.ts) 通过实际 CLI argv 设计覆盖 backup/inspect/restore/status、17MiB 原媒体、超过8MiB完整 caller 元数据、源 DB/副文件 presence 与 bytes、busy、原 Store fencing、旧目录与凭据排除、准确 journal digest 的 complete/rollback。它使用开发 CLI 和自有 selected engine，journal 中断来自内部确定性窗口，不冒称 installed、Native UI 或 SIGKILL 全矩阵。与 [原生 pin 测试](../../test/isolated/windows-path-security/default.test.ts) 一起仅按平台 skip；在 Windows 不因 backend/engine 不可用跳过。本机 macOS 的运行结果只证明 POSIX 行为与惰性 import，Windows 案例未执行。当前取舍和剩余验收见[维护提案](../../../../.agents/notes/proposed/architecture/2026-10-07-windows-maintenance-file-publication.md)。

## 显式恢复与 journal

[restore.ts](restore.ts) 的 `restoreProfileBackup({profile,expectedStoreId,backup:{directory,manifest},intent:'replace_with_selected_backup'})` 绑定当前观察的 Store、完整已选备份清单和明确数据回退意图。预检不初始化缺失目标 profile。完整备份重新验证后，整个候选准备、切换、校验与 journal 完成都持有同一个外置 profile-use 排他锁。当前目录保留为独立 `.preserved-<restoreId>`，候选置于 `.restore-<restoreId>`；任何失败不会先删除原数据。

候选生成新 Store ID，并将 replayFloor 移到其现有最后 cursor，所有旧 expectedStoreId 写入失效。旧 accepted Command 改为 needs_review；活动 Run 中断并清除 is_active；旧 planned/dispatching/running Execution 保守标为 outcome_unknown；pending interaction 取消。已完成 receipt、原业务 ID、来源 Store 和 namespace 原文保持不变，owner 解除并增加 generation。原副本 planned 不证明外部效果从未派发，不能改为未执行成功。旧来源 Execution 不取得新 Store 执行资格；当前 Store 的 outcome_unknown 仍阻止取得新 owner。

owner 门禁只在 root `session.create` 来源与当前 Store 不同的准确恢复根范围内，将旧来源 Execution 作为只读历史；这不构成一般 cross-Store 豁免。普通同 Store 创建的根经显式 recovery 后，跨来源 outcome_unknown 仍阻止 owner；恢复后的新 Store Execution 产生 unknown 也仍阻止 owner。三种情况均有独立断言。

维护 journal 只有 `prepared → old_moved → published → verified` 四个持久步骤，不是运行期执行状态机。它记录原/new Store、稳定 profileAccessKey、选定备份清单、准确生成目录名以及原目录/候选全内容和权限摘要。每步写入、改名与父目录均同步。普通 `openSqliteStore` 见 journal 拒绝打开或初始化；维护专用取得函数只用于同一外部锁内核实它。

`inspectProfileRestore({profile})` 只读返回 `{journal,digest}`。显式 `reconcileProfileRestore({profile,restoreId,expectedJournalDigest,decision:'complete'|'rollback'})` 重新取得同一个排他锁，必须匹配调用者所观察 ID/摘要，再核对完整目录摘要和数据库 Store。仅接受原目录未移出、原目录已保留/候选未发布、或候选已发布这三种准确组合，不能仅凭目录存在推测；未知内容保持 journal 和拒开状态。complete 发布并验证选定新 Store；rollback 将准确旧目录换回，并保留未采用候选。原目录和候选都不会被无条件删除。

[恢复验证](../../test/isolated/maintenance/restore.test.ts) 实际使用第二进程和 SIGKILL 覆盖 prepared、新目录身份提交后、旧目录移出后及 journal 更新前后、候选发布后及 journal 更新前后、最终 verified 之后，以及 journal 删除完成后仍持锁的窗口。锁持有时普通入口 busy；未完成 journal 的窗口强杀后拒开且不创建空 profile；journal 已完成窗口强杀后冷打开取得完整新 Store。其他 profile 仍可取得锁。测试还验证旧来源与缺 key 不重做、同 Store unknown 门禁保留、明确新工作成功，以及备份后真实 Tool 写外置计数一次，恢复后旧 Store 重试不增加计数或 Model。这里的成功不完成平台、引擎补丁、安装包、真实用户恢复或整个 R01/R07/W19 资格。

restore候选现在发布DB、引用媒体以及备份明确存在的原config/UI资产；原当前目录整体仍保留。资产完整hash及UI格式先验证，候选全目录digest包含它们，最终切换仍沿原journal。不改UI draft.store_id、原scope/草稿ID或creation.input.expectedStoreId/commandId/phase；冷读保原身份，不自动重放creation。旧Store草稿关联由Native原ID读取/明确unavailable处理，不能改标成新Store。未采集的私有文件与凭据仍不出现在新profile，GC和engine/平台资格未完成。

[资产验证](../../test/isolated/maintenance/assets.test.ts) 使用实际Node/Desktop私有库owner与真实外置共享lease，采集133条草稿和unknown creation，恢复新Store后冷Node读取得相同原scope/创建身份；包含raw坏JSONC/敏感fixture字节、完整proof、缺失/篡改/额外文件、坏UI schema/app/version/物理格式/journal、链接/权限与取消失败无ready。七个SIGKILL窗口现携config/Desktop UI/TUI原草稿与preferences原始字节；complete取备份133条/原配置/原偏好，rollback取后续134条/后续配置/后续偏好。CLI维护测试也从源码树外built包实际恢复这些资产。此验证不访问用户vault或付费Provider；媒体原字节和旧origin仍需Root的公共Artifact/Model端口联验，不能代替其他调用者证据。

Store Worker 在发送 close 回执前调用 `Database.close(true)`，完成 prepared statements 与 SQLite handle 的释放，之后才释放外部锁；默认 close(false) 可延迟底层连接释放到 GC。该取舍遵循 [Bun SQLite 关闭说明](https://bun.com/docs/runtime/sqlite#close-throwonerror-boolean-false)，不能用 Worker terminate/close 事件或 sleep 代替数据库资源已关闭的证明。多种导出查询后立即关闭再备份的实际回归核对原 DB/WAL 字节保持不变。

`openDatabase` 失败、只读 preflight 与 baseline 临时库也使用严格 close，保证错误返回/维护锁交接之前不遗留 SQLite 连接。失败预检后恢复 supported fixture 字节并立即创建备份的回归保持实际文件断言。旧 SIGKILL Model fixture 因缺 Artifact publisher 无法到达 readiness 的失败独立修复：现在用真实原 scope ArtifactStore 发布，核对 4096 preview 和完整 68KiB 原正文、hash、incomplete 与原执行身份；没有降低原全文或强杀门槛。

TUI 采集、inspect 和 restore 均拒绝坏格式、缺失/篡改、额外备份 UI 文件、软/硬链接及非私有父目录。TUI 文本的16MiB文件/4096记录边界失败保字节，没有静默淘汰或截断。恢复新 Store 后保留旧草稿原身份，仅由客户端显式只读目录访问；当前 Store 输入不会自动加载旧 Store 草稿。草稿编辑、共享profile lease与短写锁的生命周期由 [CLI owner](../../../../apps/cli/README.md) 负责。

Native 与 CLI/TUI 的未决恢复意图属于明确 UI 资产。[assets.ts](assets.ts) 对 `ui/recovery.json` 采用独立的有限 v1 验证：262144 UTF-8 字节、最多128条 `{intent,phase}`，全部层封闭字段，公开 run/interrupt/report 请求准确 shape、命令 ID 唯一、原 Store/Session/Run/report/Command 不重标；未知格式、authority extras、重复或超限拒绝，不作为空 journal。采集前及副本后均验证，manifest v3 的 `tuiRecovery` 记录真实存在、完整摘要与 `{version:1}`；缺失不创建。Desktop v2 journal 随准确 SQLite 一致副本保存，manifest 的 userVersion 与副本实际版本必须相同，不能以声明替代实际格式；恢复行逐条校验有限身份/phase与128未决上限。Agent 维护代码不依赖 Desktop/CLI/UI workspace。

这些 journal 只是调用者请求身份，不是 Service receipt 或恢复授权；恢复到新 Store 仍保存旧 scope，仅显式查询原 ID，不重发恢复、重新命名或自动接纳旧命令。真实 Node fixture 从 Desktop owner 创建 v2 pending journal，TUI fixture 从 CLI owner 写原 pending journal；原强杀 complete/rollback 同时携原与后续 journal，核对正确记录集合与旧 Store。旧 v2/准确 Desktop v1 的备份保持可检查，新 v3 不能把任意 UI 文件、SQL 表或其他 schema 纳入资产白名单。

## 普通 caller 请求的离线字节资产

CLI/TUI v1 文件的 [caller-intents.ts](caller-intents.ts) 是维护私有结构验证器，仅使用 Node 与 Agent 自身端口，无 Client/CLI/UI workspace 依赖。它核对完整 fatal UTF-8、closed v1 文档与 intent/scope/request/target/draft 字段、既有五种公开 Start/Steer/FollowUp/CancelCommand/CancelExecution 请求结构、全局原 commandId 唯一、128 records/16MiB 既有 caller 边界，以及准确原 Store/Workspace/Session、subject、目标与 Decimal64 draft revision。模型选择、skills、extensionInputs 使用当前公开 DTO 原有限字段约束，input 完整 JSON 不另加 count/depth/工作正文配额。

源与副本均必须实际私有 0600、当前 UID、regular、nlink1、非 symlink；父目录私有，缺实际 O_NOFOLLOW 支持拒绝。打开 FD 前后核对 inode/size/ctime/owner/mode，采集/inspect/restore 再验证完整文件 proof。恢复保留原请求、Plan extension input、正文 Unicode/换行、scope/subject/目标、两种原摘要、phase、draft 与原字节，不换成新 Store，也不发 POST。既有五类请求的 bodyDigest/requestDigest 只按 lowercase SHA-256 元数据结构保存，不重算或改写，不把它们当 Core receipt、查询许可或权限；调用者冷 lookup 仍独立核原命令/subject/requestDigest。

含Auth的v13另接闭合 `builtin.mcp.sources` 四固定 `mcp.auth.login/refresh/clear/revoke@1`，input恰serverId/full expectedReadSet，target与原request一致且不得带draft。此分支实际重算完整request的bodyDigest，以及只排除expectedStoreId/commandId后的canonical requestDigest；错误摘要拒绝，原字节仍不改写。旧manifest v2–v12继续仅接其原五类Caller grammar，不由v13放宽。

[caller-intents.test.ts](../../test/isolated/maintenance/caller-intents.test.ts) 用 owned 临时 SQLite/profile 验证超过300KiB的真实完整请求字节、新 Store 恢复的原身份、128条/10MiB完整 JSON、重复/非法结构/超额、软硬链接/权限/no-follow、matching hash 的损坏结构不发布，以及旧 v2/v3 配置和 UI 偏好字节恢复。测试不执行原请求、不访问用户 profile/vault/Provider；CLI 实际强杀和调用者 journal 生命周期由 CLI/UI owner 独立验证，本维护证据不替代其资格。执行：`bun test packages/agent/test/isolated/maintenance/caller-intents.test.ts`。


Desktop DB3 的 [desktop-callers.ts](desktop-callers.ts) 另核真实只读 SQLite 行。准确 application_id 为 1263888689，除原 drafts/creations/recovery_intents 外仅接纳 `CREATE TABLE caller_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)`，不凭 manifest 声明猜 schema。每行核原 SQL PK 等于 request.commandId、closed 五类 DTO/target/scope/subject/phase/draft、128 行和原 state UTF8 文本聚合16MiB。用实际 BLOB hex 核 UTF8 字节未被替换解码，非法字节拒绝；完整 bodyDigest 重算全部 request，requestDigest 仅排除 expectedStoreId/commandId 后按 canonical JSON 递归排序对象键并重算 SHA-256，文本 Unicode/CRLF 和数组顺序不改写。CLI/TUI 文件的既有元数据保存边界与此 DB3 内部证明检查分别保留。外层副本 proof 重新计算也不能掩盖内部坏 hash、scope、phase 或正文；失败不发布 ready/restore、不修改来源 Store 或驱逐原行。

这些本地结构与摘要证明不成为 Service receipt、查询授权或首次 POST 权。恢复生成新 Store 时，完整原 caller 请求、单次 Plan、draft identity/revision/hash、subject 与旧 Store/Workspace/Session 都原样保留；维护不发送原请求、不重标。`coverage.profileComplete:false`、凭据/vault 排除及跨配置/Core/UI 采集非瞬时原子的边界保持。DB1/2 旧 reader 与 manifest v2/v3/v4 的物理白名单不扩大，未知 SQL 表或格式仍拒绝。

[真实 Node caller 维护资格](../../test/isolated/maintenance/desktop-callers.test.ts)使用 Desktop owner 的实际 PrivateData 与 Node SQLite 保存五种完整请求、Plan/draft 和超过 300KiB UTF8/CRLF 字节，备份/新 Store 恢复后冷读原 scope；逐项验证坏 PK/两种 hash/scope/phase/target/draft/authority、非法 UTF8、128 行及 16MiB 超限、重算外层 proof 不能发布坏候选。历史 qualification fixture 明确保留 DB5/v7；当前 owner 关闭并取得排他 profile 权后，先确认 DB7 的 MCP 表与 DB6 的两张新增表均为空，再物理移除并标 DB5。测试另实际去掉新表得到 DB3/v5，再去掉 caller 表得到 DB2/v3/v4，准确核旧格式仍可读取，未放宽旧 manifest。2026-10-03 当时 DB3 的 5 项 60 条断言和完整维护 5 文件 47 项 605 条断言属于旧源窗口；当前六文件组合证据见下文。此证据只覆盖离线资产，不代替 Native 普通 caller 的实际窗口、正式安装、Linux/Windows、发行引擎或整个 W19/W20 资格。

## 文件恢复请求的独立离线资产

[file-recovery-intents.ts](file-recovery-intents.ts) 只依赖 Agent 自身与 Node 端口，核 CLI/TUI 的 closed v1 `{version,records}` 和 Desktop DB4 的实际 `CREATE TABLE file_recovery_intents(intent_id TEXT PRIMARY KEY,state TEXT NOT NULL)`。准确 DB4 同时保留原 drafts/creations/recovery_intents/caller_intents 四表，不接纳额外表或相似 schema。每条完整请求保原 point 的 Store/Session/Workspace/Run/selector、物理 root、当前观察的 Store/Session/Workspace/subject/selector、后端证明的 current boundary/trigger、适用的原 Code/Fork 请求与两条 phase。SQL PK 等于首 leg 原 commandId；所有记录的 Code/Fork commandId 全局唯一，最多 128 条、文件或 DB state 合计 16MiB UTF8，不静默删除 unknown 或淘汰旧记录。

维护核全部层的准确字段集合、Decimal64、canonical device/inode、scope 与 leg 对应关系、both 第二步开始必须 Code 已成功，以及原两请求的 canonical Core SHA-256。Code 摘要按实际 `extension.invoke` 的 `actionId`；Fork 按 `session.create` 的原 `fork.sourceSessionId/expectedContextSelectionId/boundary`，不能只移除 HTTP request 外层 IDs。对象键逐项核 membership 和数量，不能用拼接字符串比较。完整 UTF8、Unicode 标题、CRLF、数组顺序和原 state 字节保存；DB 用实际 BLOB hex 拒绝替换解码。文件要求 0600、当前 UID、regular、nlink1、no-follow，并在打开 FD 前后核身份、长度、时间和权限；源与副本、inspect 与 restore 都独立复验完整 proof。

这些本地结构和 digest 不成为 Service receipt、Code 当前成功证明或 POST 许可。备份和恢复不会序列化热 permit、答人类 Ask、执行旧请求、换 IDs 或把 A 请求改成 B。新 Store 下冷读只保留原 scope 与部分已知状态；继续执行由客户端重新核当前身份、原命令/实际 carrier 和必要的当前文件预览。该资产不扩大 `coverage.profileComplete:false`、vault 排除或原 UI 格式白名单。

[file-recovery-intents.test.ts](../../test/isolated/maintenance/file-recovery-intents.test.ts) 的真实临时 Profile 验证三种范围、原父 point 与 current aliases、Code succeeded/Fork unknown、canonical SHA、闭合字段、坏 phase/branch/authority、跨行 command 碰撞、链接/权限，以及 matching 外层 proof 仍无法隐藏坏内部结构。真实 Node owner 创建 DB4，备份并恢复新 Store 后冷读原 state 与实际 CRLF 字节；Node 的 fetch/http/https 请求入口计数并拒绝网络，结果为零 HTTP。2026-10-04 macOS/Bun 1.4.2 定向 4 项 67 条断言；当前完整六文件维护组合为 51 项 677 条断言、零失败，包括既有实际 SIGKILL journal 窗口。此处不替代 CLI/TUI/Native 的实际丢回复、强杀和窗口资格。

取舍见[原边界与独立意图资产](../../../../.agents/notes/implemented/architecture/2026-10-04-file-recovery-boundary-and-intent-assets.md)；完整客户端实施状态仍由[完整恢复设计](../../../../.agents/notes/implemented/architecture/2026-10-03-sealed-readonly-fork-sources-and-file-restore.md)和对应 owner 维护。


## 原人类答案请求的独立离线资产

Desktop DB5 的 [desktop-answers.ts](desktop-answers.ts) 独立核准确 `answer_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)`，必须与原 DB4 五表共同存在；manifest v7 接纳 DB5，旧 v2–v6 的准确字段、格式和物理白名单不扩大。没有新增独立 UI 文件，也不创建缺失 journal。Agent 维护代码只依赖自身与 Node/Bun SQLite，不引用 Desktop/Client/CLI workspace。

每行核完整 closed scope/subject/interaction/request/phase，原 SQL PK 等于 request.commandId，原 Store 与 expectedStoreId、revision 一致，三个答案种类的准确请求字段、全记录 commandId 与 Store/Interaction/revision 唯一。实际 BLOB hex 对照 UTF8 原字节，单记录 JSON 4MiB、整个表最多128行/16MiB；unknown 不静默删除。完整请求 bodyDigest 与准确 interaction.answer Core requestDigest 重新计算，observationDigest/subject 仅保存既有身份元数据，不能推导 Service receipt、查询许可或首次 POST 权。

原 answer 表随同一私有 SQLite 的 VACUUM INTO 一致副本保存；source DB/WAL、snapshot proof、inspect 和 restore 独立核验。恢复生成新 Core Store，但 UI 的旧 Store、Session、Workspace、Interaction、Execution、Run、Command、subject、两种请求摘要、完整答案 Unicode/CRLF 与 phase 均保持。维护不执行答案、不重标身份、不恢复热 authority，不接触 Provider/vault。

[真实 Node answer 资产测试](../../test/isolated/maintenance/desktop-answers.test.ts)由 [独立 fixture](../../test/isolated/maintenance/desktop-answer-assets-fixture.ts) 调用当前 Desktop PrivateData owner 写三种 unknown 答案，再用上述空新增表守卫明确保留历史 DB5，包含312022字节原 Unicode/CRLF正文。备份 v7、新 Store 恢复与冷 Node 读取核 SQL state 原字节、完整 SQLite hash、原 IDs/subject/digests 和零 HTTP；坏 PK/摘要/phase/authority、重复 target、非法 UTF8、行/字节超额、非私有源、未来格式/字段、伪旧 manifest 与重算外层 proof 的坏候选均拒绝。此证据只覆盖 owned 临时离线资产；实际 Windows Node 后端、正式窗口、发行引擎与完整平台资格仍由相应 owner 单独核对。


## MCP 选择意图的独立离线资产

[mcp-selection-intents.ts](mcp-selection-intents.ts)独立验证固定 `ui/mcp-selection-intents.json@1`，不导入 CLI、UI 或 Client workspace。closed manifest v8 仅新增准确 `mcpSelectionIntents:{path,present,capturedAt,proof,format}`，present 的格式是 `{version:1}`，absent 的 proof/format 是 null；同时携原 v7 全部准确资产项并接纳原 Desktop DB1–5。旧 v2–v7 的字段、SQL 格式和物理白名单不扩大；新文件、字段或格式不能通过重标旧版本混入备份。没有新文件时沿原 v5/v6/v7 创建规则，不创建替代 journal。

文档严格是 `{version:1,records}`，最多128条、原文件最多16MiB；所有 phase 均计入，unknown 不删除。每条闭合原 Session/Workspace/workspaceIdentity、expectedStoreId/commandId、subjectId、固定 `extension.invoke / builtin.mcp.management / mcp.server.select / 1` 请求、serverId/enabled/user或workspace范围、六字段原 readSet、bodySha256/requestSha256 和有限 phase。完整 request 与去掉 commandId/expectedStoreId 的公开 request 分别独立重算 SHA，commandId 全文件唯一。scopeDigest 和主体元数据只验证格式并保留，不能重新推导原 Workspace、receipt 或 POST 权。

资产沿原私有目录、当前主体、单硬链接、no-follow 与原实体指纹合同，以 fatal UTF-8 校验原文件、复制候选和 inspect；恢复复制原 JSON 整字节，不重新排列、重绑新 Store 或恢复热 authority。v8 的 ui 物理白名单只增加这一准确显式 present 文件，额外文件拒绝。未知 manifest/document/format/字段、坏内部 SHA 即使外层 proof 重算也拒绝，失败不改来源、不发布 ready 或恢复 journal。

[验证](../../test/isolated/maintenance/mcp-selection-intents.test.ts)通过真实 CLI journal owner 和实际 Profile/data locks 写入原 user终结/workspace unknown元数据，随后备份 v8 与 DB5、恢复新 Core Store、源外实际 Node 使用原纯 codec 冷读；原 bytes/subject/IDs/readSet/两 SHA/phase保持，冷 reader 在任何 GET 前挡 foreign scope，GET/POST均零。128条独立 Workspace unknown 和准确16MiB原 JSON完整保留，129条/超额/非法UTF8/未来格式/权限/链接/坏内部数据拒绝。此 Node fixture 只证明离线原资产与 cold scope拒绝，不是 TuiMcpPort 完整 receipt lookup、配置效果已保存或 UI/Windows资格；完整冷 Host 由 CLI owner 单独验证。

## MCP 连接申请的独立离线资产

[mcp-connection-intents.ts](mcp-connection-intents.ts)只验证固定 `ui/mcp-connection-intents.json@1`，不引用 CLI、UI 或 Client。closed manifest v9 携原 v8 全部准确资产项，另增加 `mcpConnectionIntents:{path,present,capturedAt,proof,format}`；新文件实际存在时才创建 v9，否则沿原 v8/v7/v6/v5 选择规则。不创建缺失 journal。旧 v2–v8 字段、格式和物理白名单保持，额外连接文件不能通过改旧版本或重算 outer proof 混入。

每条记录闭合原 Session/Workspace/workspaceIdentity、subjectId、完整 `extension.invoke / builtin.mcp / mcp.connect / 1` request、bodySha256/requestSha256 和 submitting/pending/ready/failed/outcome_unknown。input只有安全serverId与1–64字符ASCII key。完整body SHA和去掉expectedStoreId/commandId的Core request SHA独立重算；全文件Command ID唯一，128条/16MiB，unknown不淘汰。私有owner/mode、no-follow/单硬链、打开前后实体、fatal UTF-8和内部proof分别核验。

采集、inspect和restore保持原JSON整字节、Store/Command/subject/两个摘要及phase；新Store不重标旧身份、不恢复热prepare或POST权，不执行连接或读取凭据。[公共维护测试](../../test/isolated/maintenance/mcp-connection-intents.test.ts)4项37断言通过，实际v9 create/inspect/restore保原1623字节A→B；坏内部摘要/混合Action/重复/超限/UTF-8/链接/公开权限、v8新增资产与重算outer proof的坏v9均拒绝。该离线字节资格不单独证明实际Host跨Store拒绝；实际Host核验归[CLI owner](../../../../apps/cli/README.md#tui-mcp-显式连接与原申请)。

## MCP 来源决定申请的独立离线资产

[Source intent codec](mcp-source-approval-intents.ts)独立验证准确`ui/mcp-source-approval-intents.json@1`，不依赖CLI/UI/Client。资产实际present才创建closed manifest v10，携完整v9旧项并增加mcpSourceApprovalIntents:{path,present,capturedAt,proof,format}；absent不造journal，旧v2–v9的字段/格式/物理白名单保持。新资产不能通过重标v9或重算outer proof混入；profileComplete仍false，不采集source/approval/credential文件。

记录闭合完整原intent/subject/bodySha256/requestSha256/phase；intent含原Session/Workspace/full identity与准确extension.invoke/builtin.mcp.sources/mcp.source.approve/1 request，input只有mcp-64hex serverId和六字段Source readSet，各文件identity/etag/error保持。error沿string|null，无新增字段长度规则；完整request与去Store/Command的Core request分别重算SHA，Command ID全文件唯一。128条/16MiB/fatal UTF-8/private owner/mode/no-follow/single-link/held stat适用于原文件、复制候选与inspect；submitting/pending/saved/failed/cancelled/unknown都原样保留，不淘汰未知、不恢复hot prepare权。

[真实维护测试](../../test/isolated/maintenance/mcp-source-approval-intents.test.ts)当前4项70断言通过，包含上文默认原Core DB/WAL/SHM的完整presence和bytes守卫；此前4/58与十维护文件邻接67/945属于旧窗口。public create/inspect/restore v10 A→B保6221原字节、原IDs/subject/scope/SHA/phase，v9 outer重算仍拒新文件，坏body/hash/duplicate/UTF-8/permission/link/128/16MiB分别拒绝。恢复只复制原caller元数据，不retag新Store、不POST/执行Source审批或查vault。实际当前B `TuiMcpSourceApprovalPort`在任何HTTP前拒绝A意图、原cursor/bytes不变由[CLI owner](../../../../apps/cli/README.md#tui-mcp-项目来源决定与原申请)独立实际验证；这份离线资产测试不替代UI、异常收尾或Windows资格。

## MCP 重连申请的独立离线资产

[Agent独立codec](mcp-reconnection-intents.ts)闭合验证准确 `ui/mcp-reconnection-intents.json@1`，不依赖CLI/UI/Client。仅资产实际present时创建closed backup v11，携完整v10旧项并增加准确mcpReconnectionIntents元数据；absent不造journal，旧v2–v10字段、格式与物理白名单保持。重标v10或重算outer proof不能接纳新资产，profileComplete仍false。

closed document最多128条/16MiB，记录保完整原S/W/physical identity、本次reconnect request与准确前一C/R的flat targetRequest、subject、两种SHA及phase；原ref恰六字段、closed Source/static replacement与完整read-set分别验证。完整body与Core request摘要重算，unknown不淘汰；私有owner/mode、no-follow/单硬链、held实体、fatal UTF8与inner proof分别核验。

[公共维护测试](../../test/isolated/maintenance/mcp-reconnection-intents.test.ts)实际4项114断言核v11 create/inspect/restore、旧v10 outer重算拒绝、坏closed输入/摘要/UTF8/容量/权限/链接，以及A→B完整原bytes保持。恢复不retag、不执行申请、不恢复热ticket或POST权；[实际foreign Host](../../../../apps/cli/test/isolated/tui-mcp-reconnection-restore.test.ts)进一步核原list/lookup/duplicate/observe全部HTTP0。此资格沿owned临时离线范围，不声明完整Profile、Windows维护或OSvault。

## MCP 来源条目变更申请的独立离线资产

[Agent 独立 codec](mcp-source-mutation-intents.ts)验证准确 `ui/mcp-source-mutation-intents.json@1`，仅依赖 Agent 自身与 Node 端口。closed v12 manifest 含完整 v11 字段和 `mcpSourceMutationIntents:{path,present,capturedAt,proof,format}`；present 时 format 为 `{version:1}`，absent 时 proof/format 为 null。不造缺失文件；旧 v2–v11 的准确字段、SQL 格式与物理白名单保持，重标 v11 或重算 outer proof 均不能加入新资产。

文档闭合 `{version:1,records}`，每条完整 intent/subjectId/bodySha256/requestSha256/phase。intent 包含原 Session/Workspace/physical identity 和固定 `extension.invoke / builtin.mcp.sources / mcp.source.add|mcp.source.remove / 1` 请求；basic entry、六字段 Source read-set、移除的 serverId/raw digest 与 CLI codec 使用同一有限 grammar。完整 body 及去 Store/Command 的公开 canonical request 分别重算 SHA；全文件 Command 唯一，128 条/16MiB，unknown 不驱逐。fatal UTF-8、private owner/mode、no-follow/单硬链及 held FD 实体前后复验适用于源、候选、inspect 与 restore。

[公共维护测试](../../test/isolated/maintenance/mcp-source-mutation-intents.test.ts)实际 4 项99断言验证 create/inspect/restore v12、准确 absent metadata、旧版本 outer 重算仍拒新字段/文件、坏输入/摘要/UTF-8/容量/权限/链接。A→B 保原 8729 字节与完整 SHA、Store/Command/Session/Workspace/subject/request/phase；Session 的业务字段保持，恢复 owner generation 按既有新 Store 合同递增。恢复只复制 caller 字节，不改标原身份、执行申请或恢复热 POST 权，profileComplete 仍 false，Source 文件和 Vault 未由此资产采集。

源码外真实 B 终端明确选原申请并查询时，全部原 HTTP 在发送前被拒绝，原 bytes 与 cursor 保持，由[CLI owner](../../../../apps/cli/README.md#tui-mcp-来源条目增删与原申请)及[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)记录。维护资产的正常本机收尾不代替全部异常清理、发行引擎、Windows 或完整 Profile 资格。

## 既有 Caller 资产中的认证申请

[caller-intents.ts](caller-intents.ts) 在 fixed-auth 语法下只接四个 `builtin.mcp.sources` Auth invoke，definitionVersion 为1，input恰serverId与完整source read-set；原五类 Caller 继续各自闭合。body/request digest、原Store/subject/Session/target与phase按原资产校验，热首次POST许可不进入备份。只在实际含Auth的同一 caller 文件时优先v13；旧manifest/v2–v12与Desktop旧请求语法即使重算外层proof也不能藏入Auth。

恢复生成新Store后保完整原bytes/IDs/subject/SHA/phase，不重标、执行或授予POST/批准/Vault权限。当前 [资产测试](../../test/isolated/maintenance/caller-intents.test.ts) 与 [CLI契约](../../../../apps/cli/test/isolated/caller-auth-contract.test.ts)验证实际A→B和HTTP前Store/subject拒绝；维护不复制owned凭据。当前协议与客户端分别由[认证active](../../../../docs/active/mcp-authentication.md)和[CLI owner](../../../../apps/cli/README.md)维护。


## Desktop DB6 与 manifest v14

[assets.ts](assets.ts)核 application_id 1263888689 与 DB6 原六表加准确 configuration_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)、model_routes(store_id TEXT NOT NULL,session_id TEXT NOT NULL,model_id TEXT NOT NULL,PRIMARY KEY(store_id,session_id))。[独立 codec](desktop-configurations.ts)只依赖 Agent/Node/Bun：逐行核原 UTF8、PK、128行/16MiB、全部闭合 input/state/readSet/operation、明确字符串 enum、原 command/store/observation 与 pending phase；禁止 secret/opaqueRef/路径 authority/配置 effort。route 只含有效 Store/Session/model ID，不承载执行权。未知或坏行拒绝发布，原字节不清理。

DB6 的[caller reader](desktop-callers.ts)独立重算完整 body/request SHA，允许原 run.start/follow-up 的七值字符串 reasoningEffort；steer 和其他 kind 不接受。此词汇只对真实 DB6 开放，DB1–5 及 CLI/TUI 独立 caller 文件仍用原 grammar。v14 仍精确验证 v13 的其他资产、条件 Auth codec、物理白名单与 absent metadata；不创建缺失 journal，不读 vault、不发送请求。

备份和恢复随同私有 SQLite 保存原配置查询元数据、Session 模型偏好与完整 caller 请求。新 Core Store 不重标原 Store/Session/command/readSet，不把旧配置行当热 POST 权，临时页面档位不额外写入 route。[历史 Node DB6 验证](../../test/isolated/maintenance/desktop-configurations.test.ts)通过当前 Desktop owner 写入，在 owner 关闭并取得排他 profile 权后，仅移除确认为空的 DB7 MCP 表，得到真实 DB6 物理格式；再沿公共 create/inspect/restore、新 Store 冷读核原字段与完整 high/minimal 请求、HTTP零，以及秘密/错误 enum 类型、重算内部SHA的数组effort、坏UTF8/route、旧manifest伪装拒绝。历史 DB5/6 tests 用[明确空表守卫](../../test/isolated/maintenance/assets-fixture.ts)，不丢弃有内容的新表；完整当前 DB7 维护测试见下一节。资格限本机离线私有资产，不代 Native在线回执、付费模型或其他平台验收。


## Desktop DB7 与 manifest v15

Desktop Native MCP 的原请求现在是私有 DB7 的独立 `mcp_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)` 资产；DB7 完整保留 DB6 八表并新增此表。没有 raw MCP 配置资产时，真实 present DB7 创建 closed manifest v15，携 v14 全部准确字段与资产白名单，不能重标为 v2–v14；旧清单与 DB1–6 的准入不变。维护独立 [desktop-mcp.ts](desktop-mcp.ts) codec，Agent 不导入 Client 或 Desktop runtime。

每条 state 精确为 `{version:1,sessionId,workspaceId,workspaceIdentity,subjectId,request,targetRequest,bodySha256,requestSha256,phase}`。身份为闭合 opaque ID，workspaceIdentity 与摘要为 SHA-256；phase 仅 `submitting|pending|completed|failed|cancelled|outcome_unknown`。完整 request 保留原 Store 与 Command，仅接纳十二类闭合 MCP 动作：选择、连接、目录刷新、重连、来源批准、凭据绑定、来源增加/删除及四类 Auth。bodySha256 对完整请求 canonical JSON，requestSha256 仅排除 expectedStoreId/commandId；对象递归排序，数组顺序保留。targetRequest 仅重连存在，保存先前连接或重连请求；核原 Store、Session、Server 与 carrierKey，禁止嵌套历史；先前 carrier Command 不要求等于初始 operationRef Command。

DB7 维护核 SQL PK、精确字段、类型、枚举、摘要、重复 Command、最多 128 行/16MiB，以及原 SQL TEXT 的 BLOB hex 与 UTF8 全字节一致性。未知状态、损坏字节或秘密字段拒绝整份备份，不删除或修复。创建、检查与恢复核同一 grammar 并保原 state 字节；恢复后的旧 Store 请求只供冷读事实，不构成当前 Service receipt、POST 权限或自动重放。历史 Node fixture 仅在 owner 关闭、取得排他 profile 权且新表确认为空后物理降版，不删除真实新资产。独立 [DB7 验证](../../test/isolated/maintenance/desktop-mcp.test.ts) 覆盖十二动作、原请求与前 carrier、损坏枚举/secret/UTF8，以及实际 Node DB7 的 v15 backup/inspect/新 Store restore。


## Profile MCP 配置资产与 manifest v16

三个 Profile 文件各为独立 raw 资产：`mcpConfiguration` 对应 `mcp.json`，`mcpApprovals` 对应 `mcp-approvals.json`，`mcpAuthBindings` 对应 `mcp-auth-bindings.json`。至少一项实际 present 才创建 v16，全部三项必须携准确 path／present／capturedAt／proof，不含内部 format；absent 的 proof 为 null且不创建文件。v16 继承 v15 全部既有资产字段和各自严格 codec，允许无 Desktop 或准确 DB1–7。旧 v14／v15 仍分别要求实际 DB6／DB7，旧 v2–v15 不能以重标版本、重算 outer proof 或仅添加物理文件接纳三个新资产。

采集、inspect 与 restore 复用原 private owner／0600／no-follow／单硬链／held entity 和完整 SHA／Decimal64 bytes 守卫。raw bytes 包括 BOM、CRLF、注释、unknown、opaque refs和坏 JSONC／UTF8，维护不解析、修补或重写；实际消费时仍由配置 parser 拒绝原损坏内容。每个文件单独采集，不承诺三个文件或 Core／UI 同一原子瞬间。`configurationMayContainSensitiveContent:true` 保持，raw source 中既有 inline secrets 可能随原文备份，Vault 正文、项目 `.kite-code/mcp.json`、协调与锁均不采集。当前目录仍由恢复 journal 整体保留。

恢复生成新 Store 且替换 physical Profile，原 source／decision／credential-ref 文本和 Core Question／Command／Execution 的出处保持。现有[来源 leaf](../config/README.md#private-mcp-sources-and-approval-metadata)核当前完整 binding scope：无认证用户来源沿原信任规则可用；旧项目决定和 credential binding 在新 Store 中不匹配，必须经过当前普通 Action及真实 Question 才准入。旧决定不删除或 retag，新记录追加并保持原记录。元数据读取不查 Vault presence，不连接、不调用 Model、不恢复热 POST 权。当前 Interaction 列表仍按当前 origin Store 过滤，不能从旧 Question 留存推导它已成为当前待决卡；完整原记录保存在恢复 Core 内。

[raw 资产测试](../../test/isolated/maintenance/mcp-configuration.test.ts)以实际 selected SQLite 和公开维护 API 核全文、部分 presence、旧格式／实体拒绝、proof／坏 metadata、private 文件和取消无 ready，Core DB/WAL/SHM 原存在状态及完整 bytes 保持。[实际 Node DB7](../../test/isolated/maintenance/desktop-mcp.test.ts)保原 v15 恢复，再核带 raw source 的 v16 第二次新 Store恢复、16MiB完整原 MCP state与 cold owner。CLI 的[源码外离线 argv](../../../../apps/cli/test/isolated/maintenance.test.ts)另核 DB5与三 raw 文件，不依赖运行 Service。

[源码外正式安装链](../../../../tests/isolated/unified-agent/profile-mcp-restore.test.ts)使用原 Terminal builder、完整 installed CLI和默认 Service，删除原 candidate 后实际 backup／inspect／restore A→B。三次 Service 启动核原批准／绑定 Question、当前目录信任、旧 C/E/Question及原完整配置、冷 GET 游标保持、拒旧写身份、两份真实新 Question、新记录追加和显式 stdio initialize/tools-list；准确 server／guardian／Service 退出后再 cold 读取不重启连接，卸载保 Profile。手工 credential 只验证 opaque ref与 binding，未派发 credential transport 或读取用户 Vault；实际 OAuth／OS Vault、其他平台和完整 W19资格仍按各 owner核验。准确有限／完整默认证据归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07profile-mcp-配置备份恢复)，取舍见[配置资产决定](../../../../.agents/notes/implemented/architecture/2026-10-07-profile-mcp-configuration-assets.md)。
