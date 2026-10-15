# Workspace 文件 leaf

公开入口 `@kite-ai/agent/files` 的 import 不打开资源。宿主显式调用 `createWorkspaceFiles({root,maxFileBytes?})` 选定一个物理 Workspace 根，再用 `createFileTools(files)` 将六个普通 ToolDefinition 装配进扩展；工具仍走 UnifiedExecution 的权限、来源复查、计划、派发和终态。没有 CodingAgent、Git 或旧 filesystem authority 依赖。

## 绝对用户文件

同一公开入口的 [createPathFileTools](../path-files.ts) 新增 `files.read_path/files.write_path/files.edit_path`，定义版本1，由正式宿主注册为 `builtin.files.path`。原 WorkspaceFiles 的 relative-only 路径合同不变；绝对 Tool 不是 Model 自报 root 或回退旧 filesystem authority。工厂冻结可信 `qualifiedPlatforms/protectedRoots`；保护根先逐项通过原路径校验，再按精确字符串去重、稳定排序，classifier 和快照使用同一集合边界。排列或重复不改变保护目标，真正增删目标仍改变快照；不宽松比较 Run 配置或自动迁移旧快照。只有显式合格的当前 native 平台才能执行；源码存在不提供 Win/Linux 实测资格。

[路径 request classifier](../../permissions/files-request.ts) 选择 canonical 绝对路径的真实物理父目录，核 parent device/inode、目标 regular file 身份、本人 owner、单链接及完整原输入，并将其与可信边界一起纳入 revision。父链符号链接、目标 symlink／hardlink、私有 Profile／凭据／控制资产和危险系统写入目标在 Full 模式也拒绝。实际派发证明由 UnifiedExecution 注入，Tool 逐项核全部父子 policy snapshot 的准确定义、版本、信任、hardAllowed 和同一 revision，再打开并锚定 native parent，重核身份；宿主或 Model 输入不能伪造该证明。

这些 Tool 复用原 `createFileTools/createWorkspaceFiles` 的完整 UTF-8、Artifact、文件 baseline 和原子 IO。仅把固定 basename 交给已选定物理 parent，不建立第二个写入引擎。绝对读取启用可信 `strictReads`，在原 FD 的读前／后核 owner 和单链接；这个选项不改变普通 Workspace 默认读取合同。write 的 `base=null` 只创建，existing base 核完整字节／hash／size／device／inode；edit 保原精确字面匹配和 occurrences，父对象或目标改绑拒绝。派发前取消零效果，发布后的同步或核实错误仍 `file_publish_outcome_unknown`，不能因包装成绝对路径降格为无效果失败。当前机制仍不承诺不合作外部编辑器的任意 rename／编辑原子 CAS。

read 请求的固定效果是安全 `read`；write/edit 是 `external`。请求批准对外部写入要求实际人类决定，自动审核使用真实 reviewer，Full 保危险／私有／native 资格等硬门槛；child 另受准确父工具集合和全部权限 ceiling。完整策略由[权限 owner](../../permissions/README.md)维护。结果中的 path 与 fileChange 是实际绝对路径，保存的 `fileScope=external_path/workspaceCheckpoint=false` 明确排除 Workspace checkpoint 捕获、恢复和回退；外部文件成功不冒认为 Workspace 恢复点。

本次 macOS 当前工作树执行 [path-files](../../../test/isolated/files/path-files.test.ts) 与原 [files](../../../test/isolated/files/files.test.ts) 完整叶文件，共9项、77断言通过：真实 native IO／Runtime 派发、完整 BOM／CRLF、create/edit/CAS、父目标换绑、Profile symlink／hardlink 别名、交集漂移、取消和未合格平台拒绝。原 [subagent 终端](../../../../../tests/tui-system/scenarios/subagent-approval.test.ts) 整文件9项120断言及 [tool-approve](../../../../../tests/tui-system/scenarios/tool-approve.test.ts) 整文件1项12断言证明正式 Service 真实批准／自动审核后写入、拒绝零效果和外部摘要不泄露正文。Win/Linux 的实际验证依用户安排后置，发布 RSS／观测和整体阶段门禁不由这些本机证据解除。

`read(path,{offset?,limit?})` 缺省返回完整 UTF-8 正文，offset 从 1 开始；省略 limit 读取全部剩余行，显式 limit 按行选择。页内容保留 BOM/CRLF/最终换行，并返回 fromLine/toLine/totalLines/nextOffset；超出末尾返回空正文和 null toLine，空文件为 0 行。每页仍读取并校验完整字节，以完整 SHA256/字节大小/device/inode 建立基线，绝不以页正文替代文件基线。read Tool 版本为 3，write/edit/search/glob 为 2，list 为 1；旧 schema/执行历史保持自己的版本。非法 UTF-8 明确错误；BOM 与 CRLF 保留，写入不进行编码猜测。`write` 的 `base` 必填，null 只准创建，其他值必须与当前完整字节和文件对象完全一致。`edit` 使用同一基线，并要求非重叠字面匹配数量精确等于 occurrences。写入先在同一目录创建独有临时文件、写全并同步，再次验证基线，最后原子替换或 create-only 发布并核实原对象。POSIX 使用文件 fsync、create-only hardlink 和目录 fsync；Windows 的同步与发布边界见下节。失败不保证没有效果，例如原子发布后的同步或外部改写可能导致错误。

POSIX 使用目录 FD 与 no-follow openat 逐段锚定路径，macOS 调用非 variadic `__openat`。相对路径禁止 `..`、`.`、绝对路径和反斜线；根与目标链均不跟随符号链接，不读取设备/FIFO/目录作为正文。根目录替换后原对象不被重新解释成另一权限目标。临时文件清理不会覆盖原发布结果。目录描述符设置 close-on-exec。Windows x64 的独立原 HANDLE 后端见下节，其他不支持的平台仍明确 `file_platform_unsupported`。

## Windows Workspace 文件源码

[平台分派](../files-io.ts)让同一个 `WorkspaceFiles` 语义层使用 POSIX 原 FD 或 [Windows 原 HANDLE owner](../files-windows.ts)。正式 Service／六工具、完整 Artifact／Model 正文和检查点 restore／remove 沿原公开入口使用该分派；不增加第二套工具、权限来源、恢复状态或旧 filesystem fallback。Windows 源码接入不等于原生、全部正式客户端或安装制品资格已通过。

Windows 工厂当前接受 x64 本地盘符下的 canonical Workspace，其他架构或路径范围不从源码接入推定可用。工厂固定当前 token SID 和 System DLL，只在实际创建能力时加载。它持有原根及祖先目录 HANDLE，以 `NtCreateFile` 的原父 HANDLE 逐段打开，不跟随 reparse；普通 Workspace 使用已有 DACL，不修 ACL。新 temporary 与 POSIX 的 0600 对应，使用当前 SID 私有权限。完整 baseline 使用实际 volume、128-bit FileID、完整 EOF／hash／size，并比较原 HANDLE 的 LastWriteTime 与 ChangeTime。只有字节恢复要求父链及文件的当前 SID owner 和单链接；普通文件读取保宿主已有权限。

组件拒绝 ADS、DOS 设备名、尾点／空格及非规范路径。实际原 HANDLE 的 canonical 长名对照拒绝 8.3 别名；保护范围按实际组件与 Windows 大小写等价核对，普通合法大小写变体仍可读取同一对象。目录枚举使用原 HANDLE，保护范围与原分页、search、glob 语义共用。未知类型、对象漂移、关闭或内存释放未确认均保明确失败，不从数字 HANDLE 重建资源。

发布先完整写入和 flush 原 temporary，再核准确基线，从原 temporary HANDLE 向原父 HANDLE 相对 rename；create-only 不覆盖，replace 明确替换。删除由原对象 HANDLE 的 disposition、真实 close 及缺失确认组成。发布／删除后的确认或关闭失败保 `file_publish_outcome_unknown`；未知原资源强持整个 owner 及父链，`close` 不宣称释放成功。Windows 的 file flush 与目录身份复核不等于 POSIX directory fsync，也未证明断电持久性；该限制和平台验收保留，不能由异常注入或本机 POSIX 测试替代。API依据见 [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)和 [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。

[Windows 完整能力用例](../../../test/isolated/files/windows.test.ts)在 actual win32 强制运行六工具、真实 Core 大正文、binary 恢复与 Windows 路径保护，不作 backend availability skip；本机 macOS 未运行这些原生用例。共享原完整文件、正式默认装配及恢复后新 Store 的验证范围由[当前进度](../../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10windows-普通-files-与检查点恢复源码)记录。取舍与剩余原生验收见[原 HANDLE 提案](../../../../../.agents/notes/proposed/architecture/2026-10-10-windows-workspace-files-owned-handles.md)。

默认没有整文件、原文、搜索匹配数或长行总额度。读取使用固定 64 KiB 字节块，严格增量 UTF-8 解码、完整 hash 与前后 FD 事实校验；默认 read 返回全部剩余行。宿主显式 `maxFileBytes` 可声明该宿主的单文件能力约束，未设置时不回退为旧 8 MiB。真实内存、磁盘、IO 与字符串表示能力仍可能局部失败，不把它们假装 Provider 窗口。二进制控制字节采样检查和严格 UTF-8 保留，BOM/CRLF 不规范化；search 不将已识别二进制当文本。

search 未指定 limit 返回全部匹配；显式 limit<=200 给出完整 next keyset，path/line 稳定排序。glob 的 **/ 匹配零或多层目录，页 limit<=200，完整路径 keyset；去除旧目录数、访问项数门槛，遍历不跟随 symlink，不执行 shell/rg。显式分页仅保留该页候选，不把下一页隐去。list 仍使用明确名字分页；跨页外部变化不构成一致快照。未知目录项类型明确 file_directory_type_unavailable。

普通 Tool 的小结果内联 JSON；大 read/search 等结果通过真实 `context.artifacts.publish` 保存完整不可变正文。read Artifact 是完整所选 UTF-8 正文，summary 保留完整文件 baseline/selection；search Artifact 是完整结果 JSON。结果包含准确 Artifact refs、`body.complete=true` 和 `inlineBody=false`，这表示完整正文已保存；通用 `modelContent` 另指向相同准确正文，Core 完整校验后将其送入实际下一 Model 请求。没有 Artifact 能力时明确 artifact_publication_unavailable，不把摘要冒充全文。read/write/edit/search/glob 的新定义版本保留行为差异；write 的 contentArtifact、edit 的 findArtifact/replaceArtifact 接受准确原 scope 的完整 UTF-8 Artifact，与对应 inline 参数互斥，不能凭 hash 或猜当前 scope 读取。

文件写入先校验原完整基线、再临时发布。发布后同步/读取失败返回 file_publish_outcome_unknown；Tool 保留 outcome_unknown，不把已发生替换假报为零效果失败。

## 逐操作文件变更预览

普通 UTF-8 write/edit 在最后一次基线验证保存实际完整 preimage，publish/fsync 后读取实际 postimage，并核其完整内容和发布 FD 的 dev/inode；确认漂移保留 `file_publish_outcome_unknown`。成功 [FileSnapshot](../files.ts)带 `change`，由迁入的原 [共同前后缀行差异](../files-diff.ts)生成行号与增删内容。新建或内容不变展示真实写入内容；不是 Git diff、LCS 或 Shell/外部编辑捕获。每次操作独立保存，不合并为累计贡献。

[Tool wrapper](../files-tools.ts)保持 write/edit 版本2及原 Model 的 `path/baseline` 字段，将可选中立 `FileChangePreview` 放入 `ToolResult.details.fileChange`：version1、format、path、before/after 完整 baseline、text 和 truncated。预览最多65536 UTF-8 bytes，截在完整字符边界；这个额度只限制展示 receipt，不限制文件 IO、完整 baseline、Model 读写正文或 Artifact。before/after capture 最后保存失败和派发后确认失败仍 unknown，不发布可用成功预览；read/search/glob、字节恢复及未装配该预览的工具不伪造记录。消费者须核原 succeeded Execution/Run/结果 revision，旧或未知格式明确不可读。

read/write/edit 的 Model JSON 结果另带当前真实 `executionId/runId`，供计划 receipt 等消费者定位准确保存记录；ID 本身不证明成功、授权、验证结果或 Workspace checkpoint。消费者仍须读取并核准确原定义、Run／Session／Store、终态和结果 revision，不能用同名 call 或最新执行替换。

没有新增 SQL 表、Store major、维护资产或 Model 工具权限。恢复检查点保首 preimage 与末 postimage，只服务准确恢复，不能冒充每次操作的差异。长期边界见[迁移决定](../../../../../.agents/notes/implemented/architecture/2026-10-08-native-file-change-receipts.md)。[真实预览与 Core receipt 测试](../../../test/isolated/files/change-preview.test.ts)核完整 BOM/CRLF pre/post、外部后改不改变历史、数 MiB 完整写入与 UTF-8 截断、失败/unknown 不保存成功预览，以及跨 Run 重复 call ID 的唯一原 source；各客户端实际资格由 owner 和进度维护。

POSIX anchored 路径调用由 [files-native](../files-native.ts) 将 NUL 结尾的 Buffer 直接交给 Bun FFI；参数保持 JavaScript 引用直至 libc 调用结束。不能先对临时 Buffer 取数字指针再丢弃引用，否则 GC 可使仍存在的原路径返回 ENOENT。[路径寿命回归](../../../test/isolated/files/native-path-lifetime.test.ts)在真实 openat/renameat/linkat/unlinkat 前强制 GC，验证完整字节、原 inode 基线、创建与删除；实际资格当前只覆盖 macOS。捕获测试另核三条真实成功 Tool 回执与 first/last 的准确原 Execution ID，不把第二条单独成功误当成两次成功捕获。

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
