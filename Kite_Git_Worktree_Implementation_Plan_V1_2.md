# Kite Git Worktree 工具实施方案

版本：V1.2\
日期：2026 年 11 月 4 日\
交付对象：实施 Kite 功能的 Code Agent\
代码基线：ferqx/kite-code 的 el-refactor 分支，提交 4f29be4e0fbd8baf49c7fc2b50617f2e16b4b34e\
建议入库位置：docs/plans/git-worktree-tool-v1.md

## 1 实施目标与完成定义

实现一个模型可调用工具 git_worktree，提供 list、create、remove 三个 action。Agent 可以列出当前仓库登记的工作树，从确定的提交创建 detached 工作树或新分支工作树，并在检查通过后删除指定 linked worktree。

本轮交付包括真实 Git 操作、受管进程执行、权限分类、操作记录、恢复、发行资产、自动化测试和负责文档同步。创建成功只返回真实路径，不改变当前 Session 的默认 cwd。用户后续在新目录执行命令时，继续使用现有工具和权限边界。

采用固定实现路线：由 builtin.shell 注册 git.worktree；工具通过已有 shell.command Job 启动随应用发布的可信 Bun worker；worker 内使用原生 argv 调用 Git。复用现有 Runtime，禁止另建 Git Broker、Job 类型、Workspace 注册系统、管理数据库或 Session 迁移协议。UI、新会话勾选项、自动初始化依赖、自动 fetch、复制未提交修改、force、prune、repair、归档及分支删除不属于本轮。

实现成功必须同时满足：三个 action 可达；只启用此工具时依赖完整；无真实副作用的伪成功；同一意图不会因重试再次变更；删除保护通过；现有 Shell 行为不回退；打包后的工具可运行。部分完成应按实际列出，不得用单元测试通过代替整条调用链完成。

## 2 开工规则与源码依据

### 2.1 基线检查

先读取仓库根 AGENTS.md、docs/AGENTS.md、packages/agent/README.md、工具与权限 owner 文档，以及 docs/development/worktree-safety.md。记录实际分支、HEAD、Git 版本、操作系统和工作区状态。若 HEAD 已前移，只重新核对本方案引用的接口；保持下列产品契约和安全边界，再调整函数落点。

当前方案是待实现规格，不代表功能已在仓库存在。实施时将本文件作为计划入口，按仓库既有 document-before-commit 的 design_complete、iteration_complete 规则同步；不增加阶段审批或新的验证台账。新工具初始定义 version 为 1，既有 Shell 工具、Job、Runtime 与协议版本不因本功能自行升级。遵循原任务的 Git 交付授权，保护无关改动。[K01][K11]

### 2.2 已核对的实际约束

| 事实                                                     | 实施要求                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| shell.command 输入是 command 字符串                      | 保留 Shell 输入契约；仅固定 worker 内部使用 Git argv             |
| permissions/shell.ts 已装配 macOS Linux Windows 后端     | 复用相应平台监管；不把基础 POSIX 工厂误当全产品平台边界          |
| 外层 Tool 带 slot 或 serial 时不能嵌套 operations.ensure | git.worktree 外层不声明资源槽或串行资源；进程槽由内层 Job 持有   |
| ensure 的请求摘要包含 parentExecutionId                  | 新 Tool Execution 的同 key 重试先读原 ref；禁止直接再次 ensure   |
| records.write 支持 expectedRevision CAS                  | 用现有记录持久化意图和阶段，不增加业务表                         |
| planRecordKey 要求记录已有执行来源                       | 首次 CAS 即设置 executable: true，不能事后升级普通记录           |
| Tool 有 recovery 和 resume                               | 原 Execution 可按原 key 续接；不得把续接变成重新执行已接纳的变更 |
| 当前 Shell Job 没有实现进程重连式 recovery               | 冷重启后不能承诺重连 Git 或证明它已停止                          |
| completeForegroundShell 只保留输出预览                   | Git 结果读取必须使用原 Job 的完整 readOutput                     |
| 多 action 工具不能整体成为只读工具                       | 外层 action 和内层可信命令分别分类                               |

这些约束来自工具契约、Shell 装配、扩展宿主和存储事务。[K02][K03][K04][K05][K06][K07]

### 2.3 对标实现的采用范围

Codex 的模型入口使用 create_worktree、get_worktree_creation_status、list_worktrees；后者读取任务附件。采用其固定提交、创建与登记分离、保留原 cwd、失败后核对实际结果的做法。其进程内创建状态表和 Desktop 目录布局不移植到 Kite。[C01][C02]

OpenCode v2 注册 worktree_create、worktree_list、worktree_remove，模型和 HTTP 入口共用服务。采用薄工具层、共同 Git 实现和原生 argv。其数据库库存、自动目录后缀、setup 脚本和 session_move 保留在本轮之外。[O01][O02]

## 3 工具身份与输入契约

### 3.1 固定身份

| 项目                    | 值                                               |
| ----------------------- | ------------------------------------------------ |
| Extension owner         | builtin.shell                                    |
| 内部 Tool ID            | git.worktree                                     |
| 模型工具名              | git_worktree                                     |
| Tool definition version | 1                                                |
| 内层 Job ID 与 version  | shell.command 和 1                               |
| 扩展记录前缀            | git-worktree/                                    |
| 记录 contentType        | application/vnd.kite.git-worktree-operation+json |
| 记录 contentVersion     | 1                                                |
| 记录 Fork 规则          | mode 为 omit                                     |

不得另起 builtin.git-worktree owner 后继续使用 builtin.shell 的记录或权限证明。工具名不附加版本号。工具描述应说明三个动作、默认 detached、默认 baseRef、创建不迁移 cwd、key 的重试规则和删除条件。

### 3.2 逻辑输入类型

```ts
type GitWorktreeInput =
  | { action: "list" }
  | {
      action: "create"
      key: string
      path: string
      baseRef?: string
      newBranch?: string
      timeoutMs?: number
      permissions?: {
        filesystem: "workspace_write" | "full_access"
        network: "none"
      }
    }
  | {
      action: "remove"
      key: string
      path: string
      timeoutMs?: number
      permissions?: {
        filesystem: "workspace_write" | "full_access"
        network: "none"
      }
    }
```

模型 Schema 使用封闭 object：action 必填、枚举三个值，additionalProperties 为 false。为兼容不同 Provider，不依赖根级 union 完成所有校验；执行端按 action 校验字段组合。list 拒绝 key、path、baseRef、newBranch、timeoutMs 和 permissions；create/remove 缺少 key 或 path 均拒绝；remove 拒绝 baseRef/newBranch。

key 为 1 至 128 个 ASCII 字符，匹配 [A-Za-z0-9_.-]+。path 必须是平台原生绝对路径，不做波浪号、环境变量、Shell 或 glob 展开。baseRef 默认为 HEAD，不能为空且不得含 NUL；上限 256 个 UTF-8 字节。newBranch 是新的本地分支短名，通过 git check-ref-format --branch 验证，且输出必须与原输入完全相同；另验证完整 refs/heads/<newBranch>。拒绝 refs/ 前缀、前导 -、已有分支及 @{-n} 等会被展开的 checkout 简写。路径必须可无损编码为 UTF-8；遇到 Unix 非 UTF-8 路径返回 unsupported_path_encoding，不替换乱码。

timeoutMs 为 1000 至 600000 的整数；create 默认 120000，remove 默认 60000。list 使用固定 15000 毫秒期限。变更调用的期限包含准备和执行步骤；恢复不得通过重置期限把原操作无限延长。权限默认 workspace_write 与 network none；full_access 只是请求，仍需现有策略授权。network 不能设为 internet。

来自模型的输入不能选择仓库、Git 程序、Bun 程序、worker 文件、Shell、环境变量或执行策略。

### 3.3 创建语义

来源是 trusted factory 捕获的当前执行 cwd，进入 worker 后解析其所在 checkout。默认 HEAD 指该来源 checkout 的 HEAD，不能悄悄改为项目 canonical checkout 或远程默认分支。用户要求特定起点时传 baseRef。

省略 newBranch 时，固定 OID 后创建 detached worktree。提供 newBranch 时，基于同一 OID 创建并检出新分支，不建立 upstream。baseRef 与 newBranch 不复用字段。用户指定的目标必须不存在，已有空目录也拒绝。变更 worker 随后原子 mkdir 预留的、由本次未中断执行独占的新空目录，才可交给 Git；这不是允许复用外部空目录。同 key 的历史成功回执不再次调用 Git。

不复制源 staged、unstaged、untracked、ignored 文件，不 stash、不切来源分支、不修改 Session cwd。首次 create/remove 不支持 bare 来源、unborn HEAD、partial clone、shallow 仓库、对象 alternates、info/grafts、启用 sparse checkout 的来源或目标、显式 core.worktree 或无法证明目的仓库定位的特殊配置；返回具体 unsupported_* 错误。list 仍可返回能安全读取的 Git 登记快照。此处采用拒绝特殊配置的边界，避免复制 Codex 的复杂目的配置修复逻辑。Git 缺失或配置不支持不阻断 Session 启动。

## 4 实现结构与文件改动

### 4.1 工具内部模块

| 新增位置                                                | 负责内容                                               |
| ------------------------------------------------------- | ------------------------------------------------------ |
| packages/agent/src/tools/git-worktree.ts                | 工具工厂 输入校验 records CAS 阶段调度 resume 结果组装 |
| packages/agent/src/tools/git-worktree/protocol.ts       | worker 请求和结果类型 限额 规范化命令构造与严格识别    |
| packages/agent/src/tools/git-worktree/worker.ts         | 固定入口 list prepare create remove 分派 终帧输出      |
| packages/agent/src/tools/git-worktree/git.ts            | Git argv 安全环境 Buffer 输出 机器格式解析             |
| packages/agent/src/tools/git-worktree/paths.ts          | 路径身份 祖先检查 Windows reparse 检查 仓库内排他锁    |
| packages/agent/src/tools/git-worktree/read-output.ts    | 原 Job 的严格完整输出读取                              |
| packages/agent/src/tools/git-worktree/build-assets.ts   | 构建独立 worker JS 配置 空 hooks 目录及 SHA256 清单    |
| packages/agent/src/tools/git-worktree/empty-bunfig.toml | 固定无 preload 的受保护 Bun 配置资产                   |
| packages/agent/src/tools/git-worktree/README.md         | 工具内部契约与实际限制                                 |

私有 helper 保持在该工具目录。除已证明需要复用的现有安全函数外，不创建通用 Git 框架或新的进程管理抽象。

### 4.2 现有位置的具体改动

1. tools/shell.ts：createShellExtension 在同一 Extension 下注册新工具与记录 schema，注入 trusted worker 配置。普通 Shell 工具输入和行为保持兼容。
2. permissions/shell.ts：shellToolIds 增加 git.worktree；只选择此工具也装配 shell.command。增加可选 Git 与 worker 资产发现、摘要校验、readonlyAssets、start 前复核、snapshot 和 commandDigest。增加仅 Host 可提供的 trustedWorkerLaunch resolver，准确识别固定 worker 命令后返回冻结启动 profile。资产缺失通过能力状态和调用错误表达，不让整个 Shell 装配失败。
3. permissions/capabilities.ts：保留 git.worktree 的保守静态分类；只在准确匹配的 describeRequest 中对合法 list 设置 safeRead。禁止加入整个 hostReadOnlyTool 白名单。
4. apps/service/src/configuration.ts：核对默认工具清单、knownToolIds、shellTools、版本校验、能力目录、依赖 Job 装配。selection.readOnlyTask 分支只允许准确 builtin.shell/git.worktree/1 的 action=list，内层仍执行可信只读 worker 校验。使用已有 policyRuntime 绑定注入第 11 节的已登记 Workspace 根只读查询。
5. extensions/task/roles.ts：只读角色增加上述精确 binding。不能接受同名自定义 Extension 或未来版本作为同一能力。
6. packages/agent/package.json：把 worker build-assets 纳入当前 build；如新增公开 import 才补 exports，工具私有 helper 不对外导出。
7. scripts/release/terminal-bundle.ts 及现有发行测试：核对新 build-assets 的 dist 目标、manifest 库存与安装包文件；沿用既有发布系统。
8. 负责文档：更新 tools/shell.README.md、permissions/README.md、docs/handbook/features/tools-and-approvals.md；按实际平台影响更新 shell-platform-compatibility 和 windows-shell-sandbox，不把尚未验证的平台写成通过。
9. jobs/shell.ts、jobs/linux-shell.ts、jobs/windows-shell.ts：以内部 ShellJobOptions 接入上述 resolver，在首次启动解释器或原生后端前应用可信 profile。普通命令返回 undefined，继续原路径；不扩 shell.command 的公开输入 Schema。

新工具外层不得设置 resources.slot 或 resources.serial，否则现有宿主会拒绝嵌套 ensure。[K04] 进程只能通过已装配的 shell.command 启动；外层 handler 不直接 spawn Git 或 worker。

## 5 可信 worker 与权限

### 5.1 固定执行路径

Host 提供 trusted sourceCwd、configurationId、Bun 绝对路径、worker 绝对路径与摘要、Git 绝对路径与摘要。Git 从可信 Host 环境发现，不能从项目配置或模型参数选择，也不能把可控 PATH 中同名程序当只读 Git。

启动命令只使用固定模板和规范化序列化的 payload。payload 编为 base64url 后作为单一参数；Bun 与 worker 路径使用经过测试的 POSIX 单参数引用，并覆盖 Windows Git Bash 路径行为。不得使用 JSON.stringify 的输出作为 Shell 引用。禁止拼接用户原始分支、路径或 ref 到 Shell 程序中。

worker 严格解析 payload，在内部调用 spawn/等价 API 的 argv 形式；Git 子进程必须非 detached，不调用 setsid，不逃离原进程树、沙箱或 Job 监管。worker 执行和所需静态资产置于安装的受保护目录；不从项目目录加载脚本、插件或初始化文件。

可信启动 profile 必须在第一个解释器启动前生效：macOS/legacy 路径包含外层 Bun supervisor，Linux 在 startLinuxOwnedShell 前应用，Windows 在首个原生命令启动前应用。环境从 Host 冻结的允许集合构造，只保留经过确认的系统 PATH、平台目录、必要 HOME 和临时目录等；不完整继承 configuration.env，再依赖 worker 内部删除几个变量。BUN_OPTIONS、NODE_OPTIONS、BASH_ENV、ENV、ZDOTDIR、动态加载变量及 Shell 函数导出等不进入该集合。

worker 和受影响路径的 Bun supervisor 均采用固定启动参数：<Bun绝对路径> --no-env-file --config <只读配置资产绝对路径> <固定JS资产>。配置资产不包含 preload，与 JS 一起构建、摘要校验并纳入 readonlyAssets；不依赖 /dev/null。profile 版本、稳定环境输入摘要、Bun flags 和配置摘要进入 commandDigest/snapshot；后端临时目录按既有固定规则派生，不能因随机 TMP 值令恢复摘要漂移。实际发布 Bun 必须验证这些参数及项目 .env、bunfig.toml、全局配置、preload 夹具；不支持时报告能力不可用，不移除保护参数重试。[K13][K14][K15][B01][B02][B03]

### 5.2 双层分类

外层精确识别 builtin.shell/git.worktree/1，并完成输入校验。合法 list 为 safeRead、effects read；create/remove 保持进程与文件写入效果，scope 来自请求和现有授权。

内层 shell.command 的 worker 识别器必须：

1. 验证只有一个规范化启动命令，完整解析闭合 payload。
2. 校验 trusted sourceCwd、配置身份、Bun/worker/Git 资产及摘要。
3. 重新生成命令并与输入逐字相等；不接受附加命令、重定向、替代程序、额外参数或环境赋值。
4. 绑定第 5.1 节的可信启动 profile；不能让环境、项目或全局 Bun 配置使固定 worker 启动前执行其他代码。
5. 只对固定 list 实现授予 safeRead；内部 prepare 虽然只读取，首版仍按其所属 create/remove 的保守能力执行。payload 不存在可自报的 readonly 或 safeRead 字段。
6. 在实际 Job.start 前重验资产；批准后被替换则拒绝执行。

准确的只读子 Agent 限制与 planning 约束都要保留。当前权限模式只有 accept_edits、auto、full，不新增虚构的 readonly mode，也不放宽 acceptedScopeLeaves 的现有名单。[K07][K08]

### 5.3 写入范围

worktree 创建和删除不仅写目标目录，还写公共 Git 元数据目录；新分支也写共享 refs。授权必须覆盖来源识别所需读取、目标、公共 Git 目录与锁文件位置。

workspace_write 无法覆盖这些路径时，返回明确权限不足及缺少的范围，保留原操作证据。不得自动扩为 full_access、偷偷换到另一个目录或绕过内层 Job。权限请求是意图的一部分，同 key 修改权限输入视为新意图冲突；只有上一变更已确认未执行，才可在合法授权下以新 key 发起另一请求。原结果未知时不得用新 key 重试相同变更。

### 5.4 Git 执行环境

固定 Git 程序，清理继承的仓库定位变量和命令级 Git 配置，至少包含 GIT_DIR、GIT_WORK_TREE、GIT_COMMON_DIR、GIT_INDEX_FILE、GIT_OBJECT_DIRECTORY、GIT_ALTERNATE_OBJECT_DIRECTORIES、GIT_NAMESPACE、GIT_REPLACE_REF_BASE、GIT_CONFIG、GIT_CONFIG_PARAMETERS 及 GIT_CONFIG_COUNT 关联项。使用显式 cwd 和来源身份；重新生成的命令级安全配置由 worker 提供，不接受 payload 自定义配置键或值。

每次调用禁用交互认证、hooks、fsmonitor、untracked cache 和可执行 filters；只作命令级覆盖，不写共享 Git 配置。hooksPath 指向安装资产中可验证的空目录，不用模型路径；过滤器的 process/clean/smudge 置空，required=false。配置读取及 filter 名必须按 NUL 机器格式解析，使用 GIT_CONFIG_KEY_n/VALUE_n 等精确键值机制注入覆盖，不把带点、等号的 driver 名直接拼成 -c key=value。配置异常、超限或不能完整确定过滤器时拒绝。

includeIf 等条件配置可能让目的 checkout 与来源加载不同 filters，因此创建必须按第 9.2 节先 --no-checkout 登记，再在实际目的上下文检查配置和禁用 filters，最后只填充当前 worker 刚分配的空目标。不能仅扫描来源配置后直接 checkout。源或目的 core.worktree 重定向不做自动修复。

所有对象读取与可达性判定使用 git --no-replace-objects；不能让 refs/replace 改变删除保护结论。首版 create/remove 拒绝 info/grafts、shallow 和 alternates 等未支持的图或对象来源配置；不得把缺失对象或不可验证历史当作安全。保留必要系统运行环境，但不能从模型接受它们。[G06]

禁止主动 fetch 和隐式 lazy fetch；用能力探测确认 git --no-lazy-fetch 可用，并在所有 Git 命令中使用。发现 partial clone/promisor 配置或缺少对象，首版返回明确不支持或对象缺失，不联网补齐。读取使用 --no-optional-locks。禁用外部 filters 意味着 LFS 等内容可能仍为仓库中的指针文件；工具创建的是提交 checkout，不承担下载依赖或过滤器初始化。

## 6 worker 协议和输出

### 6.1 私有阶段

worker 允许 list、prepare_create、create、prepare_remove、remove 五个内部阶段；模型仍只看到三个 action。prepare 只观察并产生冻结计划，create/remove 必须携带已保存计划及其摘要，并在实际变更前重复检查。请求、计划和终帧按 phase 使用封闭的嵌套 Schema，拒绝未知字段、action/phase/plan 类型不匹配及错误摘要。

请求必须携带 schemaVersion、configurationId、operationToken、phase、sourceCwd、Git 资产身份、输入或冻结计划。operationToken 是由 owner Session、Execution、key 和意图摘要计算的非秘密标识，只用于结果关联，不授予权限。拒绝未知字段和过大 payload。

worker 的标准输出只写一个带 protocolVersion、operationToken、phase 的终结 JSON 帧；Git 的 stdout/stderr 不直接流入该协议。成功或已知业务失败都完整输出帧并以进程退出码 0 结束；Git 非零退出由帧中的 gitExitCode 与 businessOutcome 表达。worker 自身崩溃、协议失败或被终止由受管 Job 表达。

prepare 成功只产生 prepared 计划，不能成为 create/remove 的最终成功。只有原 owner Execution 首次执行或合法 resume 能从 prepared 派发 mutation；新的 Execution 只能观察已有步骤。

变更 worker 的固定顺序是：取得锁、重复检查、执行变更、后置核验、核对 nonce 并释放自己的锁、最后输出唯一终帧。终帧后不得再变更或做可能失败的清理。worker 的 success 不能替代整个受管执行树的终态。锁清理失败应输出已知失败及 mutation 实况，不以重跑 Git 处理。

### 6.2 输出限额

| 对象                           | 首版上限                                  |
| ------------------------------ | ----------------------------------------- |
| 输入 payload                   | 32 KiB UTF-8                              |
| 单条路径                       | 4096 UTF-8 字节                           |
| worker 单个结果帧              | 256 KiB                                   |
| 单个 Git 命令内部 stdout       | 16 MiB                                    |
| 单个 Git 命令内部 stderr       | 256 KiB                                   |
| list 公开返回                  | 最多 256 项 且序列化业务结果不超过 64 KiB |
| 删除递归扫描                   | 最多 100000 项                            |
| HEAD reflog 与保护引用检查输入 | 各最多 10000 个唯一提交                   |

上限常量集中定义并测试。超限要显式失败，不能截断后当作完整安全检查。Git 的 stderr 可作为有标记的诊断预览，不用于唯一业务判定。响应维持在现有协议帧限额之内；本轮不以扩大发送上限解决问题。

### 6.3 完整读取

read-output.ts 直接读原 OperationRef。先确认 executionId、sessionId、originStoreId、Job 类型与定义匹配，并观察到 Runtime 终态；然后固定第一次返回的 highWaterSeq，按 throughSeq 推进，检查单调性、范围、页间一致性和 EOF。

发现 droppedBytes、输出缺块、游标不前进、超限、UTF-8 解码失败、多帧、终帧缺失、token/phase 不符，一律不能解析为成功。droppedBytes 的非零字符串以及 null 都代表丢失；null 是丢失字节数不详，禁止用 truthiness 判断。不要读取 completeForegroundShell 的 stdout 预览来做 Git 机器解析。[K06][K16]

worker 内部对 Git 原始 Buffer 用严格 UTF-8 解码器，遇到非 UTF-8 路径拒绝，不允许替换字符后继续操作。NUL 机器输出先按字节分隔再解释字段，避免换行或空格截断路径。

## 7 意图记录和恢复

### 7.1 记录内容

记录 key 为 git-worktree/<用户key>；list 使用 git-worktree/list/<原executionId>，其含斜线的后缀不能与合法用户 key 冲突，模型无需提供 key。业务记录以 Session 和 builtin.shell 为作用域，用 expectedRevision CAS 创建和更新。首次写入必须同时设置 expectedRevision:null、executable:true；后续保持 executable 语义，ensure 的 planRecordKey 明确指向该记录。普通记录没有所需 originStore 身份，事后升级会触发 record_execution_origin_immutable，不能先写普通记录再补。[K05]

```ts
interface WorktreeOperationRecord {
  schemaVersion: 1
  ownerExecutionId: string
  requestDigest: string
  request: FrozenUserIntent
  configurationIdentity: string
  acceptedAt: string
  deadlineAt: string
  phase:
    | "accepted"
    | "querying"
    | "preparing"
    | "prepared"
    | "mutation_dispatching"
    | "mutation_observing"
    | "completed"
    | "unresolved"
  plan?: FrozenWorktreePlan
  planDigest?: string
  steps: {
    query?: FrozenJobStep
    prepare?: FrozenJobStep
    mutation?: FrozenJobStep
  }
  stableResult?: ToolResult
  lastObservation?: ToolResult
}

interface FrozenJobStep {
  operationKey: string
  input: FrozenShellCommandInput
  inputDigest: string
  ref?: OperationRef
}
```

记录应包含来源 cwd、规范化输入、权限请求、timeout、接受时间及绝对期限、原 Execution ID、固定提交 OID、路径代际证据以及所有已知步骤引用。FrozenJobStep 保存实际交给 ensure 的完整、逐字稳定的 Job input，包括 command、payload/token、权限与阶段 timeout，及稳定摘要。使用现有 canonicalJson 和稳定哈希，不将错误栈、环境秘密或原始授权凭据放入结果。精确类型应适配现有 Json 与 OperationRef，禁止另建泛化 Operation 模型。

stableResult 只保存证据确定的最终业务结果；outcome_unknown 保存为 unresolved 和 lastObservation，不进入稳定缓存。即使 outcome 为 failed/cancelled，若仍无法确认执行树或副作用边界，也不得冒充可永久重放的稳定终态。

### 7.2 首次调用顺序

list 只保存 query 的完整 FrozenJobStep，ensure 单个 list Job 并读取完整终态，不经过 prepare/mutation。下面顺序适用于 create/remove：

1. 校验输入及 trusted 配置，计算冻结意图摘要。
2. CAS 创建 executable 的 accepted 记录，冻结 acceptedAt/deadlineAt；并发失败者读取已有记录，不再派发。
3. 在记录中先写入 preparing 阶段、确定的 prepare operationKey 及完整 FrozenJobStep。
4. 在原 Execution 中 ensure prepare Job，并立即保存返回 ref。
5. 读取其完整终态和协议结果，把 OID、路径证据及计划摘要 CAS 保存为 prepared。
6. 先持久化 mutation_dispatching、确定的 mutation operationKey 及完整 FrozenJobStep，再 ensure 变更 Job，立即保存 ref。
7. 只观察原 Job，核验完整结果，确定终态保存 completed/stableResult；证据不足保存 unresolved/lastObservation。

prepare 与 mutation 各用固定子 key。ensure 传入现有计划记录 key 以保持原 Store 身份约束；不能从 fork 或恢复的外来记录中创建新的变更 authority。

### 7.3 同 key 调用规则

| 已有事实                                          | 处理                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| 相同 key 但请求摘要不同                           | 返回 worktree_intent_conflict，不执行                                           |
| 已有证据确定的 stableResult                       | 返回历史回执，标记 replayed；不刷新成新的当前事实                               |
| 保存了原 Job ref                                  | get/wait/readOutput 原 ref，不再次 ensure                                       |
| 新 Execution 仅观察到 prepare 成功                | 不报创建或删除成功，不派发 mutation；返回 outcome_unknown 与原 owner 待恢复信息 |
| ref 缺失且是 Runtime 对原 Execution 的合法 resume | 使用该阶段原 operationKey 和已保存的完整 input，按现有 ensure 约束续接          |
| ref 缺失且是新的 Tool Execution                   | 返回 outcome_unknown 和原 Execution ID，不补发                                  |
| unresolved 且保存了原 ref                         | 继续只读观察，后续出现确定证据可 CAS 更新为 stableResult，禁止第二次变更        |
| 原 Shell Job 冷重启后不可验证                     | 返回 outcome_unknown，不创建替代 Job                                            |
| Git 已变更但结果记录未保存                        | 从原 ref 的持久终态和完整帧恢复；证据不足保留未知                               |

ensure 的摘要含 parentExecutionId，记录写入与 ensure 又不是同一事务，因此必须覆盖“Job 已接纳、ref 尚未保存”的崩溃窗口。[K05] 本方案保证同一意图不会通过重试再次变更；不承诺每个崩溃中的操作最终都能自动完成。

Fork 中省略这些执行记录。读取旧成功回执表示那次操作成功，不保证路径现在仍存在。删除成功后同路径重建时，旧 key 只返回旧回执，绝不能再次删除。

### 7.4 取消与期限

所有内部 Job 使用 cancellation attached。deadlineAt 在首次接纳后不变。阶段首次冻结时可根据剩余期限设置该阶段 timeout；一旦保存 FrozenJobStep，resume 的 ensure 必须逐字复用，不能重算 token、command、payload 或 timeout。总期限判断及取消观察在该请求之外执行。期限到达时，通过原 ref 请求取消，并持续按已有 Runtime 规则观察真实终态，不因等待超时启动第二份 Job。期限已到且 ref 缺失时，不调用可能首次派发的 ensure；没有已派发证据时报告超时与 not_started，存在接纳窗口则保留 outcome_unknown。

父 Tool 取消后只能继续进行允许的同 ref 观察；不得脱离取消信号启动新的 Git 核验、清理或恢复进程。只有监管确认原执行树停止，才可返回 cancelled。无法确认则 outcome_unknown。取消不表示没有残留目录或分支，结果中保留已观察事实。

## 8 Git 基础操作与 list

### 8.1 仓库识别

从 trusted sourceCwd 执行 rev-parse，取得绝对 topLevel、gitDir、gitCommonDir 和是否 bare；不通过拼接 source/.git 推导。从 linked worktree 调用时，仓库身份使用规范化公共 Git 目录及文件系统身份，来源 checkout 身份另外保存。

主工作树与当前来源工作树是两种概念，删除必须分别保护。不可仅比较路径字符串前缀；使用平台规范化后分量包含关系，处理大小写、别名与祖先链接。预检失败不能退化为当前进程 cwd。

### 8.2 list

执行 git worktree list --porcelain -z。按 NUL 字段和空记录边界解析，保留 worktree、HEAD、branch、detached、bare、locked、prunable 及原因。首项主工作树语义结合仓库类型核验；未知字段可忽略但不能误拼进路径，缺少关键字段或重复矛盾字段报 protocol_error。

返回 repository 信息、sourceWorktree、worktrees、observedAt。每项含 path、head、branch、detached、isMain、isCurrent、locked、lockReason、prunable、pruneReason；bare 项没有提交时相应字段为 null。head 不限制为固定 40 位，兼容仓库的对象格式。

list 是该次 Git 登记快照，不包含 dirty、进程占用或 removable 结论。不把缺失但仍登记的路径过滤掉，不创建数据库库存，不自动 prune。超出限额返回明确 inspection_limit，不返回看似完整的部分成功。[G01]

## 9 create 算法

### 9.1 准备阶段

确认 Git 可用、仓库配置满足首版边界、源 HEAD 可解析。解析和验证目标绝对路径；目标必须不存在，直接父目录必须存在且是普通目录，首版不递归创建任意父目录。拒绝将目标放入 Git 元数据目录、任何已登记工作树内部或使其包含已有工作树。

对父目录链做链接检查并记录规范化路径和代际证据。macOS 的系统级路径别名可规范化后固定真实路径；Windows 祖先中出现 reparse/junction 则拒绝。返回并冻结实际目标绝对路径，避免删除或权限检查使用另一种路径解释。

将 baseRef 通过 rev-parse --verify --end-of-options <ref>^{commit} 解析成完整 OID。验证对象存在且是 commit。Git check-ref-format --branch 校验 newBranch 且返回值须与输入逐字相同，再验证完整 refs/heads/<newBranch> 并检查同名本地分支不存在；不能接受 @{-1} 等展开、-B 或改为复用已存在分支。

冻结计划：sourceCwd、sourceRoot、commonDir、baseRef、baseOid、targetPath、目标父目录身份、newBranch、配置和资产身份。记录中的 baseOid 是变更依据，之后 baseRef 移动不会改变本次起点。

### 9.2 变更阶段

取得第 11 节的仓库排他锁，重复校验仓库身份、配置、目标父目录和目标不存在。重复确认 newBranch 不存在。随后使用 mkdir(target, {recursive:false}) 原子预留目标；仅当前活 worker 刚创建成功的、身份固定的空目录可继续。不同 clone 争用同一路径时，后到者在 mkdir 失败且不创建分支。预留已是 mutation 副作用，后续失败时不能写 mutation=not_started。

使用已固定 OID 先登记，不检出文件；以下省略第 5.4 节统一的安全参数和环境：

```text
detached:
  git worktree add --no-checkout --detach -- <targetPath> <baseOid>

new branch:
  git worktree add --no-checkout --no-track -b <newBranch> -- <targetPath> <baseOid>
```

登记后读取目标真实 adminGitDir、commonDir、topLevel 及 .git 双向回链。核对目标目录仍为本次预留的同一代实体、除本次创建的 .git 外没有外来内容、HEAD/branch 与本次请求一致。以已验证 adminGitDir 和显式目标 workTree 读取目的实际配置，拒绝重定向、sparse 等未支持配置，重新完整枚举并覆盖目的 filters。目的 includeIf 配置不能由来源检查替代。

所有核验通过后，仅在这个未中断的 worker 中，以显式定位参数填充新目标：

```text
git --git-dir=<verifiedAdminGitDir> --work-tree=<targetPath> \
  reset --hard --no-recurse-submodules <baseOid>
```

此 reset 的作用域严格限于当前 worker 刚分配、仍无外来内容的目标；不能作用于来源、用户已有目录或中断后重新发现的目录。恢复只观察原受管 Job；新的 worker 不能凭空目录或相同 OID 继续 reset。无法确认两阶段创建的任何身份时返回 partial/unknown 的 details，保留现场，不重写源配置。

所有参数通过 worker 的原生 argv 传递。调用不包含 force，不自动 fetch，不自动创建同名替代目录，也不调用用户 setup 脚本。

### 9.3 后置条件和部分失败

成功必须同时确认：登记和填充两步 Git 都退出成功；目标在同一仓库的 worktree list 中；目标自身解析出的 commonDir 与计划相同；topLevel 正确等于目标；HEAD 等于 baseOid；detached 或新分支符合请求；源分支及源工作区未被工具改写；本次仓库锁已正确释放。

源内容保全用测试断言验证，生产不对整个源仓库做昂贵哈希快照。明确不支持的共享 core.worktree 配置应在执行前拒绝，不能在创建后通过重写源配置来修复。

mkdir、add 或填充任一阶段失败都可能留下目录、登记或新分支。已知失败后，在操作仍允许继续观察的前提下检查目标登记、路径存在及分支是否出现，分别返回事实。不能自动删除分支、force 删除目录、改为复用分支、切换路径或换 key 重跑。无法检查的字段用 unknown，不猜测 none。

## 10 remove 算法

### 10.1 目标与身份检查

目标必须是完整登记于同一 commonDir 的 linked worktree，登记路径必须唯一；目标 .git 必须是普通 Git pointer file，指向的 adminGitDir 属于该 commonDir，admin 中的 gitdir 回链必须指回此目标 .git，目标解析的 topLevel 必须等于目标。拒绝主工作树、当前来源 checkout、包含来源 checkout/commonDir/管理目录的目录、异仓库、locked、缺失/prunable、包含其他已登记工作树的目录以及初始化子模块的目标。首版遇到索引 gitlink 也保守拒绝，返回 unsupported_submodule_worktree。

prepare_remove 保存目标 root、.git 文件内容摘要、admin gitdir、HEAD、branch、登记信息及可取得的 dev/ino/ctimeNs/birthtime 等代际证据。单独的 path、HEAD 或 inode 都不是永久身份。变更前必须重新读取并比较；无法取得或证明必要身份时拒绝删除。外部无协作替换仍可能发生，不能声称一次预检对所有并发文件系统变更具有原子性。

### 10.2 文件内容保护

执行并严格解析：

```text
git --no-optional-locks status --porcelain=v2 -z \
  --untracked-files=all --ignored=matching

git ls-files -v -z
git ls-files --stage -z
```

status 中出现 tracked 改动、untracked 或 ignored 项即拒绝。ls-files -v 出现 assume-unchanged 或 skip-worktree 标记也拒绝，避免 status 漏掉本地改动；这些标记的识别须按 Git 文档和真实测试实现，不能依赖仅检查大写 S。索引存在冲突 stage、gitlink 或解析不完整同样拒绝。

使用不跟随链接的递归目录扫描，检查忽略的空目录、未登记的空目录和异常文件类型。Git 不跟踪空目录：存在不能由当前 tracked 文件目录集合解释的额外目录时，返回 local_content_present，保留用户创建的内容。记录所有正常目录遍历与扫描完成证据；达到限额、权限不足、目录变化或读取错误均拒绝。

Windows 必须复用现有 windows-path-security 能力，并参考 check-worktree-cleanup.ts：拒绝目标及祖先、目标内部任意文件或目录 reparse point/junction、循环和断开的链接；只报告入口，绝不进入目标。不能只靠 Node 的 isSymbolicLink 代替 Windows reparse 检测。POSIX 同样不跟随链接；首版删除遇到 symlink 或特殊文件保守拒绝。

挂载点和 bind mount 不能仅凭 lstat 或 st_dev 排除。路径扫描增加平台挂载表检查：Linux 严格读取 /proc/self/mountinfo 的实际挂载目标，macOS 通过原生挂载表能力（getmntinfo 或现有等价实现）取得目标，Windows 按 reparse/mount point 能力处理。拒绝目标本身或其内部存在挂载边界；祖先所属普通文件系统可使用。无法取得完整挂载证据、表在检查中变化或平台没有实现时返回 unsupported_mount_inspection，不降级成递归删除。

### 10.3 提交保全

删除必须检查当前 HEAD，以及该工作树 HEAD reflog 每条记录的 old OID 和 new OID。reflog 只作为待保护提交来源，不作为保护引用；不能仅执行 git reflog show --format=%H，因为只出现在有效记录 old 字段中的提交会被漏掉。

首版严格删除仅支持 files ref backend，通过 Git 能力探测及 rev-parse --show-ref-format 的已知返回值确认，不能将不认识的输出当作 files。用 rev-parse --path-format=absolute --git-path logs/HEAD 解析实际文件位置，验证普通文件、不跟随链接、完整有界读取，并按仓库对象格式解析每条记录的两个 OID。丢弃全零 OID，其他 OID 必须逐一存在且为 commit。文件缺失、损坏、截断、读取变化、对象缺失或其他后端均拒绝；不能从当前 core.logAllRefUpdates=false 推断过去没有需保护的历史。

明确的保护引用仅为共享本地 refs/heads/* 和能剥离为 commit 的 refs/tags/*。不把目标 HEAD、其他 detached 工作树 HEAD、远程跟踪引用或 reflog 当作已保留的独立引用。使用 for-each-ref 和必要的 commit 剥离取得保护 tips，遇到读取不完整或损坏时拒绝。

把 HEAD 和完整 reflog 非零 old/new OID 去重后作为正集合，把上述保护 tips 作为负集合，交给 git --no-replace-objects --no-lazy-fetch rev-list --stdin --max-count=1 检查是否仍有不可达提交；stdin 只含验证过的 OID 及 ^<OID> 负引用行。返回任何提交即 unprotected_commits，空输出且命令成功才通过。禁止使用 HEAD --not --all，因为 --all 会包含本身需要保护的 HEAD；也不能让 replacement 或 grafts 伪造提交可达性。[G05][G06]

若保护 tips 为空，保守拒绝。首版不自动创建保留分支、tag 或隐藏 ref；错误中提示先将需保留提交放入分支或标签，待原拒绝已确定未变更，再用新 key 发起新的删除意图。保证范围限于当前 HEAD 与仍完整存在的 reflog 证据，不能恢复已经过期、被删除或从未记录的历史。

### 10.4 实际删除

在 prepare 已完成、remove Job 尚未派发时通过第 11 节的 Host 占用检查；随后在 worker 仓库锁内重复目标身份、文件和引用检查，紧接着执行普通 git worktree remove -- <targetPath>。不传 force，不解锁，不递归删除，不删除对应分支或 tag。

成功需确认：Git 退出成功；该登记不再存在；原目标目录不再存在；本次仓库锁已正确释放。目录仍存在、被重建、权限无法核验或 metadata 仍残留时，返回明确失败或未知，并保留 observed facts；不能继续 rm 或 prune。

旧 key 重放只读历史回执，即使目标路径已重建也不再执行。新 key 必须重新观察和批准新的删除意图。不得因普通 worktree remove 能删除而跳过本节检查。

## 11 并发和已知限制

现有宿主禁止外层资源锁与嵌套 ensure 组合，因此不以 Tool.resources 实现仓库串行。worker 在写入前使用公共 Git 目录内的固定私有锁目录，例如 kite-worktree-operation.lock，通过原子 mkdir 取得排他权；所有 Kite worktree 变更都遵守同一锁。list 和 prepare 不写锁。

锁 owner 包含 operationToken 和随机 nonce；锁必须覆盖重复预检、Git 变更和全部后置核验。只允许持有者在子进程结束、后置核验完成并核对 nonce 后清理自己的普通元数据文件和空锁目录，清理结束后才能输出终帧。锁目录或 owner 存在链接、异常类型、无法读取或创建中不完整，一律当作占用或未知。不得递归删除锁目录。

Git 变更已成功且后置条件通过，但锁释放失败时，返回 failed、code=worktree_lock_cleanup_failed、mutation=completed，并注明锁残留或状态未知。不能先输出成功再尝试清理，不能因清理失败重跑变更。取消或崩溃未完成清理时保留锁，沿原操作证据报告。

进程被强杀可能留下锁。首版不靠 TTL 或 PID 单独判断失效，不自动抢占或删除未知锁；返回 worktree_busy 或 lock_state_unknown，附原操作标识。确认原受管任务已经停止后，可由现有人工运维路径定点清理；本工具不新增 unlock action 或后台恢复服务。

删除前落实两项已有状态的只读检查，不新增占用注册系统：

1. prepare Job 结束后、首次 ensure remove 之前，调用现有 context.readRunExecutionSafety(context.runId)。Host 已自动排除当前 Tool；必须核对 excludedExecutionId 等于当前 executionId 且 unconfirmed=false。该检查覆盖本 Run、子执行及关联 child Session 的未确认状态。runId=null、接口缺失或读取失败时返回 worktree_occupancy_unavailable；存在未确认任务返回 worktree_busy。不能在 remove Job 已派发后做此门禁，也不能用会包含当前活动 Run 的 readExecutionGroupSafety().quiescent 直接替代。[K03][K04][K17]
2. Service 通过既有 Runtime.listWorkspaceDirectory/getWorkspace 完整分页读取已登记根。向 createShellConfiguration 新增独立程序化参数 worktreeHost.readRegisteredWorkspaceRoots，并用闭包传给工具；这不是 ToolContext 的现有接口。不要放入会被 structuredClone 的 ShellConfigurationOptions。目标等于或包含其他已登记 Workspace 根时返回 worktree_registered_workspace，无论其是否活跃。记录 Store 身份与分页完成证据；接口缺失、分页缺失或路径无法可靠解释时拒绝，不让 worker 直连数据库。[K07][K09][K18]

上述门禁适用于尚未派发的原 owner 操作；已有 mutation ref 的恢复仍只观察原 Job，不能因新的占用结果另起变更。新增 Host 回调默认不提供删除能力，Service 正常装配必须注入；SDK/测试调用方需提供真实或有明确夹具来源的实现。

仓库锁协调遵守协议的 Kite worker，Host 门禁只是派发前的观察；二者不是跨 Run 的全局占用租约。首版不承诺识别未登记目录、其他 Run 通过 Shell 临时 cd 进入目标形成的占用，也不检测外部进程。删除应在用户已停止使用目标的前提下执行；检查中观察到变动即拒绝。源工作树和公共 Git 元数据仍共享，工作树也不等于安全沙箱。

## 12 结果与错误契约

### 12.1 外层结果

沿用 ToolResult 的 succeeded、failed、cancelled、outcome_unknown；不增加 accepted、pending、partial 等顶层 outcome。细节放入 details。

```ts
interface WorktreeDetails {
  action: "list" | "create" | "remove"
  key?: string
  replayed?: boolean
  observedAt: string
  repository?: { root: string; commonDir: string }
  path?: string
  baseRef?: string
  baseCommit?: string
  head?: string | null
  branch?: string | null
  detached?: boolean
  cwdChanged: false
  removed?: boolean
  code?: string
  mutation: "not_started" | "completed" | "partial" | "unknown"
  operation?: { ownerExecutionId: string; ref?: OperationRef }
  observed?: {
    pathExists: boolean | "unknown"
    registered: boolean | "unknown"
    newBranchExists?: boolean | "unknown"
  }
}
```

list 另返回有上限的 worktrees 数组。mutation 描述工作树业务变更，包含目标目录预留，不表示没有 Runtime 记录写入或内部锁文件操作。历史回执的 observedAt 使用原时间，replayed 为 true；不能写成当前状态。结果中的路径属于数据，不能作为工具指令执行。

### 12.2 状态映射

| 证据                                                                    | ToolResult                              |
| ----------------------------------------------------------------------- | --------------------------------------- |
| list Job succeeded 且完整 list 终帧成功                                 | succeeded                               |
| create/remove 的 mutation Job succeeded 完整帧成功 后置条件和锁清理通过 | succeeded                               |
| prepare Job succeeded 且计划完整                                        | 仅更新 prepared 不是最终业务成功        |
| 新 Execution 只有 prepared 证据且无 mutation                            | outcome_unknown 指向原 owner 不接管执行 |
| Job succeeded 完整帧报告已知业务失败                                    | failed 并保留残留事实                   |
| Job failed 且能证明 Git 变更未开始                                      | failed                                  |
| 变更可能已发生但缺少完整协议或终态证据                                  | outcome_unknown                         |
| Runtime 确认取消和执行树停止                                            | cancelled 并保留已知副作用              |
| 只有取消请求或 worker 自报退出                                          | 不能推断 stopped 必要时 outcome_unknown |
| 权限 输入 不支持配置 在变更前拒绝                                       | failed 且 mutation not_started          |

### 12.3 稳定错误分类

| 分类       | 建议错误码                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入与环境 | invalid_worktree_arguments git_not_found not_git_repository unsupported_git_version unsupported_repository_configuration unsupported_path_encoding unsupported_reflog_backend unsupported_reflog                                    |
| 意图与输出 | worktree_intent_conflict worktree_operation_unverifiable worktree_protocol_error worktree_output_incomplete inspection_limit                                                                                                        |
| 创建       | invalid_base_ref invalid_branch_name branch_exists target_exists unsafe_target_path target_identity_changed                                                                                                                         |
| 删除       | not_linked_worktree wrong_repository current_worktree main_worktree worktree_locked worktree_dirty local_content_present unprotected_commits unsupported_index_flags unsupported_submodule_worktree                                 |
| 路径与并发 | unsafe_reparse_point unsafe_symlink unsafe_mount_point unsupported_mount_inspection path_scan_incomplete worktree_busy worktree_occupancy_unavailable worktree_registered_workspace lock_state_unknown worktree_lock_cleanup_failed |
| 执行与权限 | worktree_permission_denied worktree_asset_changed git_operation_failed worktree_verification_failed worktree_timeout worktree_cancellation_unconfirmed                                                                              |

以结构化检查和退出码分类，不能只解析英文 stderr。Git 输出只提供有界诊断。每个错误提供下一步动作；未知结果明确要求观察原操作，禁止“自动重试”措辞。

## 13 分阶段实施和测试

### 13.1 阶段 A 基础链路与查询

先完成工具身份、封闭输入、可信 worker 资产、双层权限、完整输出读取、records CAS 和原 ref 观察，再实现 list。交付只选择 git.worktree 也能工作的 Service 夹具。

通过条件：查询数据来自真实 Git；特殊路径不丢失；只读子 Agent 只能 list；未知 worker 或 Git 资产不被当作只读；记录缺口不生成第二份变更。完成本阶段后继续 B，不因阶段切换请求重复确认。

### 13.2 阶段 B 创建

实现 prepare/create、固定 OID、路径检查、原子目录预留、两种分支模式的 --no-checkout 登记与安全填充、后置核验和残留报告。接入取消、期限、原 Execution resume 和新 Execution 同 key 观察。

通过条件：正常创建成功；源内容保留；分支移动不改变冻结 OID；add 的部分失败不被误报为无副作用；中断与恢复不产生重复工作树。

### 13.3 阶段 C 删除和完整交付

实现目标代际检查、文件与索引检查、HEAD 和 reflog old/new 提交保护、Windows reparse 与挂载边界门禁、仓库排他锁与保守清理，再接发行 smoke 和负责文档。

通过条件：正常删除成功且分支保留；危险目标全部拒删；重放不删除新实体；平台检查失败不降级；真实调用链与新增门禁通过。所有已授权阶段完成后按实际 diff 与证据交付。

### 13.4 必须覆盖的测试矩阵

| 编号 | 场景                                                   | 必须断言                                                     |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------ |
| T01  | 只启用 git.worktree                                    | 工具可见 内部 Job 与资产完整 不暗中开放模型 Shell            |
| T02  | 三个 action 的非法字段组合                             | 变更前拒绝 未知字段不能穿透 worker                           |
| T03  | 无 Git 非仓库 unborn bare partial sparse core.worktree | 错误明确 Session 可继续 源配置不变                           |
| T04  | 普通 detached 分支 locked prunable 列表                | 实时 Git 登记完整 字段准确 无 removable 假结论               |
| T05  | 空格 中文 引号 换行 路径前缀相似                       | 字节解析与路径包含关系正确 无 Shell 注入                     |
| T06  | 非 UTF-8 路径与输出损坏                                | 拒绝操作 不替换乱码或截断后继续                              |
| T07  | 默认 HEAD 显式分支 tag 和 SHA256 仓库                  | 固定正确提交 不硬编码 40 位 OID                              |
| T08  | 默认 detached 与 newBranch                             | HEAD 正确 源分支不切换 分支模式准确                          |
| T09  | prepare 后来源分支移动                                 | mutation 仍用原 baseOid                                      |
| T10  | 源含 staged unstaged untracked ignored                 | 源文件 index 保留 新树不复制本地修改                         |
| T11  | 分支已存在 目标已存在 父目录缺失                       | 不覆盖 不自动换名 不自动建任意父目录                         |
| T12  | add -b 后注入失败                                      | 报告残留分支 不清理或重新 add                                |
| T13  | 目标祖先在 prepare 后被替换                            | 变更前拒绝 原目标之外文件完整                                |
| T14  | 同 key 并发和同 key 改 action 参数权限                 | CAS 只接纳一个意图 改参数报冲突                              |
| T15  | intent 后 ensure 前崩溃                                | 不借新 Execution 猜测并补发变更                              |
| T16  | ensure 成功但保存 ref 前崩溃                           | 原 Execution 可续接 新 Execution unknown 无重复变更          |
| T17  | Git 成功但保存最终记录前崩溃                           | 原 Job 完整证据可恢复 同 key 不重跑                          |
| T18  | 冷重启 原 Job 状态不明                                 | 不伪造进程重连 不换 key 执行                                 |
| T19  | 输出预览截断 丢块 重复序号 错 token 错 phase           | 不将不完整信息判成功                                         |
| T20  | 正常取消 超时 强杀 子进程未停                          | 真实终态正确 unknown 不变成 cancelled                        |
| T21  | 干净且提交被本地分支或 tag 保留                        | 删除成功 分支 tag 源仓库保留                                 |
| T22  | staged unstaged untracked ignored 各自单独存在         | 全部拒删 内容保留                                            |
| T23  | 仅额外空目录 ignored 空目录                            | 保守拒删 不把 Git 不跟踪等同于无内容                         |
| T24  | assume-unchanged skip-worktree 内有实际改动            | 即使 status 空也拒删                                         |
| T25  | detached 唯一提交                                      | 拒删 捕获错误的 --not --all 实现                             |
| T26  | HEAD 已回已保留提交 旧提交仅在 HEAD reflog             | 拒删 保护覆盖不局限当前 tip                                  |
| T27  | 只有 remote ref 或其他 detached HEAD 保留              | 按明确保护策略拒删                                           |
| T28  | 主树 当前来源 linked 异仓库 locked 嵌套 子模块         | 全部变更前拒绝                                               |
| T29  | 成功删除后同路径同 HEAD 重建                           | 旧 key 不再删除 新实体完整                                   |
| T30  | prepare 后同路径被重建且 inode 被复用                  | 代际变化或不可验证时拒绝                                     |
| T31  | Windows 祖先和内部 reparse junction dangling 循环      | 不跟随 不调用删除 主仓库内容保全                             |
| T32  | 扫描权限不足 超限 中途目录变化                         | 不放行删除                                                   |
| T33  | worker Bun Git 资产缺失或批准后替换                    | 不加载项目替代脚本 不授予伪只读                              |
| T34  | 预加载环境和伪造 worker 命令                           | 附加命令 payload 扩字段 替代 PATH 均不能绕过                 |
| T35  | 只读子 Agent 与 planning 约束                          | list 可按已有授权运行 create/remove 无法越权                 |
| T36  | 目标或公共 Git 目录未授权                              | 不扩权 不换目录 不绕过 Job                                   |
| T37  | 两个 worker 并发 同仓库锁和残留锁                      | 一次仅一个变更 未知锁不抢占 不按 TTL 清理                    |
| T38  | Fork 与恢复的外来记录                                  | 不继承可执行 mutation authority 不跨 Store 重放              |
| T39  | 打包后 worker 与摘要及 Git 路径                        | 从发行目录可启动 不依赖源码目录                              |
| T40  | 模型工具真实链路                                       | 用户请求 工具调用 Job 结果 后续对话 cwd一致 无虚假成功       |
| T41  | executable 首次 CAS 与 planRecordKey                   | 首次已有 originStore 不先写普通记录再升级                    |
| T42  | 新 Execution 只读到成功 prepare                        | 不报 create/remove 成功 不派发 mutation                      |
| T43  | ref 未保存 剩余时间改变或 deadline 已过                | 未过期合法 resume 复用原 input 已过期不补发 不重置期限       |
| T44  | 首次 unknown 后原 Job 出现确定证据                     | 同 key 可更新确定结果 不永久缓存 unknown 不重跑              |
| T45  | Git 成功 后置核验通过 释放锁失败                       | 报 failed 与 mutation completed 保留锁事实 无二次变更        |
| T46  | replacement 伪造保护分支包含 detached 提交             | 禁用 replace 后正确拒删 grafts 等不支持配置拒绝              |
| T47  | 目的 includeIf 新增外部 filter 特殊 filter 名          | 来源与目的命令均不执行 filter 填充不改源配置                 |
| T48  | 两个不同 clone 并发创建同一目标                        | 仅原子 mkdir 获胜者继续 后到者不建分支                       |
| T49  | --no-checkout 后失败或中断 目标被塞入外来文件          | 保留 partial 新 worker 不 reset 外来内容不覆盖               |
| T50  | reflog 独有提交仅在 old OID 字段                       | 仍拒删 不依赖 reflog show 的新值集合                         |
| T51  | reflog 缺失损坏 非 files 后端 图或对象证据缺失         | 明确拒删 不跳过无法解析的提交                                |
| T52  | POSIX mount/bind mount 及挂载表不可读取                | 不进入挂载目标 不调用删除 不以 st_dev 单独放行               |
| T53  | @{-1} 前导 - 已有分支名                                | 字面分支验证拒绝 不创建替代分支或 upstream                   |
| T54  | 项目 .env bunfig 全局 preload 与环境注入               | 各平台首次解释器前隔离 打包 Bun 保护参数生效                 |
| T55  | 输出 droppedBytes 为 null                              | 判输出不完整 不把 null 当成无丢失                            |
| T56  | 本 Run 有未确认任务 其他 Workspace 登记根 查询失败     | 派发前拒删 排除自身 Tool 不以整组 quiescent 阻断所有正常调用 |

真实 Git 行为必须用临时仓库测试；故障窗口、权限拒绝和输出损坏使用可控屏障或 Mock。Windows reparse、Linux/macOS/Windows 监管与发行 smoke 在真实对应平台执行；不能以 Mock 或另一个平台通过替代。当前无某个平台环境时，保留该平台验证缺口且不宣称已完成其发布资格。

测试临时目录只清理本测试确认拥有的内容；涉及 Windows 联接的夹具先定点解除已知入口，再按现有规则清理，禁止用递归清理“顺便”验证危险链。

### 13.5 建议测试落点和命令

新增 packages/agent/test/isolated/tools/git-worktree/ 下的 schema、protocol、list、create、remove、recovery、permissions 测试；Service 增加 apps/service/test/isolated/git-worktree-configuration.test.ts。按仓库测试归属规则补相应 README/索引。

```bash
bun run --cwd packages/agent build
bun run --cwd packages/agent typecheck
bun run --cwd apps/service typecheck

bun test --parallel=1 --max-concurrency=1 \
  packages/agent/test/isolated/tools/git-worktree \
  apps/service/test/isolated/git-worktree-configuration.test.ts

bun test --parallel=1 --max-concurrency=1 \
  packages/agent/test/isolated/tools/shell/foreground.test.ts \
  packages/agent/test/isolated/extensions/operation-output.test.ts \
  packages/agent/test/isolated/permissions/shell-scoped-permissions.test.ts \
  apps/service/test/isolated/shell-search-configuration.test.ts

bun run check:unified-agent-boundary
bun run check:test-ownership
bun run check:docs
```

随后运行现有受影响平台 Shell fixture 和打包 smoke，依据实际 diff 执行仓库要求的门禁。不要用全量反复测试替代具体失败定位，也不默认运行收费的真实模型测试；先以现有 mock Provider 验证整条模型工具调用链。
