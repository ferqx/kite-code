# Git Worktree 隔离验证

负责 [git_worktree](../../../../src/tools/git-worktree/README.md) 的真实 Git 行为及可控故障窗口，不使用收费模型。

- [protocol](protocol.test.ts)：封闭输入、命令规范化、可信身份和各阶段终帧。
- [schema-runtime](schema-runtime.test.ts)：真实 Runtime 在授权前拒绝 action 字段组合错误，原模型收到参数纠正与零效果反馈；合法 list 随后经过原 Job 与记录链。
- [read-output](read-output.test.ts)：原 Job 完整输出、固定高水位、丢块/重复/非法 UTF-8 和空 droppedBytes。
- [errors](errors.test.ts)：新失败的启动／访问／Git 退出／核验分类、已启动进程的观察错误、清理保主因与原 mutation、有限无敏感信息回执及旧帧兼容。
- [Windows process](windows-process.test.ts)：正式受限宿主的文件 FD 捕获、二进制输出、预算／hash、借用 FD 与取消收口。
- [Windows errors](windows-errors.test.ts)：真实 Runtime→Tool→受限 Job→worker 链路、启动与 Git 非零退出分类、策略拒绝零 Job、稳定失败 key 只观察原 Job；故障仅由隔离测试 worker 注入，不增加生产开关。
- [recovery](recovery.test.ts)：CAS 并发、记录/ensure 间隙、精确 owner resume、原 ref 观察、未知转确定及取消；六个冻结点完整执行同 key 观察者，核原记录不变、owner 恢复后只派发一次。
- [worker](worker.test.ts)：隔离真实 Git 仓库、冻结提交、源数据保全、目的 filter、创建残留、删除保护、锁和代际；另核 stat 缓存隐藏修改、完整 blob 保全、内建 clean 转换、mode、共享／私有符号引用、packed refs 实际存储、晚新增 nested 内容和悬空新分支条目。
- [paths](paths.test.ts)：挂载检查失效、边界及变化和扫描超限；保存完整目录名称、代际与挂载证据，在最终复核拒绝晚变化及读取失败。
- [launch-security](launch-security.test.ts)：准确只读身份、命令伪造、资产批准后替换、Bun 环境/preload 和现有监管链。

运行 `bun test --parallel=1 --max-concurrency=1` 并传以上文件的绝对路径；[Service](../../../../../../apps/service/test/isolated/git-worktree-configuration.test.ts)另验装配和模型→Tool→Job完整链路，[发行](../../../../../../tests/isolated/unified-agent/terminal-bundle.test.ts)另验搬迁和安装后的实际资产。真实平台检查须在相应操作系统执行，Mock 不授予平台资格。

业务批准复用由[准确授权回归](../../execution/worktree-authorization.test.ts)核普通手动／Auto、独立人工条件、伪造原调用、冻结计划变化、撤销与最终派发期限；[消息回归](../../business/task/worktree-notification.test.ts)核原 Tool 持久消息、真实 parent 消费、恢复幂等和发送前后故障。recovery 同时核稳定 Git 回执先保存再通知、原 owner 续接与新 Execution 历史读取不重发。

当前成功创建测试通过[持久夹具](../../../../../../tests/fixtures/worktree-filesystem.ts)在仓库 `dist/acceptance/worktree-fixtures/` 保存隔离仓库；不在 OS 临时目录创建新工作树。失败、保护及早期样本保留原位置，清理不通过 force 或递归删除绕过被测保护；危险链接夹具只定点移除已知入口。无关用户仓库不参与测试。

[Service权限](../../../../../../apps/service/test/isolated/git-worktree-permissions.test.ts)通过实际Auto及当前只读 `explore` 子角色验证准确list和变更边界，并核Planning批准前list可执行；[Planning条件](../../business/planning-git-worktree.test.ts)覆盖原Execution、输入SHA及不适用边界。下方原 macOS 批次中的 worker／plan／review 名称属于当时冻结实现，不表示当前默认目录仍提供这些角色。

2026-11-06，基线`8e350f99`加本轮差量，macOS arm64／Bun1.4.4／Git2.54.0：以上目录加两份Service Worktree测试及Planning定向文件，以`bun test --parallel=1 --max-concurrency=1`传路径执行，84项／1425断言通过。覆盖实际消息/Job事件的因果顺序、记录与ensure间隙、原始非法/截断UTF-8、未知转确定、prepared与mutation接纳窗口的期限区别、参数纠正及三个action。补充父子权限交集与单层创建回归两文件34项／466断言通过；[真实模型证据](../../../../../../tests/e2e/live/model/README.md#git-工作树与直接子-agent)分别记录实际变更、审批来源、报告措辞和失败样本，不以受控测试代替模型表现。

同轮既有Shell/默认角色四文件39项／554断言通过；原Job及macOS原生Host两文件在可信解码改动后25项／334断言通过。前台期限/完整输出/范围权限及原Windows检索四文件20通过、1个Windows专属跳过／229断言；Planning新旧三文件29项／525断言通过。Terminal/Native归档与运行资产三文件20通过、1个Windows专属跳过／171断言，源码树外完整包与安装搬迁两文件2项／2003断言通过。安装包用真实三action及5个原Job核创建内容、删除和分支保留。类型、Biome、架构/API、测试归属和文档门禁通过；Biome仍有仓库warning/info，无error，未顺带清理无关诊断。

本轮业务批准与通知调整另覆盖[Service 真实默认 worker 子任务](../../../../../../apps/service/test/isolated/git-worktree-permissions.test.ts)：不能仅凭 root Tool 场景证明子权限接线；手动创建／删除各一张原业务卡，Auto 各一次原审核，四个内部 Job 逐项保准确父 Tool／check 来源，父只委派。直接 child 的回归同时保只读／父子权限交集和原普通 Shell 批准语义；[真实模型](../../../../../../tests/e2e/live/model/README.md#git-工作树与直接子-agent)单独核原消息和实际接收因果。

2026-11-06 最终业务批准／通知差量，基线仍为 `8e350f99`、macOS arm64／Bun1.4.4／Git2.54.0：以下完整定向命令101项／1734断言全部通过，包含实际默认 worker 的手动／Auto 接线、只读角色、记录／ensure 间隙、完整输出与删除保护。全部源码冻结后执行，没有用成功重跑推定旧未知效果。

```bash
bun test --parallel=1 --max-concurrency=1 \
  packages/agent/test/isolated/tools/git-worktree \
  apps/service/test/isolated/git-worktree-permissions.test.ts \
  apps/service/test/isolated/git-worktree-configuration.test.ts \
  packages/agent/test/isolated/business/planning-git-worktree.test.ts \
  packages/agent/test/isolated/execution/worktree-authorization.test.ts \
  packages/agent/test/isolated/business/task/worktree-notification.test.ts
```

业务批准／通知最终差量又以 `bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/built-package.test.ts tests/isolated/unified-agent/terminal-bundle.test.ts` 复验源码树外完整包与归档／搬迁／安装，2项／2003断言通过；沿正式资产执行真实三个 action。`bun run typecheck` 覆盖6401文件／9项目通过，`bun run format:check` 零error，保留55 warning／224 info而不改无关文件。API／架构边界、测试归属、文档和计划证据门禁通过。

2026-11-06 持久默认目录／普通 Shell 路径调整后，基线仍为 `8e350f99`，macOS arm64／Bun1.4.4／Git2.54.0。以上完整定向命令追加 `packages/agent/test/isolated/permissions/worktree-path-policy.test.ts` 与 `packages/agent/test/isolated/context/model-context.test.ts` 后，123项／1830断言全部通过。覆盖省略 path 的稳定目标、默认根缺失时只读 prepare 与批准后逐级 mkdir、同 key 配置变化读取原目标、临时目录及别名拒绝、只读 scope 不扩权、实际默认 child 手动／Auto 批准复用，以及既有恢复、完整输出与删除保护。Service 权限文件另以启动时隔离 HOME 的子进程执行，10项／109断言通过；Bun 已缓存的 homedir 不能通过进程内修改环境变量隔离。

同次差量执行 `bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/built-package.test.ts tests/isolated/unified-agent/terminal-bundle.test.ts`：built-package 通过；Terminal 夹具曾把 committed.txt 写到错误的合成目录而在 Git add 阶段失败，尚未调用 Worktree。修正仅该夹具后，单独重验 terminal-bundle 1项／1923断言通过，实际三个 action 沿归档、搬迁和安装后的资产执行；Git 源和工作树独立保存于持久夹具目录，通用安装目录清理不碰 Git 数据。生产源码与已通过的 built-package 输入未变，复用其结果。`bun run typecheck` 覆盖6413文件／9项目通过；`bun run format:check` 零error，保留55 warning／224 info。API、workspace／架构边界、测试归属、文档及计划证据门禁通过。真实模型和早期 unknown 现场的独立结论归[模型验证](../../../../../../tests/e2e/live/model/README.md#git-工作树与直接子-agent)。

2026-11-06 测试专项修复，基线与 macOS 环境不变；调整测试和证据读取，并按真实失败补充模型不得从成功／未见弹窗推断无审批的通用指导，生产三 action 执行、权限、取消及协议未改。`bun test --parallel=1 --max-concurrency=1 apps/service/test/isolated/git-worktree-configuration.test.ts apps/service/test/isolated/git-worktree-permissions.test.ts` 完整15项／206断言通过；[共享证据夹具](../../../../../../tests/fixtures/worktree-execution-evidence.ts)核原 record/ref／Command／payload／Job 和生产完整帧，读取故障负例没有重派发，主体与关闭双错误、初始化失败及 HTTP listener 收尾也已实际验证。此前123项执行／权限核心结果在对应源码未变的范围内复用，新增模型指导另由本次 context 和真实模型验证，不将新断言冒称旧运行已执行；本次 live 驱动、原生预检、发行资产及其故障回归分别归[模型测试](../../../../../../tests/e2e/live/model/README.md#git-工作树与直接子-agent)与[Terminal owner](../../../../../../apps/cli/docs/terminal-release.md)。

2026-11-06 review 修复，基线仍为 `8e350f99` 加当前差量，macOS arm64／Bun1.4.4／Git2.54.0：最初六项及独立复审补出的 nested 内容、packed backing、收尾取消三项均已修复。Worker／路径整文件72项／1122断言通过；下列 Service／live 故障组33项／330断言通过。它们核真实三个 action、手动／Auto 业务批准复用、直接 child、只读和 Planning 边界、原始完整证据与取消。原核心集成154项／2167断言通过后，追加补丁只改变 Worker／路径及 live 最终验收，已补跑这些受影响范围；原 owner／恢复／授权／通知源码未再变化，其交叉回归51项／642断言结果复用。独立整体复审覆盖相对 HEAD 的跟踪及未跟踪差量，最后未发现新的必修问题。

```bash
bun test \
  packages/agent/test/isolated/tools/git-worktree/worker.test.ts \
  packages/agent/test/isolated/tools/git-worktree/paths.test.ts
bun test --parallel=1 --max-concurrency=1 \
  apps/service/test/isolated/git-worktree-configuration.test.ts \
  apps/service/test/isolated/git-worktree-permissions.test.ts \
  tests/isolated/unified-agent/git-worktree-live-evidence.test.ts \
  tests/isolated/unified-agent/git-worktree-live-launch.test.ts \
  tests/isolated/unified-agent/git-worktree-native-preflight.test.ts
```

同次最终代码重新执行 `bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/built-package.test.ts tests/isolated/unified-agent/terminal-bundle.test.ts`，5项／2152断言通过；重新构建、源码树外、归档／搬迁／安装后执行真实三个 action，保留超时取消与硬停止 unknown 负例。全仓 `bun run typecheck` 为6420文件／9项目无错误；`bun run format:check --max-diagnostics=0` 无error，保留原55 warning／224 info。没有重跑旧 unknown 意图或改写旧现场，本次未新增真实 Provider 调用，原真实模型证据保留其原源码／提示和环境范围。

2026-11-06，`8364d9e40`加当前工作树／Windows x64／Bun1.4.4：[Windows Git 捕获](windows-process.test.ts)和[完整结果 reader](read-output.test.ts)两个整文件7项／43断言通过，覆盖正式 write-restricted Job、Git只读启动、双流预算、精确hash、坏UTF-8、借用inputFd、spawn失败及取消后原临时目录收口。原宿主同一Git的pipe对照报EPERM，文件FD路径返回完整list；不通过升级为Full绕过问题。原recovery整文件在Windows另有POSIX绝对路径夹具失败，未计通过；HEAD与当前未改路径策略的摘要相同，原`/target`、`/repo`都在参数检查抛`invalid_worktree_target_path`，最小对照与原失败保存在本机`.cache/worktree-desktop-live-20261106-b8da26c4/`。本轮不修该平台夹具、不以新成功重跑解释原失败。

Windows当前普通开发客户端的真实创建／图标、独立Workspace读写和缺目录恢复范围归[Native owner](../../../../../../apps/desktop/README.md#native-项目会话目录)，不扩大完整监管矩阵、Windows reparse或安装发行资格。Linux仍未取得本轮原生资格；macOS证据及Mock不代替其他平台。

同日错误分类差量，基线与 Windows 环境不变：[Windows errors](windows-errors.test.ts)和[Windows process](windows-process.test.ts)两个整文件10项／244断言通过。真实 Runtime→原 Tool／SQLite→正式 `workspace_write/none` Job→生产 worker 核文件 FD 成功与原三 pipe 实际 `uv_spawn EPERM` 的对照；未授权兄弟目录写入实际 `EPERM/syscall:open` 归文件访问拒绝、零 Git 派发；策略拒绝零 Job。真实缺失 executable、Git 非零退出及隔离注入 spawn EPERM 各保准确类别，失败 create key 再次读取保持原 Job/ref/observedAt、无新 Job／目标。故障注入仅在隔离测试 worker，未改全局 ACL、权限或生产开关。最终日志与逐例事实位于本机 `.cache/worktree-error-classification-20261106/`，早期夹具构建失败保留且不计产品通过。

最终 [errors](errors.test.ts)、[reader](read-output.test.ts)及[模型合同](../../context/model-context.test.ts)三个整文件10项／147断言通过，覆盖有限分类、原效果、清理保主因、畸形 JSON 不抛错及禁止换 key／参数／Shell 重试指导。既有 protocol 的 POSIX 默认根 `/persistent/worktrees` 在 Windows 不满足原 `resolve(defaultRoot)` 断言，已用 HEAD 协议模块复现相同失败；保留为夹具限制，未计整文件通过。全仓类型检查6436文件／9项目与八 workspace 构建通过；本轮未调用真实模型，不把提示词与受控回归称为模型永不重试的保证。

同日退出／Auto差量，Windows环境和基线不变：[业务授权](../../execution/worktree-authorization.test.ts)、[策略](../../permissions/policy.test.ts)、[Shell范围](../../permissions/shell-scoped-permissions.test.ts)和[路径](../../permissions/worktree-path-policy.test.ts)四整文件50项／743断言通过，1个原POSIX临时别名用例跳过。准确 Auto Tool 及原封闭 Jobs 零审核／人工卡，普通 Shell 同worker命令仍需原审核，模式撤销后不可沿旧来源派发。模型合同新增退出仅导航、删除需明确目标意图的回归；Auto免审批不代替任务授权。

[Service权限整文件](../../../../../../apps/service/test/isolated/git-worktree-permissions.test.ts)10项／159断言通过，5个原macOS隔离HOME用例在Windows跳过。实际 Windows 根 Auto list/create/remove 和默认 general child create/remove 均由正式原生 Job 执行、零 check／卡，mutation仍保 `parent_review` 和原 `full_access/none`，list沿原工作区受限范围；manual两张业务卡、workspace_write外写、dirty、登记根、overlap、只读child及Planning保护同时通过。测试只按平台修正宿主收尾证据、合法 Tool 本地拒绝缺末 ref 的形状，以及 Windows child 多步骤观察期限，不改生产期限或范围。最终串行日志在本机 `.cache/worktree-desktop-live-20261106-b8da26c4/auto-final-service-tests.log`。

此前一次原生 `windows_owned_child_start_failed` 保存为 Job outcome_unknown，发生在 Git worker 启动前；原DB与过滤事实在同目录 `auto-native-host-start-unknown.json` 保留，底层errno未持久化，不能猜因或改写为成功。相邻成功与失败 Job 的 scope均为Full／离线；资产冻结后整文件未再出现，不以通过重跑授予该原未知操作成功或完整宿主稳定资格。退出本身的真实桌面零执行、文件／登记保留与过程验证归[Native owner](../../../../../../apps/desktop/README.md)。
