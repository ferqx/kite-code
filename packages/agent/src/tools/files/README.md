# Workspace 文件 leaf

公开入口 `@kite-ai/agent/files` 的 import 不打开资源。宿主显式调用 `createWorkspaceFiles({root,maxFileBytes?})` 选定一个物理 Workspace 根，再用 `createFileTools(files)` 将六个普通 ToolDefinition 装配进扩展；工具仍走 UnifiedExecution 的权限、来源复查、计划、派发和终态。没有 CodingAgent、Git 或旧 filesystem authority 依赖。

`read(path,{offset?,limit?})` 缺省返回完整 UTF-8 正文，offset 从 1 开始；省略 limit 读取全部剩余行，显式 limit 按行选择。页内容保留 BOM/CRLF/最终换行，并返回 fromLine/toLine/totalLines/nextOffset；超出末尾返回空正文和 null toLine，空文件为 0 行。每页仍读取并校验完整字节，以完整 SHA256/字节大小/device/inode 建立基线，绝不以页正文替代文件基线。read Tool 版本为 3，write/edit/search/glob 为 2，list 为 1；旧 schema/执行历史保持自己的版本。非法 UTF-8 明确错误；BOM 与 CRLF 保留，写入不进行编码猜测。`write` 的 `base` 必填，null 只准创建，其他值必须与当前完整字节和文件对象完全一致。`edit` 使用同一基线，并要求非重叠字面匹配数量精确等于 occurrences。写入先在同一目录创建独有临时文件、写全并 fsync，再次验证基线，最后原子替换或 create-only hardlink，并 fsync 目录。失败不保证没有效果，例如原子发布后的同步或外部改写可能导致错误。

POSIX 使用目录 FD 与 no-follow openat 逐段锚定路径，macOS 调用非 variadic `__openat`。相对路径禁止 `..`、`.`、绝对路径和反斜线；根与目标链均不跟随符号链接，不读取设备/FIFO/目录作为正文。根目录替换后原对象不被重新解释成另一权限目标。临时文件清理不会覆盖原发布结果。目录描述符设置 close-on-exec。当前 Windows 明确 `file_platform_unsupported`，没有退回弱化的普通路径替换。

默认没有整文件、原文、搜索匹配数或长行总额度。读取使用固定 64 KiB 字节块，严格增量 UTF-8 解码、完整 hash 与前后 FD 事实校验；默认 read 返回全部剩余行。宿主显式 `maxFileBytes` 可声明该宿主的单文件能力约束，未设置时不回退为旧 8 MiB。真实内存、磁盘、IO 与字符串表示能力仍可能局部失败，不把它们假装 Provider 窗口。二进制控制字节采样检查和严格 UTF-8 保留，BOM/CRLF 不规范化；search 不将已识别二进制当文本。

search 未指定 limit 返回全部匹配；显式 limit<=200 给出完整 next keyset，path/line 稳定排序。glob 的 **/ 匹配零或多层目录，页 limit<=200，完整路径 keyset；去除旧目录数、访问项数门槛，遍历不跟随 symlink，不执行 shell/rg。显式分页仅保留该页候选，不把下一页隐去。list 仍使用明确名字分页；跨页外部变化不构成一致快照。未知目录项类型明确 file_directory_type_unavailable。

普通 Tool 的小结果内联 JSON；大 read/search 等结果通过真实 `context.artifacts.publish` 保存完整不可变正文。read Artifact 是完整所选 UTF-8 正文，summary 保留完整文件 baseline/selection；search Artifact 是完整结果 JSON。结果包含准确 Artifact refs、`body.complete=true` 和 `inlineBody=false`，这表示完整正文已保存；通用 `modelContent` 另指向相同准确正文，Core 完整校验后将其送入实际下一 Model 请求。没有 Artifact 能力时明确 artifact_publication_unavailable，不把摘要冒充全文。read/write/edit/search/glob 的新定义版本保留行为差异；write 的 contentArtifact、edit 的 findArtifact/replaceArtifact 接受准确原 scope 的完整 UTF-8 Artifact，与对应 inline 参数互斥，不能凭 hash 或猜当前 scope 读取。

文件写入先校验原完整基线、再临时发布。发布后同步/读取失败返回 file_publish_outcome_unknown；Tool 保留 outcome_unknown，不把已发生替换假报为零效果失败。

## 逐操作文件变更预览

普通 UTF-8 write/edit 在最后一次基线验证保存实际完整 preimage，publish/fsync 后读取实际 postimage，并核其完整内容和发布 FD 的 dev/inode；确认漂移保留 `file_publish_outcome_unknown`。成功 [FileSnapshot](../files.ts)带 `change`，由迁入的原 [共同前后缀行差异](../files-diff.ts)生成行号与增删内容。新建或内容不变展示真实写入内容；不是 Git diff、LCS 或 Shell/外部编辑捕获。每次操作独立保存，不合并为累计贡献。

[Tool wrapper](../files-tools.ts)保持 write/edit 版本2及原 Model `content:{path,baseline}`，只将可选中立 `FileChangePreview` 放入 `ToolResult.details.fileChange`：version1、format、path、before/after 完整 baseline、text 和 truncated。预览最多65536 UTF-8 bytes，截在完整字符边界；这个额度只限制展示 receipt，不限制文件 IO、完整 baseline、Model 读写正文或 Artifact。before/after capture 最后保存失败和派发后确认失败仍 unknown，不发布可用成功预览；read/search/glob、字节恢复及未装配该预览的工具不伪造记录。消费者须核原 succeeded Execution/Run/结果 revision，旧或未知格式明确不可读。

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
