# Workspace 文件 leaf

模型接口由可信 `ToolDefinition.model` 投影：`read_file/write_file/edit_file/list_directory/glob_files/search_content`，绝对用户文件为 `read_user_file/write_user_file/edit_user_file`。读取使用 `start_line/max_lines`，编辑使用 `old_text/new_text/expected_matches` 及对应 Artifact 字段，其余声明属性使用 snake_case；任意正文和 Artifact 身份保持原值。内部 `files.*` ID、定义版本、完整 baseline、权限与检查点合同保持原样。`search_content` 仍是字面量搜索，不新增正则能力。

公开入口 `@kite-ai/agent/files` 的 import 不打开资源。宿主显式调用 `createWorkspaceFiles({root,maxFileBytes?})` 选定一个物理 Workspace 根，再用 `createFileTools(files)` 将六个普通 ToolDefinition 装配进扩展；工具仍走 UnifiedExecution 的权限、来源复查、计划、派发和终态。没有 CodingAgent、Git 或旧 filesystem authority 依赖。

只读 `read` 的可信 options 可携带 `signal`；普通 `read_file` 和绝对 `read_user_file` 从实际 ToolContext 传入，不新增模型字段。完整文件读取仍以 64 KiB 块核 hash、UTF-8 解码及前后身份，在 8ms 或 64 块预算后通过真实 event loop 让出；行选区在块内统计完整 totalLines，只保留请求正文，不建立全文行起点数组。BOM、CRLF、跨块 UTF-8 和完整 baseline 不变，行窗口不构成字节截断。search 的单文件读取复用该异步读取，逐行匹配另按预算让出；底层未指定 limit 时保留全部命中和完整长行，模型默认改为有界预览，见下节。

异步读取保留原目录及文件 FD，恢复时核原根和取消，EOF 后再次核完整文件身份；漂移不发布旧结果。`close()` 先拒绝新读取并让在途只读退出、关闭各自 FD 后再关闭 native owner，多次 close 共用同一结果。取消和异常不关闭别的读取句柄。写入/edit 的共享读取按同步方式消费同一分块校验，不在原最后 CAS 与发布之间插入让出；字节恢复和发布后 unknown 合同不变。合作让出不能给单次慢磁盘 native read/fsync 承诺耗时上限，也不为完整正文增加文件额度。

## 内容搜索

模型历史中的工作区 `read@4/search@3` 由[纯结果呈现](model-result.ts)去除重复 JSON、observation 和常规说明，原持久回执保持不变。读取按路径、实际起始行／选区／总行数、`next_line`、完整 baseline 后接所选原文；空窗口也保留起始行，不把中途读到 EOF 称为全文。搜索只呈现一份字面查询、范围／过滤／预览限制、本页返回数、准确 `next_cursor`、未检查计数及样例，再按文件呈现完整 baseline、全部返回匹配和上下文；前瞻匹配数不冒充总命中数。分页末页和零命中均不证明全局无引用。大 Artifact 完整核实后使用完整正文，不以有界 excerpt 替代；未知结构和新增不认识的限制保留原呈现。外部路径工具保留自己的原回执。确定性[呈现回归](../../../test/isolated/files/model-result.test.ts)覆盖真实编辑基线、窗口、分页、跳过、Unicode、原正文与 Artifact 保真。

`search_content` 当前定义版本为 3，`path` 可选择一个普通文件或目录；省略、空字符串和 `.` 选择工作区根。匹配仍为字面文本。模型默认每页 100 条、每个匹配／上下文行 2000 个 UTF-16 字符，`limit` 可设为 1–200，`max_line_chars` 为 1–10000；截断不拆代理对，返回 `truncated:true/originalLength`。用 `read_file` 的行窗口取得完整正文。底层 `WorkspaceFiles.search` 的这两个参数均可省略，以保留全部命中及完整长行；不把预览长度变成文件读取额度。

`glob` 筛选文件名，包含 `/` 时匹配相对所选目录的路径；`**/` 含零层目录。显式单文件以文件名匹配。`context_lines` 为 0–10，返回具名 `before/after` 行及真实行号，上下文同样遵循明确预览限制。遍历按完整相对路径排序，目录以 `name/` 与文件共同排序；找到下一条匹配才产生 `next`，其值是最后返回行的原路径／行号游标。后页须使用相同范围、文本和过滤条件；它不是跨外部文件变化的快照。

模型默认 `respect_ignore:true`。目录规则复用固定 `ignore` matcher，只读取搜索范围内各级 `.gitignore`，逐级使用本级相对路径，包含注释、目录、否定及父目录排除规则；所有规则文件均经原 native 安全读取，链接规则文件不读取。显式非根目录不继承范围外的祖先规则，显式单文件绕过普通 ignore；`respect_ignore:false` 包含普通忽略项。底层未指定该参数时保留原不使用普通 ignore 的行为。过滤不修改授权，protected／no-follow／根和文件身份检查始终有效。

二进制与非 UTF-8 内容分别计为 `binary/encoding` 并跳过，不再使其他文本结果丢失。普通忽略项和不跟随的链接／特殊对象也分别计为 `ignored/links`；目录忽略计一项，不宣称知道其后代文件数。有过滤、分页或跳过时，`scope.kind=current_page` 描述本次页实际遍历，返回计数与最多 20 个路径／原因样例。`scope.complete:false` 表示有未检查项或尚有结果后页，空 matches 不能解读为全工作区无匹配；后页诊断不累计此前页，也不宣称完整扫描未到达目录。过滤 glob 的范围由 `scope.filters` 明示。权限、根漂移、读取身份变化和其他 I/O 失败不当作二进制吞掉；失败仍沿当前 Tool 返回，常见路径／参数错误提供 `code` 和纠正信息，不获得重试或访问授权。

[搜索回归](../../../test/isolated/files/search.test.ts)覆盖单文件与目录、混合编码、稳定分页、上下文与代理对预览、根／嵌套 ignore 和显式范围优先级、实际工具默认、路径错误、protected 与链接及有界诊断。[读取响应性](../../../test/isolated/files/read-responsiveness.test.ts)和[查询响应性](../../../test/isolated/files/query-responsiveness.test.ts)继续核真实 macrotask 取消、独立读取、close drain、EOF 后匹配及最终枚举边界；平台资格仍按实际执行环境说明。

## Node-API 文件后端

文件工具的手写 Bun FFI 已由 [cap-std＋napi-rs 模块](../../../native/files/README.md)替换，[唯一加载器](../../files-native-binding.ts)保持原 `WorkspaceFileIo` 交接，TS 继续拥有完整字节／UTF-8、baseline、CAS、查询与 checkpoint 语义。Windows 由官方生成的 windows-sys 绑定补齐完整 FileID、原 HANDLE 路径与发布、私有创建和关闭未知；仅套用 cap-std 的 metadata／rename 不能满足这些边界。原 `files-native.ts/files-windows.ts` 已删除，没有旧后端回退；Profile／SQLite／Shell 等独立原生 owner 不随此迁移。

Agent build 将固定 CPU／平台的 `native/files/files.node`、ABI／来源／完整 hash manifest、Cargo.lock 和第三方许可证一同交付；加载前核无符号链接／单链接、平台、CPU、ABI 和完整字节哈希。缺少或改变资产明确失败，运行期不编译、不查找源码／环境变量替代。可信 `filesNativeAssets()` 让正式 Service 把加载器和整个 native companion 加入普通／外部文件及检查点保护，Full 也不开放。Windows 静态 CRT 的实际依赖仅为系统 DLL。源码开发要求固定 Rust 工具链及平台 linker，用户运行制品不需要 Rust。

Windows DLL 固定 `/DEPENDENTLOADFLAG:0x800`，将静态依赖解析限定 System32；搬迁测试核实际 PE 的准确平台、无 delay import 与加载标志，再实际加载，不把系统 DLL 名单当作搜索路径证明。链接标志适用系统及准确 API 合同归上述 native owner，不据此扩展产品支持系统集合。

2026-10-16，基于 `70cb5718` 的本任务未提交 diff，先在 `codex/native-files` 隔离验证，三方合回主工作区后复验。环境为实际 Windows x64／Bun1.4.2／Node24.15.0／Rust1.97.1 MSVC；下方43／63项等旧执行记录对应替换前后端，不能用于授予新后端资格。

- `bun test packages/agent/test/isolated/files/native-addon.test.ts packages/agent/test/isolated/files/windows.test.ts packages/agent/test/isolated/files/path-files.test.ts packages/agent/test/isolated/files/tool-paths.test.ts packages/agent/test/isolated/files/native-path-lifetime.test.ts packages/agent/test/isolated/files/native-packaged.test.ts packages/agent/test/isolated/files/built-large.test.ts apps/service/test/isolated/files-native-boundary.test.ts`：20项通过，覆盖真实原生读写／恢复、准确授权、GC、Bun／Node 空 PATH 搬迁加载、篡改拒绝、完整 Agent 包和默认 Service 的 Full 保护拒绝。新增链接数断言及 Service 类型修正另与完整 CI 合同整文件复验，共23项361断言通过。
- `bun test --timeout=30000 packages/agent/test/isolated/file-checkpoints/capture.test.ts`：19项267断言通过。首次与整包构建同时运行时三例达到默认5秒时限；未删断言，30秒单例时限的完整独立复验通过，平台 CI 使用同一时限。原恢复、新建反向删除、原 Run／Execution、取消、漂移和 unknown 均实际运行。
- `bun test --timeout=30000 packages/agent/test/isolated/files/recovery-primitives.test.ts packages/agent/test/isolated/storage/build.test.ts`：7项112断言通过。旧 Node fsync mock 迁到真实 Node-API 的 sync／close 交接点，实际 native IO 仍执行；独立字节包及 Store／Worker 包携带同次构建的 companion，Windows 在所属子进程退出后才清理已映射 DLL。POSIX 保文件／目录 symlink 和根替换断言；Windows 用真实 junction 与禁止根 rename 的原 HANDLE 合同，不要求改变机器的 symlink 特权。
- 在 [crate](../../../native/files/README.md)目录运行 `cargo fmt --check`、`cargo test --locked --lib`：4项真实 Windows 故障／8.3测试通过，包含取得后确认未知与关闭未知的原父链持有；`cargo check --locked --target x86_64-unknown-linux-gnu` 和 `--target aarch64-apple-darwin` 通过，只证明目标编译。Windows release 的 `dumpbin /dependents` 仅列系统 DLL，无 Rust／MSVC 运行时分发依赖。

最终主工作区将上述八文件连同 `recovery-primitives.test.ts`、`storage/build.test.ts`、`large.test.ts`、`artifact-cancel.test.ts` 整文件以 `bun test --timeout=30000` 同次运行：30项497断言通过。检查点 capture、change-preview、两份 Native 工具展示整文件另同次36项412断言通过；原生4项及完整 CI 合同21项332断言也在主工作区复验通过。

依赖加载标志固定后的最终 DLL 再对 native-packaged、native-addon、built-large、recovery-primitives、storage/build 五文件以相同命令整文件运行：10项203断言通过；新增7条 PE 断言实际核 `0x800`，`dumpbin /LOADCONFIG`也确认同值。该变化只限制 DLL 导入解析，文件业务与 TS／Rust 资源状态实现未变，前述其余结果按该范围复用。

Agent／Service／Desktop typecheck、原包边界与 API／测试归属、文档链接和新增 CI 合同已核对。[平台 workflow](../../../../../.github/workflows/platform-capability-probe.yml)接入 native／工具／恢复实际用例，但未 dispatch，不能声称远端三平台已通过。完整安装、全部客户端和其他平台继续保原门禁。

此前正式 `buildTerminalBundle` 被 nvm Bun 的原 owner 和 Bun1.4.2 delay imports 阻断。2026-10-17 的 [Terminal 构建修复](../../../../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现)在新私有输入与新 console 副本中完成受限导入转换，保留最终无 delay／System32／ACL 门禁；完整 Windows Terminal 已实际构建并全量核验。候选自带 Bun 在空 PATH 下通过公开 Files 入口发布、完整读回和删除1,450,000字节，实际加载同包 Node-API companion。原 nvm 权限拒绝保持；完整 installed／Native／三平台及发布资格仍独立验收。

## 模型工具路径

六个 Workspace 模型工具接受相对路径及当前 Workspace 内的绝对路径。`WorkspaceFiles.relativePath` 只按工厂固定的根转换，`createFileTools` 在实际 IO 和检查点 capture 前调用它；Shell 改变 cwd 不改变文件工具基准。list／glob／search 省略 path、传空字符串或 `.` 均选择根目录；Windows 另接受普通盘符绝对路径和相对路径的原生反斜杠。目录穿越段在转换前拒绝，其他盘符、UNC／设备路径和 Workspace 外目标不能借转换取得访问。

原 `WorkspaceFiles` IO 和字节恢复原语仍只接收相对路径，原目录对象锚定、reparse／symlink／短名、受保护路径和 baseline 检查继续生效。文件结果、变更预览与检查点 capture 使用转换后的相对路径；原模型调用、审批与执行记录保留原始参数。工具 schema 明确路径范围，绝对用户文件工具另保准确绝对目标契约，不借此扩大外部访问。设计理由见[路径分层决定](../../../../../.agents/notes/implemented/bug-fix/2026-10-16-workspace-tool-paths.md)。

[工具路径回归](../../../test/isolated/files/tool-paths.test.ts)实际调用全部六工具，核工作区绝对路径、目录默认、原生分隔符、准确 capture／结果及越界和保护拒绝；[真实 capture](../../../test/isolated/file-checkpoints/capture.test.ts)让同一路径的首个绝对调用和后续相对调用共用原 preimage／末 postimage。[Windows Core 用例](../../../test/isolated/files/windows.test.ts)经原 Runtime 实际列绝对工作区并读取绝对文件，将完整 Artifact 交给下一 Model。具体本机范围见下节。

## 绝对用户文件

同一公开入口的 [createPathFileTools](../path-files.ts) 新增 `files.read_path/files.write_path/files.edit_path`，read_path 定义版本2、write_path/edit_path 版本1，由正式宿主注册为 `builtin.files.path`。原 WorkspaceFiles IO 的 relative-only 路径合同不变；绝对 Tool 不是 Model 自报 root 或回退旧 filesystem authority。工厂冻结可信 `qualifiedPlatforms/protectedRoots`；保护根先逐项通过原路径校验，再按精确字符串去重、稳定排序，classifier 和快照使用同一集合边界。排列或重复不改变保护目标，真正增删目标仍改变快照；不宽松比较 Run 配置或自动迁移旧快照。只有显式合格的当前 native 平台才能执行；源码存在不提供 Win/Linux 实测资格。

[路径 request classifier](../../permissions/files-request.ts) 选择 canonical 绝对路径的真实物理父目录，通过 `WorkspaceFiles.inspectIdentity` 从实际 native IO 核 parent device/inode、目标 regular file 身份、本人 owner、单链接及完整原输入，并将其与可信边界一起纳入 revision。该可信 host 方法只检查元数据，不读取正文，不是新增 Model Tool；Windows 使用与 baseline 相同的 volume／128-bit FileID，不与 Node stat 的 dev/ino 混比，也不截断 FileID。父链符号链接、目标 symlink／hardlink、私有 Profile／凭据／控制资产和危险系统写入目标在 Full 模式也拒绝。实际派发证明由 UnifiedExecution 注入，Tool 逐项核全部父子 policy snapshot 的准确定义、版本、信任、hardAllowed 和同一 revision，再打开 native parent，并直接在这个已锚定的引擎上重核身份；独立探针不能代替实际 IO 对象，宿主或 Model 输入不能伪造该证明。

这些 Tool 复用原 `createFileTools/createWorkspaceFiles` 的完整 UTF-8、Artifact、文件 baseline 和原子 IO。仅把固定 basename 交给已选定物理 parent，不建立第二个写入引擎。绝对读取启用可信 `strictReads`，在原 FD 的读前／后核 owner 和单链接；这个选项不改变普通 Workspace 默认读取合同。write 的 `base=null` 只创建，existing base 核完整字节／hash／size／device／inode；edit 保原精确字面匹配和 occurrences，父对象或目标改绑拒绝。派发前取消零效果，发布后的同步或核实错误仍 `file_publish_outcome_unknown`，不能因包装成绝对路径降格为无效果失败。当前机制仍不承诺不合作外部编辑器的任意 rename／编辑原子 CAS。

read 请求的固定效果是安全 `read`；write/edit 是 `external`。请求批准对外部写入要求实际人类决定，自动审核使用真实 reviewer，Full 保危险／私有／native 资格等硬门槛；child 另受准确父工具集合和全部权限 ceiling。完整策略由[权限 owner](../../permissions/README.md)维护。结果中的 path 与 fileChange 是实际绝对路径，保存的 `fileScope=external_path/workspaceCheckpoint=false` 明确排除 Workspace checkpoint 捕获、恢复和回退；外部文件成功不冒认为 Workspace 恢复点。

此前 macOS 工作树执行 [path-files](../../../test/isolated/files/path-files.test.ts) 与原 [files](../../../test/isolated/files/files.test.ts) 完整叶文件，共9项、77断言通过：真实 native IO／Runtime 派发、完整 BOM／CRLF、create/edit/CAS、父目标换绑、Profile symlink／hardlink 别名、交集漂移、取消和未合格平台拒绝。原 [subagent 终端](../../../../../tests/tui-system/scenarios/subagent-approval.test.ts) 整文件9项120断言及 [tool-approve](../../../../../tests/tui-system/scenarios/tool-approve.test.ts) 整文件1项12断言证明正式 Service 真实批准／自动审核后写入、拒绝零效果和外部摘要不泄露正文。Linux 实际验证、发布 RSS／观测和整体阶段门禁不由这些本机证据解除。

2026-10-16 在 Windows x64／Bun1.4.2、基于 `77662488` 的未提交 diff，先复现外部 path-files 的 `file_dispatch_scope_changed` 和私有 Profile 夹具失败。统一原生身份后，`bun test --parallel=1 --max-concurrency=1 packages/agent/test/isolated/files/path-files.test.ts` 整文件8项122断言通过：包含真实工作区外的 Full／人工批准写入、批准前和拒绝后零效果、原持久回执、超过1MiB的完整 Artifact／下一 Model 正文、合法大小写及非法 Windows 路径拒绝。Profile 夹具用正式 `privateDirectory` 新建私有目录，不修复既有 ACL。普通 files 的两个 symlink 夹具仍受本机创建权限限制；本轮证据不证明正式安装版、完整 Service／客户端或全部平台资格。

同轮相邻验证覆盖9个叶文件、63个不同用例，包括 [native path lifetime](../../../test/isolated/files/native-path-lifetime.test.ts) 在真实 `NtSetInformationFile(FileRenameInformation=10)` 前强制 GC，保原 rename／disposition 的借用内存。首轮与三个 typecheck 并行时，一个旧检查点恢复用例触发5秒超时；资源释放后单独重跑 capture 整文件19项267断言全部通过，该用例4.31秒，没有提高时限或修改恢复实现。其余44项在首轮全部通过；Agent／Service／Desktop typecheck、文档、测试归属与执行边界检查通过。这些分批结果不写成单次全套通过。

低层 `WorkspaceFiles.read(path,{offset?,limit?})` 缺省返回完整 UTF-8 正文，offset 从 1 开始；省略 limit 读取全部剩余行，显式 limit 按行选择。页内容保留 BOM/CRLF/最终换行，并返回 fromLine/toLine/totalLines/nextOffset；超出末尾返回空正文和 null toLine，空文件为 0 行。每页仍读取并校验完整字节，以完整 SHA256/字节大小/device/inode 建立基线，绝不以页正文替代文件基线。read Tool 版本为 4，缺省页为 200 行，write/edit/search/glob 为 2，list 为 1；旧 schema/执行历史保持自己的版本。非法 UTF-8 明确错误；BOM 与 CRLF 保留，写入不进行编码猜测。`write` 的 `base` 必填，null 只准创建，其他值必须与当前完整字节和文件对象完全一致。`edit` 使用同一基线，并要求非重叠字面匹配数量精确等于 occurrences。写入先在同一目录创建独有临时文件、写全并同步，再次验证基线，最后原子替换或 create-only 发布并核实原对象。POSIX 使用文件 fsync、create-only hardlink 和目录 fsync；Windows 的同步与发布边界见下节。失败不保证没有效果，例如原子发布后的同步或外部改写可能导致错误。

POSIX 使用目录 FD 与 no-follow openat 逐段锚定路径，macOS 调用非 variadic `__openat`。相对路径禁止 `..`、`.`、绝对路径和反斜线；根与目标链均不跟随符号链接，不读取设备/FIFO/目录作为正文。根目录替换后原对象不被重新解释成另一权限目标。临时文件清理不会覆盖原发布结果。目录描述符设置 close-on-exec。Windows x64 的独立原 HANDLE 后端见下节，其他不支持的平台仍明确 `file_platform_unsupported`。

## Windows Workspace 文件源码

[平台交接](../files-io.ts)让同一个 `WorkspaceFiles` 语义层使用 [Node-API 原资源 owner](../../../native/files/README.md)。正式 Service／六工具、完整 Artifact／Model 正文和检查点 restore／remove 沿原公开入口使用该后端；不增加第二套工具、权限来源、恢复状态或旧 filesystem fallback。源码接入不等于原生、全部正式客户端或安装制品资格已通过。

Windows 工厂当前接受 x64 本地盘符下的 canonical Workspace，其他架构或路径范围不从源码接入推定可用。工厂固定当前 token SID 和 System DLL，只在实际创建能力时加载。它持有原根及祖先目录 HANDLE，以 `NtCreateFile` 的原父 HANDLE 逐段打开，不跟随 reparse；普通 Workspace 使用已有 DACL，不修 ACL。新 temporary 与 POSIX 的 0600 对应，使用当前 SID 私有权限。完整 baseline 使用实际 volume、128-bit FileID、完整 EOF／hash／size，并比较原 HANDLE 的 LastWriteTime 与 ChangeTime。字节恢复及外部路径的严格身份检查要求父目录和文件的当前 SID owner、文件单链接；普通 Workspace 默认读取保宿主已有权限。

组件拒绝 ADS、DOS 设备名、尾点／空格及非规范路径。实际原 HANDLE 的 canonical 长名对照拒绝 8.3 别名；保护范围按实际组件与 Windows 大小写等价核对，普通合法大小写变体仍可读取同一对象。目录枚举使用原 HANDLE，保护范围与原分页、search、glob 语义共用。未知类型、对象漂移、关闭或内存释放未确认均保明确失败，不从数字 HANDLE 重建资源。

发布先完整写入和 flush 原 temporary，再核准确基线，从原 temporary HANDLE 向原父 HANDLE 相对 rename；create-only 不覆盖，replace 明确替换。删除由原对象 HANDLE 的 disposition、真实 close 及缺失确认组成。发布／删除后的确认或关闭失败保 `file_publish_outcome_unknown`；未知原资源强持整个 owner 及父链，`close` 不宣称释放成功。Windows 的 file flush 与目录身份复核不等于 POSIX directory fsync，也未证明断电持久性；该限制和平台验收保留，不能由异常注入或本机 POSIX 测试替代。API依据见 [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)和 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。

发布的相对 rename 使用 `NtSetInformationFile(FileRenameInformation=10)`，将准确原父 HANDLE 放入 `FILE_RENAME_INFORMATION.RootDirectory`，沿同步原 temporary HANDLE 核 native 返回与 `IO_STATUS_BLOCK`；不退回绝对名称 rename。[官方 ABI](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile)说明对应结构与信息类别。2026-10-16 的实际 Windows x64 用例复现原 Win32 wrapper 返回 errno87，改用 native 调用后原字节恢复及六工具路径用例可完成；正式 Service／全部客户端、安装和故障资格仍按原门禁保留。

同日本机 [capture 整文件](../../../test/isolated/file-checkpoints/capture.test.ts)19项267断言通过，首个绝对路径与后续相对路径保同一个准确文件及原检查点。冷回放夹具显式关闭自己创建的 serial-lock owner 后再删目录，修复原 Windows `EBUSY` 收尾失败；没有改变生产关闭顺序或把清理失败算作通过。

[Windows 完整能力用例](../../../test/isolated/files/windows.test.ts)在 actual win32 强制运行六工具、真实 Core 大正文、binary 恢复与 Windows 路径保护，不作 backend availability skip。2026-10-16 在 Windows x64／Bun1.4.2，基于 `84b17867` 的本轮未提交 diff，本次路径、变更预览、检查点与 Native 工具展示六文件43项535断言通过（正常用户权限，51.69秒，包含实际会话的重复反斜杠输入），包含原生六工具、字节恢复、绝对路径 Core／完整 Artifact 和真实组件 DOM。原用例的 CRLF 搜索断言改为保留实际 `\r`，大正文夹具明确超过1MiB后才断言 Artifact，未降低验证要求。该结果不证明正式安装、完整 Service／客户端或其他平台。共享默认装配及恢复后新 Store 的原验证范围由[当前进度](../../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-普通-files-与检查点恢复源码)记录。取舍与剩余原生验收见[原 HANDLE 提案](../../../../../.agents/notes/proposed/architecture/2026-10-10-windows-workspace-files-owned-handles.md)。

Model 可调用的 `files.read/files.read_path` 缺省 `limit=200`，通过 `selection.nextOffset` 续读；显式 limit 保原请求。该默认页仅控制返回范围，不改变低层全文读取、完整文件验证或累计读取能力。

默认没有整文件、原文、搜索匹配数或长行总额度。读取使用固定 64 KiB 字节块，严格增量 UTF-8 解码、完整 hash 与前后 FD 事实校验；默认 read 返回全部剩余行。宿主显式 `maxFileBytes` 可声明该宿主的单文件能力约束，未设置时不回退为旧 8 MiB。真实内存、磁盘、IO 与字符串表示能力仍可能局部失败，不把它们假装 Provider 窗口。二进制控制字节采样检查和严格 UTF-8 保留，BOM/CRLF 不规范化；search 不将已识别二进制当文本。

search 未指定 limit 返回全部匹配；显式 limit<=200 给出完整 next keyset，path/line 稳定排序。glob 的 **/ 匹配零或多层目录，页 limit<=200，完整路径 keyset；去除旧目录数、访问项数门槛，遍历不跟随 symlink，不执行 shell/rg。glob 按目录名加 `/` 与文件名的完整路径顺序深度遍历，取得准确的 limit+1 个匹配后结束本页；仅完整的字面目录前缀可排除不可能匹配的分支。无斜杠的 basename 模式仍跨层匹配，未新增忽略目录、扫描上限或结果截断。list 仍使用明确名字分页；跨页外部变化不构成一致快照。未知目录项类型明确 file_directory_type_unavailable。

glob/search 的原生操作仍绑定原根及 FD 链；遍历每64项或累计8ms检查一次批次，让出真实事件循环，避免一个 child 的文件查询阻挡其他 Run、HTTP 和等待定时器。yield 前关闭本次目录／文件 handles，恢复后重新核根和关闭状态；可信宿主第二参数的 signal 来自原 ToolContext，取消不成为 Model 输入或额外权限。单次原生枚举和单文件读取仍是同步操作，该批次不是单次 IO 的硬时限。[响应与取消回归](../../../test/isolated/files/query-responsiveness.test.ts)用自有真实小树核宏任务期间独立读取、原 Tool 取消、完整路径分页、保护范围及符号链接；不调用 Provider。

普通 Tool 的小结果内联 JSON；大 read/search 等结果通过真实 `context.artifacts.publish` 保存完整不可变正文。read Artifact 是完整所选 UTF-8 正文，summary 保留完整文件 baseline/selection；search Artifact 是完整结果 JSON。结果包含准确 Artifact refs、`body.complete=true` 和 `inlineBody=false`，这表示完整正文已保存；通用 `modelContent` 另指向相同准确正文，Core 完整校验后将其送入实际下一 Model 请求。没有 Artifact 能力时明确 artifact_publication_unavailable，不把摘要冒充全文。read/write/edit/search/glob 的新定义版本保留行为差异；write 的 contentArtifact、edit 的 findArtifact/replaceArtifact 接受准确原 scope 的完整 UTF-8 Artifact，与对应 inline 参数互斥，不能凭 hash 或猜当前 scope 读取。

文件写入先校验原完整基线、再临时发布。发布后同步/读取失败返回 file_publish_outcome_unknown；Tool 保留 outcome_unknown，不把已发生替换假报为零效果失败。

`write/edit` 的 `file_baseline_conflict` 解释本次基线或仅创建前置条件被拒绝、本次没有发布，但不返回当前文件正文。基线描述完整文件的身份与版本；冲突不证明另一编辑修改了同一段文字，须按各次请求的修改和各自回执区分。此前读取只代表当时观察，不能从冲突推断文件仍保留旧值；其他已经成功的操作不会回滚。后续另获授权的新编辑先读取当前文件并使用新完整基线，错误说明本身不授权重读或重做。绝对用户文件工具复用这项结果语义；发布后确认失败仍保留原 unknown。

## 逐操作文件变更预览

普通 UTF-8 write/edit 在最后一次基线验证保存实际完整 preimage，publish/fsync 后读取实际 postimage，并核其完整内容和发布 FD 的 dev/inode；确认漂移保留 `file_publish_outcome_unknown`。成功 [FileSnapshot](../files.ts)带 `change`，由迁入的原 [共同前后缀行差异](../files-diff.ts)生成行号与增删内容。新建或内容不变展示真实写入内容；不是 Git diff、LCS 或 Shell/外部编辑捕获。每次操作独立保存，不合并为累计贡献。

[Tool wrapper](../files-tools.ts)保持 write/edit 版本2及原 Model 的 `path/baseline` 字段，将可选中立 `FileChangePreview` 放入 `ToolResult.details.fileChange`：version1、format、path、before/after 完整 baseline、text 和 truncated。预览最多65536 UTF-8 bytes，截在完整字符边界；这个额度只限制展示 receipt，不限制文件 IO、完整 baseline、Model 读写正文或 Artifact。before/after capture 最后保存失败和派发后确认失败仍 unknown，不发布可用成功预览；read/search/glob、字节恢复及未装配该预览的工具不伪造记录。消费者须核原 succeeded Execution/Run/结果 revision，旧或未知格式明确不可读。

read/write/edit 的 Model JSON 结果另带当前真实 `executionId/runId`，供计划 receipt 等消费者定位准确保存记录；ID 本身不证明成功、授权、验证结果或 Workspace checkpoint。消费者仍须读取并核准确原定义、Run／Session／Store、终态和结果 revision，不能用同名 call 或最新执行替换。

没有新增 SQL 表、Store major、维护资产或 Model 工具权限。恢复检查点保首 preimage 与末 postimage，只服务准确恢复，不能冒充每次操作的差异。长期边界见[迁移决定](../../../../../.agents/notes/implemented/architecture/2026-10-08-native-file-change-receipts.md)。[真实预览与 Core receipt 测试](../../../test/isolated/files/change-preview.test.ts)核完整 BOM/CRLF pre/post、外部后改不改变历史、数 MiB 完整写入与 UTF-8 截断、失败/unknown 不保存成功预览，以及跨 Run 重复 call ID 的唯一原 source；各客户端实际资格由 owner 和进度维护。

路径和字节现在通过 Node-API 的有主数据进入 Rust，原生读取返回有主缓冲后复制到 TS 解码块；不再把临时 Buffer 的数字地址传给 Bun FFI。[路径寿命回归](../../../test/isolated/files/native-path-lifetime.test.ts)在实际 Node-API open/read/write/publish/unlink 前后强制 GC，验证完整字节、原 inode、创建与删除。捕获测试另核三条真实成功 Tool 回执与 first/last 的准确原 Execution ID，不把第二条单独成功误当成两次成功捕获。

文件系统不是 SQLite 事务：不合作的外部编辑器可能在最后一次基线核对与 rename 之间修改目标或移动目录，无法宣称任意外部 rename/编辑原子 CAS。当前机制绑定原目录对象，合作宿主可装配 Workspace serial 许可；不会创建另一个持久授权或文件状态机。

真实测试在 `test/isolated/files`：内容与 inode CAS、创建冲突、精确 edit、UTF-8/BOM/大小拒绝、symlink 越界拒绝、分页与搜索；固定模型经 Runtime/UnifiedExecution 实际写读，未知工具及权限拒绝零文件写。`test/isolated/storage/build.test.ts` 单独构建公开入口与 Worker/SQL，验证构建文件可执行。

当前叶子已去除旧正文额度并提供实际大正文 Artifact；Runtime 已通过[通用正文交接](../../model-body/README.md)在下一 Model 请求完整校验并展开准确 body，真实 Core 回归证明固定 Model 收到全文。便携 read/write/edit 仍以完整 JS 字符串表达正文，受真实平台表示/内存能力影响；Artifact stream 接口以固定块保存/读取，不设累计产物额度。正式默认装配和外部读取范围由上层 owner 负责。

[产品语义测试](../../../test/isolated/files/product.test.ts)验证行续读完整 hash、同 mtime 的未选中正文变化、glob 根/深层/分页/逃逸与真实 UnifiedExecution 拒绝零适配器 I/O。[完整独立制品测试](../../../../../tests/isolated/unified-agent/built-package.test.ts)同次构建所有 manifest 入口和资产后在源码树外实际执行文件行读取/glob，而非仅 import 成功。当前本地证据为 macOS；Linux/Windows 和安装制品资格分开验证。


[大正文回归](../../../test/isolated/files/large.test.ts)验证超过 8 MiB 的完整内容、完整 hash、原文级 edit、旧匹配/长行/文件数门槛解除，以及真实 UnifiedExecution 的 scoped Artifact 写入与全文产物、权限拒绝零 File IO。

[正文读取中的取消](../../../test/isolated/files/artifact-cancel.test.ts)验证真实 scoped Artifact 读取等待期间取消原 Command，返回后不发布文件。[大正文独立制品](../../../test/isolated/files/built-large.test.ts)在源树外同次构建全部 manifest 入口和 Worker/guardian 资产，实际运行 9 MiB 文件与超过 16 MiB 的 Artifact stream，不使用源码 fallback。


可信宿主另可调用 `readBytes(path,{maxBytes})`、`restore({path,bytes,base,maxBytes})` 和 `remove({path,base,maxBytes})`。每次必须声明正安全整数字节预算，实际读取和恢复同时受该预算及宿主已有 maxFileBytes 约束；不对普通 UTF-8 read/write/edit 增加默认总额度。FileByteSnapshot 保存完整 Uint8Array 与原完整 baseline，二进制、非法 UTF-8、BOM、CRLF 均按字节保留，不进行文字编码或 EOL 转换。restore 的 base=null 只准 create-only；remove 必须使用准确已观察 existing baseline，不把缺失当成功。

这些原语仅提供文件能力，不自动装配 Model Tool、审批、恢复点、SQL 状态或执行权。新的只读和恢复路径核原根及目录链 FD、同 uid 的 regular file、nlink=1 和完整 hash/size/device/inode，拒绝 symlink、hardlink、目录、外来文件对象及内容漂移。可信宿主可显式传入 `protectedPaths` 相对目录/文件前缀；禁绝绝对、dot/dotdot、空根路径，规范化后按完整组件匹配（`.git` 不匹配 `.gitignore`），所有三个字节原语均拒绝该 scope。该配置不来自 Model、JSONC 或 HTTP；宿主负责提供真实保护目录，未知保护事实不构成准许依据。原普通 write/edit 合同保持。

可信宿主可以明确选择 `protectReads:true`，将同一保护范围用于普通 read/write/edit、list/search/glob；默认 false 保原普通合同。显式受保护子 scope 在读取前拒绝，枚举根目录时过滤准确受保护子项，搜索不遍历它们，不因保护 `.git` 而排除 `.gitignore` 或相邻文件。选项在工厂固定，不由 Tool input、JSONC 或 HTTP 提供。默认 Service checkpoint scope 开启该选项，保护 canonical profile/协调路径及实际运行 loader 资产；不存在的可信 companion 路径保留 deny 范围，不据此宣称资产已经存在。

restore 复制 caller bytes，先核基线、同目录私有 temp 写全/fsync、再核基线与根，原子发布后 fsync 目录并核完整字节及原发布 inode。remove 核完整基线后仅 unlinkat 原 anchored parent 的准确文件名，fsync 并确认缺失；任何发布/unlink 后同步或确认错误保留 `file_publish_outcome_unknown`。没有多文件原子恢复保证；不合作外部 writer 在最终核对与 rename/unlink 之间的竞态仍存在，dirfd 不能宣称替代它的锁。原语不捕获 Shell/外部修改，也不构成文件 checkpoint 产品交付。

[恢复原语测试](../../../test/isolated/files/recovery-primitives.test.ts)使用真实 macOS Workspace，覆盖完整 binary/BOM/CRLF、有限读取、内容与 inode CAS、反向删除、根改绑、保护组件及不安全对象拒绝。独立进程在真实 fsync 前/后注入失败，证明发布前零写、核对前外部漂移拒绝、已发布 restore/create/remove 保留 unknown 和 temp 清理；源码树外 built 公共入口实际恢复/删除原字节，无 TS fallback。此证据不外推 Windows 或 Linux qualification，也不证明任意外部 writer 原子 CAS。

[Checkpoint business leaf](../../business/file-checkpoints/README.md)提供 `createFileCheckpointing`，沿原 builtin.files namespace 可选接入可信 before/after capture。普通未注入 Tools 保持原行为；注入后保存首个 confirmed preimage 的完整原 scoped Artifact 与末 postimage，封存失败不冒可恢复，发布后错误仍 outcome_unknown。该 leaf 当前只读/blocked intent 范围与尚未闭合的完整恢复边界见对应 owner。

### 检索与读取观察数据

真实搜索结果附 `query`（规范化相对 path、准确 text/glob/ignore、原 after 及本次有效分页／预览参数）、`stats` 和 `files`。`stats.checkedTextFiles` 是本页成功读取并验证为文本的文件数，不包含读取 ignore 规则的附带操作；`matchedFiles/matches` 计本页游标之后实际遇到的命中文件／行，包括为判断 `next` 多取的一条，`returnedMatches` 才是实际返回行数。文件可能已完整读取，但找到后页证据后不再扫描其余行，统计不代表全查询总量。`files` 只列已返回命中的文件，各 path 一次，baseline 来自该次真实读取；不为后页预读命中或未返回文件声明来源。零命中、后页或跳过范围会有简短 `feedback`，提示改查入口／范围或按原游标续读，不推断当前实现可达、业务完成或允许重放。

模型 read/search 的 JSON 正文还附纯数据 `observation`：`kind=inspection/lookup`、规范相对 `scope`、search 的完整 query JSON 字符串、`sources[{path,version,fromLine?,toLine?}]` 及 `complete/coverage`。version 是原完整文件 hash，read 的行号来自实际 selection；search 来源仅取上述返回文件。`complete` 指本次是否覆盖整个文件或从头完整检索的所选查询范围，不证明任务成功。read 的局部或尾部窗口为 `coverage=window/complete=false`，`windowComplete=true` 只证明所选正文完整返回；整文件为 `coverage=file`。search 为 `coverage=page`，有原 after、next 或跳过项时 complete 为 false。大 read 沿既有完整 Artifact 正文协议，有限 JSON 摘要保留 observation。旧结构适配器未提供真实 query/files 或 baseline 时不补造观察数据。所有观察均为工具拥有的低信任结果，不授予读取、执行或解除 unknown 的权限。

read 的 observation 另含 `excerpt:{text,truncated}`：仅取本次真实选区正文的前 2000 个 UTF-16 字符，不拆代理对。它是给接收方对照原句的有限片段，不是完整文件，也不改变 `coverage/complete/windowComplete` 的含义；即使片段未截断，局部窗口仍不是整文件。大 read 的有限 JSON 元数据保留该片段，原 Artifact 正文保持完整原字节。

每次 search 的反馈都说明：字面匹配只覆盖本次明确范围与过滤条件，扫描完整不证明调用可达、没有其他实现或没有不同写法的引用。查询含 `|`、`.*` 或字面 `\\b` 时补充具体说明：这些符号按原字符串匹配，不是 OR、通配或词边界；需要测试不同词时分别查询。提示不改变匹配、不拒绝请求、不增加正则能力、执行权或次数限制。
