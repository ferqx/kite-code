# Shell 文件交付

`output-collection.ts` 装饰已有 `builtin.files` namespace，增加宿主短 Action 与 detached collector Job，不增加模型工具或更改现有工具版本。Runtime 只转发宿主准备 port、执行 owner 和 Artifact stream；文件 I/O 不进入 Runtime 依赖闭包。

宿主收集、模型轮次与不可变快照分离的取舍见[Agent Note](../../../../.agents/notes/implemented/architecture/2026-11-11-host-output-snapshots.md)。

## 生命周期

宿主在平台准备开始前以 `prepareOutputStaging` 创建 Profile coordination 下私有持久 base。每个真实 `shell.command` Job 在 spawn 前创建 `out`，登记原 producer、准确父 Tool/Run 和目录身份，再注入 `KITE_OUTPUT_DIR`。平台仅移交已登记暂存目录的递归删除责任，进程、supervisor、IPC 和真实停止证明不变。

目录身份区分两个 owner：producer 的 `allocation.identity` 保持原 LaunchIdentity，供平台启动与清理；`allocation.outputIdentity` 的 device/inode 在准备时从正式 Files native 持有的 root 采集，后续收集使用同一 native 身份域完整比较。Windows 保留全部64位 volume 与128位 FileID，不把 Bun lstat 的较窄设备号当成相同格式，不截断或仅比较低位。原 path/canonical、目录类型、无链接检查和 native root/逐组件句柄验证仍分别执行；身份不依赖内存缓存，句柄不进入持久记录。

成功 producer 的 `finishExecution` 事务原子登记 pending 与确定性 `extension.invoke` command。失败或未知 producer 不交付残留文件。短 Action 只 ensure detached `builtin.files/collect`，collector 使用 runtime serial key，不声明 model/process slot、不设置 after-turn。准确来源的收集 Job 不投递业务邮箱，也不进入后台业务目录；名称相同不能取得例外。

默认 Service 只把宿主实际创建的 collector Job 注册到 runless 全局能力，不把它加入模型 Run 能力。每次授权通过同一只读 Store 事务核原短 Action、operation request/receipt、主体、Store/Session/rootWork、成功 producer 与 allocation，再核当前 attempt/startCommand 与请求和持久 intent 完全一致；描述 revision 绑定该证明。准确来源成立后才给 `effects: ['read','record_write']`、`safeRead: false`、`internalRecordOnly: true`：读取已绑定的自有 staging、将 payload 存为原 Store 私有 Artifact/业务记录，以及清理原自有暂存都属于内部归档。它不授权用户任意目标、普通 Files 编辑、另存或继续修改，不授予网络、进程或新的模型能力。`auto`、`accept_edits` 和 `full` 均沿既有 policy 完成归档，仍受当前 Workspace trust 和注入权限 ceiling 约束；不按名称通用豁免。

首次完整扫描冻结最多100文件、1000个总目录项、8层、单文件256MiB、单批1GiB。扫描和读取复用 Files native 持有目录句柄及逐组件 `openAt`，拒绝链接、外部硬链接和特殊文件。collector 向每次 `listAt` 传入剩余总目录项预算；native 在 Unix 迭代器／Windows 固定64KiB批缓冲中逐项扣减，含保护过滤前的条目，遇到首个超额项即拒绝，不先构造完整目录数组。错误映射为 `output_entry_limit`，未完整扫描不冻结部分集合。每次 native 枚举前后及字节流均让出事件循环并检查取消；仍不能为同步 OS／文件系统调用承诺硬时延上限。64KiB读取块通过原 `publishStream` 发布；读前后核设备、inode、大小、mtime/ctime。重试不扩大冻结集合，不重跑 producer，已交付文件按原记录复用。

每次交付固定 fileId 由 Store/Session/collection/相对路径计算；ref固定为 `output-file-<fileId>`，session作用域继承原主体。每文件提交验证原ref与活跃 collector，并单独幂等增加计数。部分成功保留可读文件，未完成项仍为失败；成功空目录不显示整理提示。

## 存储与读取

[SQLite owner](../storage/sqlite/output-collection.ts)只使用原 extension_record，按 `collection/<seq20>/<producer>` 与 `delivery/<seq20>/<producer>/<fileId>` 键范围查询。`OutputFileTarget` 持久保留 locator；resolve 为准确点查，不靠文件名、后缀扫描或内存映射授权。公开 summary 不含路径、hash或ArtifactReference，读取事务 revision 为原 lastChangeCursor。

最近交付按来源轮次倒序，单轮按原 command seq限定范围。旧文本操作在成功 Tool终态投影为 delivery；旧数据按准确 operation核成功状态、snapshot及artifactRefs，最近旧 heads使用独立 `legacy/` keyset继续，单页最多50项。collectionBeforeKey/nextCollectionCursor为可见收集状态提供独立范围续页，空记录在SQL限额前排除。历史旧时间未知时 publishedAt为空，不编造生成时间。旧 `files.outputs` 工具保持原合同；context capture不再列出整个会话文件路径。

Fork只 rebuild已交付记录，保原 readonlySources，省略allocation/collection。Shell的session ref仅在可验证原delivery、producer、allocation一致时准入既有只读Fork证明；不是任意session ref读取豁免。继承文件返回原ref，调用方在验证target后按原reference.sessionId读取。

## 恢复与清理

只在取得物理Session owner后，完整核原短Action、operation receipt、执行rootWork、subject、producer成功及allocation，再恢复失主collector/短Action。不会把未知Shell按名称放行；用户明确取消不自动重启。owner门禁按50项分批检查，不再依赖LIMIT3的单标题假设。只读列表不取得恢复权限。

已知 collector 在 adapter 前失败或取消时，原终态事务以相同来源证明把当前 collection 收口为可见 failed，保留已经交付的文件和数量。权限拒绝固定公开 code 为 `output_collection_permission_denied`，不暴露私有 details、不提供普通重试；其私有 `cleanupAfter` 独立保留7天，到期清理不依赖重试资格。冷 owner 对旧 pending/未绑定的准确拒绝只补收口，不改原 Execution result/revision、不增加 attempt 或 command；旧 attempt 迟到拒绝不能覆盖新 attempt，unknown 不进入这个已知失败分支。

ready后立即清理原身份目录；可重试 I/O 失败保留7天并显示retryUntil。Profile GC持有原维护锁，按准确allocation及producer/collector终态清理ready/过期staging；未知执行保留，过期查询显示output_staging_expired。原件Artifact保持既有引用GC。native句柄close未知保留I/O对象并交付unknown监督结果，不伪装为已关闭。

旧 allocation 不自动迁移或从当前路径补造缺失身份：只有原持久 device/inode 与完整 native 身份相同才可收集；Windows 旧窄身份不匹配时继续 `output_root_changed`，保留原失败事实与暂存保留规则。POSIX 旧身份若与 native 相同则仍可读取。此修复复用现有字段，不改变公共 LaunchIdentity、记录格式或协议版本；GC与成功清理仍只使用 producer 的原身份。

## 验证

`test/isolated/execution/output-collection-identity.test.ts` 以真实 Files native 核完整身份持久化/重开、volume高32位与FileID高64位篡改拒绝、替换目录与directory link拒绝、旧lstat身份不回填，以及真实字节流收集和原producer清理。2026-11-11 Windows x64／Bun1.4.4，该文件7项／21断言及既有preparation文件3项／9断言通过，Agent typecheck通过。此定向夹具的Runtime/持久化port为受控替身，JSON往返不代替SQLite或完整Service验收；本轮未执行POSIX回归，也不取得受管Shell或办公UI资格。原Windows Service失败现场不因新allocation修复而被改写。

目录扫描回归核1000项准确上限、单目录超限、剩余预算为零时遇到嵌套项及取消让出；[native 测试](../../native/files/src/lib.rs)另核10,000项目录仅访问预算加一项、保护项计数和原持有目录能力。数量边界与真实平台执行范围见 [Files native owner](../../native/files/README.md#构建与验证)。

`apps/service/test/isolated/output-collection.test.ts`（仓库根相对路径）以默认 Service 全局 authorizer、真实 HTTP/SQLite/Artifact 核三种模式无额外审批/模型调用、伪造 operation/attempt、撤销 trust 和注入拒绝；producer 仍为隔离 Bash/fixed-model 夹具，不代替受管 Shell。

`test/isolated/execution/output-collection.test.ts` 另核拒绝零 adapter 可见失败、无重试、保留已交付文件、冷收口零重放及到期清理保未知；使用真实 Bash subprocess、SQLite Worker、native Files和Artifact，覆盖双文件二进制、空输出、producer失败、链接拒绝、ref已发布但记录未提交、冻结集合缺项、Fork原快照和物理owner冷恢复/明确取消。`test/isolated/jobs/output-collection-preparation.test.ts` 和Linux preparation回归覆盖清理责任移交和持久base位于Workspace内。真实macOS/Windows未在Linux环境验收；修复前本工作树的Linux完整受管native smoke与既有普通Full测试均出现shell_owned_cleanup_unconfirmed；后者未配置outputCollection或Office资产，但不是旧revision独立制品的基线对照，不能据此排除本次调用配置变化。当时真实Desktop同样在namespace已接纳、root/G就绪未完成时返回unknown；固定错误标记无法唯一定位native失败步骤，当前PID消失也不改写原结果。这些历史失败保留。后续mount owner最小修复在Linux x64非root实测8项244断言通过，新隔离Desktop的真实Shell也已Exit0并确认监督树停止，具体范围归[Jobs owner](../jobs/README.md#linux-宿主与严格补偿源码)。不能由subprocess fixture或单次Shell通过推导完整办公UI、跨平台或安装发布资格。

2026-11-11，Linux x64／Bun 1.4.4 以 `bun packages/agent/test/isolated/execution/output-collection.measure.ts /tmp/kite-output-measurement` 实测同一真实 subprocess fixture，逐例保存原始请求、单调时钟和RSS采样JSON。空命令 `true` 开关收集交替顺序各5次、每次新进程：宿主准备配对增量中位4.696ms；原Run完成配对增量中位3.641ms，范围−120.570至138.268ms，调度噪声较大，不据此承诺稳定总开销。producer终态事务返回至collection ready事务返回中位为空99.387ms、32MiB 978.450ms、64MiB 1952.935ms，后两者各3次。32／64MiB收集区间宿主RSS采样峰值中位161.168／163.766MiB，较终态时分别增加38.582／42.578MiB；2ms采样包括SQLite Worker和native，排除生产者子进程，不能视为内存硬上限。计时排除Runtime启动和事后完整Artifact流式回读核验。全部16例均为2次固定模型请求，空输出的请求正文仅归一化不稳定身份和夹具路径后完全相同，均无交付fileId或collector回执注入；用量计数是夹具常量，不是实测Provider token。该测量不取得受管平台或Desktop体验资格。
