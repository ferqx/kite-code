# 真实模型 E2E 套件

当前维护的[工具模型 runner](model-tools.live.ts)使用 `@kite-ai/agent`、实际 SQLite 和 `@kite-ai/ai/sdk`，读取现有用户配置的默认模型与协议。凭据按 Service 相同规则在内存中解析，不修改用户配置。显式执行：

```bash
KITE_RUN_LIVE_MODEL_TOOLS=1 bun run test:model:tools:live --output=/absolute/owned-directory/report.json
```

未设置门禁时在读取配置和访问网络前拒绝执行；报告路径可省略，指定时必须为绝对路径且文件不能已存在。Runner 只发送独立临时 Workspace 内的合成任务和测试工具目录，不读取仓库正文、用户说明或真实会话。先核 Files 列表、glob、字面搜索、准确基线编辑与新建文件，再以新 Run 读取结果；第二场景使用同一真实模型作为 parent 和一个无工具 child，验证 `spawn_agent → wait_agents(task_ids) → read_agent`。实际磁盘、内部 Execution/授权输入、公开 ModelInput、下一轮历史与冷读取分别断言，不以模型确认文字代替实际效果。

整个 runner 最多 20 次实际 HTTP 请求、总时限 240 秒，每次请求时限 60 秒；测试将 `maxOutputTokens` 上限收紧为 4096，其余已配置 preset（包括 reasoning effort）保持。Provider 失败立即使测试失败，不更换模型、协议、删除参数重发或自动重试。关闭 Runtime/文件能力并删除自有 Store 后，只保留模型/Provider/协议、日期、状态码、调用名称/字段名称、用量及脱敏计数，不保留请求、响应或凭据正文。

这项真实模型测试只证明当次明确模型和工具路径；普通 Service/权限组合由 mock Provider + 真实本地 Service 测试另证，不代称其他模型、完整客户端、MCP 远端或全部平台通过。

## 问答界面与越界读取

[问答 runner](questionnaire.live.ts)使用同一用户默认模型与凭据，在独立临时 Workspace 中装配实际 Runtime、Workspace sources、Files 和 `ask_user`，并在 headless Chrome 中操作当前共享 SessionPage／InteractionCard：

```powershell
$env:KITE_RUN_LIVE_QUESTIONNAIRE='1'
bun tests/e2e/live/model/questionnaire.live.ts --output=D:/owned-directory/questionnaire.json
```

未显式开启时，在读取配置与访问网络前拒绝。测试自行构建当前组件、Native CSS 和字体；Windows 默认使用本机 Chrome，其他安装位置可显式设置 `KITE_TEST_CHROME`。报告路径可省略，提供时必须为尚不存在的绝对路径，并在同位置附一张合成问卷截图。隔离 [浏览器入口](questionnaire-browser.fixture.tsx)不进入 dev/prod。

最多 10 次 Provider 请求、总限时 180 秒、单次 60 秒，输出上限 4096，其余 preset 保持；Provider 失败直接失败，不降级或自动重试。验证未回答翻页零提交、选择值与完整自由原文、单次提交、取消后同 Run 继续，以及越界读取失败进入下一真实 Model 并正常结束，外部说明／正文不得进入模型。报告只保留模型／协议、用量、状态与计数，不保存凭据或请求／响应正文。2026-10-18 Windows／Bun1.4.3 使用 deepseek-v4-flash、chat-completions 实测三项通过，每项两次 HTTP 200。该证据覆盖真实模型、Runtime 与共享浏览器界面；Native Main／IPC、OS 窗口和完整权限模式仍由各自原测试证明。

## Windows 原生附件路径实测

2026-10-19，Windows x64／Bun1.4.3／Electron44.3.0，在单独构建的普通 Native 开发窗口、独立 Profile 和合成 Workspace 中，通过真实 Windows 文件选择器操作 `+ → 选择文件 → 发送`。使用现有用户配置的 `deepseek`／`deepseek-v4-flash`／`chat-completions`，自动审核模式；配置与凭据只读，不发送仓库正文或用户文件。此项由 `computer-use` 驱动系统窗口，不是上述浏览器 runner 的通过记录，也未给 dev/prod 添加测试开关。

工作区内含中文、空格、方括号的 ini 实际读取成功，模型最终回复文件中的准确合成标记。工作区外文件的实际 `files.read` 返回 `file_path_invalid`，同一 Run 后续模型解释拒绝并正常结束；两场景各两次成功的主模型执行、一次 Files，Run 均为 `completed`，没有 `context_source_unavailable`。只读 Store 与完整 Artifact 输入快照另核真实 `file:` 引用受理、工具结果进入下一模型、外部说明及文件正文未进入输入；脱敏报告只保存模型／协议、终态、工具错误与计数，未保存凭据、请求或响应正文。现有[越界回归](../../../../apps/service/test/isolated/assembly-file-denial.test.ts)以 `bun test apps/service/test/isolated/assembly-file-denial.test.ts` 运行，1项／13断言通过。

前述外部场景明确要求调用 `read_file`，只验证工作区工具误用时不终止整轮，不能作为“选中的外部附件可用”的验收。随后修复普通宿主默认缺选 `files.read_path`，同日同环境使用全新独立 Profile，通过原生 `+` 选择工作区外 ini，以普通提问要求根据实际内容说明。模型自行选用 `read_user_file`，准确目标读取成功，最终字段值与文件一致；原 Run `completed`、两次成功 Model、一次成功 `files.read_path`，完整输入核实实际正文进入下一轮、未选中外部项目说明未进入模型，无 `context_source_unavailable`。外部写入／编辑未随默认读取开启；报告只保存脱敏结果与计数。普通默认／显式禁用及真实原生读取由[Service 回归](../../../../apps/service/test/isolated/configuration.test.ts)另证。

这是路径附件的本机原生流程证据；选择文件不改变现有执行权限和受保护文件规则。直接图片协议、PDF 正文解析、其他模型及正式 installed／其他平台仍需分别验证。当前产品与实现归 [Desktop owner](../../../../apps/desktop/README.md#markdown-与附件输入)。

## 历史模型套件

以下 compaction 与 background 文件仍依赖旧运行时，根脚本中的旧 aliases 已退出，不能用于验证当前实现。保留原命令和记录供对应历史版本追溯。原 context compaction 命令为：

```bash
KITE_RUN_LIVE_MODEL_COMPACTION=1 \
KITE_LIVE_MODEL_API_KEY=... \
KITE_LIVE_MODEL_BASE_URL=https://provider.example/v1 \
KITE_LIVE_MODEL_NAME=model-name \
bun run test:model:live
```

只有 DeepSeek-compatible endpoint 才设置 `KITE_LIVE_MODEL_PROVIDER_TYPE=deepseek`。Runner 有超时上限，串行执行两次 Provider 调用，只报告标识，不输出 prompt、request、summary、配置或凭据。每个套件必须：

- 使用 `*.live.ts` 文件名；
- 从隔离的环境配置选择 provider 和 model；
- 作为独立 runner，由显式 package script 和 opt-in 环境门禁通过 `bun run` 调用；
- 串行运行并设置超时上限；
- 脱敏凭据、完整 prompt、request 和用户配置；
- 记录所有被引用结果的 provider、model、日期、网络条件和命令。

Mock model、仅公网 MCP 和本地 transport 测试不属于本目录。

## DeepSeek 后台任务与多会话

以下套件固定使用 provider `deepseek` 和 model `deepseek-flash`，不接受模型覆盖：

```bash
KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1 \
KITE_LIVE_DEEPSEEK_API_KEY=... \
bun run test:model:live:background
```

本节的旧App Server套件和 `KITE_LIVE_BACKGROUND_SERVICE_EXECUTABLE` 属历史实现。旧Desktop的 `prepare:service` 已退役，不再从当前checkout生成其配套二进制；已保存旧制品的显式历史验证仍只证明那个版本，不能将新Native／Service交给这套旧协议驱动。当前正式Native、完整默认和平台验收归[测试入口](../../../README.md)；本次入口退役没有重跑付费模型或改写原历史断言。

默认 endpoint 为 `https://api.deepseek.com/v1`；只有使用受信的 DeepSeek-compatible 代理时才设置 `KITE_LIVE_DEEPSEEK_BASE_URL`。未设置 `KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1` 时 runner 会在建立网络连接前明确拒绝执行。显式 opt-in 后，runner 会先调用该 endpoint 的 `/models`，确认固定模型 `deepseek-flash` 确实被公布；模型不可用时不发送测试提示，并以“场景未建立”快速失败。

Runner 在权限为 `0700` 的临时根目录内创建隔离的 Kite 配置和 Workspace，以权限 `0600` 写入从环境变量取得的 API key，并在 `finally` 中关闭 App Server、递归清理临时目录。测试使用 FIFO 事件屏障控制 child 终态，不让模型或 child 通过 `sleep` 或固定 `task_read` 轮询维持等待。日志只输出固定 provider/model、不可用的 seed 标记、通过的场景及不含正文和稳定 identity 的脱敏 cardinality trace，不输出 key、prompt、request、response 或临时配置。

该套件通过真实 App Server 协议断言以下场景：

- 会话 A 在同一响应中建立两个 `background + required` child，随后由真实模型显式且仅调用一次 `task_wait([A, B], 60000)`，全程不得调用 `task_read`、轮询或 sleep；两个 child 必须各执行一次指定 FIFO Shell 并回报各自 marker；
- 只释放 A 的 FIFO 后，`task_wait` 必须成功终态，A 为 `completed`、B 仍为 `running`，同一个父 Run 保持 `required_background` waiting 且不得失败；再释放 B 后，同一个 Run 才完成并输出约定正文；
- A 等待时创建会话 B，并由真实模型在 B 中调用文件工具；
- A/B 的历史事件及后台执行投影互不串线；
- 屏障释放后 A 以同一 Run identity 收敛两个 required child；
- 会话 C 显式建立获授权的 `after_turn` child，父 Run 先以约定正文完成，child 必须执行一次指定 FIFO Shell 并保留 marker，终态后按持久化的 `afterTurn.runId` 精确建立且仅建立一个后续 Run；
- 不重启 Service 热重进 A，历史正确投影 `subagent.completed`。

这是付费且依赖公网的串行 E2E。超时可通过 `KITE_LIVE_BACKGROUND_TIMEOUT_MS` 调整；测试失败也不得把完整 provider payload 加入日志。

## 验证记录

- 2026-10-19，Windows x64、Bun 1.4.3、Electron 44.3.0，本任务工作树；真实用户配置的 `deepseek`／`deepseek-v4-flash`／Chat Completions，正常公网网络。通过自有隔离 Profile、合成 Workspace 和普通 Native 开发窗口，经 `+` 两个原生选择器分别选外部 INI 与直接 PNG，再发送；两次 Model 和一次 `files.read_path` 成功，Run `completed`。读取准确 INI 字段、识别图片文字和两个红色方块；封存 Model 输入核原图 Base64 字节、后继实际文件内容、消息正文未改写且文件／图片元数据独立；未选的外部说明未进入输入，无 `context_source_unavailable`。启动／复核命令为 `bun .cache/attachment-cards-e68af6a7-8e05-4353-b253-1f7df0e2151c/native-live.ts` 和同目录 `verify.ts`；这是本次合成数据的临时夹具，原始 Store／配置不作为发布证据，保留脱敏 `report.json`。复现需重新建立独立夹具并明确真实模型授权，不从用户真实目录读取内容。结果限该模型／协议／平台，不覆盖 PDF 正文解析、其他提供商或 Responses 真实端点；实现与确定性回归入口见 [Native owner](../../../../apps/desktop/README.md#markdown-与附件输入)。

- 2026-10-18，macOS arm64、Bun 1.4.2、HEAD `bcf70ce84` 上的工具表面工作树；使用现有默认 provider `deepseek`、model `deepseek-v4-flash`、`chat-completions`，配置的 `reasoningEffort:medium` 保持，测试输出上限为4096。直接网络实际11次HTTP均200；`files`（6次请求）和 `agents`（5次，包含真实child）通过，共11次工具调用、10份parent热/冷完整公开快照。准确终态、子结果 `323`、任务目标和磁盘效果均独立断言。命令为 `KITE_RUN_LIVE_MODEL_TOOLS=1 bun run test:model:tools:live --output=<自有绝对路径>`；最终runner耗时11.916秒，Provider实报输入34921/output1524 token。此前调试首次因测试使用字符串比较对象键顺序误报快照差异，修正后完整两场景通过；本轮三次runner实际合计29次请求，无换模型/协议或自动重试。只保留脱敏报告，不保留请求或响应正文。此证据不覆盖Native/Windows/Linux、其他模型、真实MCP远端或完整Service客户端。
- 2026-07-22，provider `deepseek`，model `deepseek-v4-flash`，正常网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 和 `incremental-summary` 通过。本记录未保留 request 或 response 正文。
- 2026-07-29，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 因 `ContextCompactionValidationError: Summary was truncated` 失败，未进入 incremental 场景。本记录未保留 request 或 response 正文。
- 2026-09-20，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：`auto` 交互模式下，A/B 会话隔离、B 独立交互、后台 Shell 与后台子 Agent 的工具调用及持久终态、A 的主 Run 完成、热重进历史投影全部通过；A 的两项后台执行均为 `completed` 且 `cleanupConfirmed`。Service 环境显式注入指向 Workspace 外启动脚本的 `BASH_ENV` 与 `ENV`，Shell stderr 为空且启动脚本副作用未发生。未保留 provider 请求或响应正文。
- 2026-09-20，provider `deepseek`，要求 model `deepseek-v4-flash`，官方 endpoint 正常可达且凭据通过 `/models` 鉴权。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：场景未建立。官方 `/models` 只公布 `deepseek-flash` 与 `deepseek-v4-pro`，未公布固定模型 `deepseek-v4-flash`；预检未发送模型提示，也未以其他模型替代通过。此前两次无预检运行均在首个 `model.requested` 后以 `recovery_required / unknown / operator_action` 终止且没有建立 task 调用。
- 2026-09-20，provider `deepseek`，model `deepseek-flash`，官方 endpoint 正常网络条件，seed 不可用。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：双 required child、A 等待期间的 B 会话交互、A/B 隔离、同 Run 恢复、热重进和 exactly-one after-turn continuation 全部通过。脱敏 trace 为 required task calls `2`、waiting task count `2`、等待前后模型请求 `2 → 2`、`task_read` `0 → 0`、Run identity 保持；after-turn task calls `1`、原 Run 先完成、continuation runs `1`；B 模型响应 `2` 且子 Agent 事件 `0`。未保留 provider 请求或响应正文。
