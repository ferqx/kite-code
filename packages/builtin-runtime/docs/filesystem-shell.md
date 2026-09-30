# 文件与 Shell 执行机制

入口：[filesystem](../src/filesystem/)、[sandbox execution](../src/sandbox/execution/)、[shell semantics](../src/shell-semantics.ts)、[policy compiler](../src/policy-compiler.ts)。

执行器接收已准备、绑定 identity 的参数与授权上下文，不自行扩大路径、网络或凭据范围。filesystem read/write、Shell 和 typed Git 各有机制，不能以显示名或“看起来只读”替代 effects 和 policy facts。

文件读取共享规范路径与范围检查；修改需保持目标、preimage 和发布边界一致。symlink、目标被替换、并发修改和原子写失败都必须保持明确结果，不能写到重新解析出的另一个对象。

[Local provider](../src/filesystem/local-provider.ts)不再为整文件观察／搜索施加默认 8 MiB 或 10,000 匹配数上限；[preimage store](../src/filesystem/preimage-artifacts.ts)与[写入 grant](../src/filesystem/grant-authority.ts)不再分别因 16 MiB／16 Mi 字符拒绝操作。`read_file` 的显式行范围仍执行，未指定 `limit` 时返回剩余全文；[Runtime module](../src/filesystem/runtime-module.ts)不再截断长行、搜索、写入或编辑结果。目标 stat、no-follow 打开、摘要、grant、替换检测和原子发布校验继续绑定准确对象。大文件实际存储和模型请求容量仍由对应 owner 裁决。

`search_files.pattern` 与 `search_content.glob` 共用文件匹配器，完整目录段 `**/` 表示零层或多层目录，包含搜索根目录；普通 `*`、文件名 brace 与非目录段的 `**` 保持原语义。匹配规则不改变遍历、ignore、symlink、路径 scope 或持久授权，验证见 [递归 glob 回归](../test/filesystem-search-glob.test.ts)。

逐页读文件每次重新打开并读取目标原始字节，保持 no-follow 与前后对象身份校验；相同路径且原始字节完全一致时，复用上次解码正文、行索引及正文摘要，任何同尺寸改写也会重新解码和计算摘要。完整 `rawContent` 和正文摘要仍随观察结果交给证据校验；此契约意味着每页仍需读取并核对整份原始字节。[独立观察证据校验](../src/filesystem/observation-authority.ts)仅保留最近一次完整验证的正文和摘要：同一不可变字符串且摘要相等时复用正文校验结果，新的正文必须重新哈希；目标、准备身份、持久意图及观察字段每次仍独立验证。搜索在遍历时直接投影匹配结果，不再先保留全部文件路径；遍历每 128 个目录项让出事件循环一次。`edit_file` 多次匹配的行号由单次前向扫描计算。

Shell preparation 决定可执行环境与沙箱能力，实际 dispatch 后输出、退出码和 cleanup 归对应执行 port。执行前拒绝没有退出码；失败不保证没有副作用。Host 丢失或取消后的进程清理由 Host/platform port 承担。主 Run 未设置显式 `timeout_ms` 时，内部准备与执行上下文传递 `timeoutMs: null`，不再回退为 10 分钟默认超时；有限子 Run 使用自身剩余期限，明确设置的正整数超时保持原值。空值不改变有限命令的完成义务，也不取消用户中止、沙箱权限或进程树清理。

Builtin 对封印的 Shell 命令重新运行闭集只读分类，再选择固定解释器和最小环境；Full 模式下匹配的 Git 读取也使用中性 HOME、隔离 PATH 和禁用 Git 配置／helper 的环境投影。环境选择与 `executionTrust` 的只读沙箱能力证明分开：Full 仍保留已授权的 `full_access`/网络范围，不能把 `policy_proven_read_only` 与 `allow_all` 组合。未命中闭集的命令保持普通环境，调用方传入的只读信任若未通过 Builtin 分类会在准备阶段拒绝。

Host 的输出 consumer 将完整解码 chunk 交给 Service 的 [Managed Shell](../../../apps/kite-service/src/bootstrap/runtime/managed-shell.ts)私有磁盘 spool；内存缓冲仅用于终态预览。兼容只返回终态正文的 executor：每路没有收到非空 progress 时，将该路终态正文补写入 spool；已经流式写入的内容不从预览重复追加。普通有限 Shell 完成后也返回句柄与从 0 开始的读取游标。`shell_read` 返回一个通信页及 `moreOutput`，用上一页 cursor 继续获取完整输出。页内使用完整 UTF-8 帧，按原始字节和实际 JSON 编码长度收页，控制字符转义也不会突破 Protocol 文本边界；正文只携带必要终态事实，不重复命令和终态输出预览。分页不丢弃中间输出。Spool 写入失败时取消对应执行，不能报告完整捕获成功。句柄是当前 Runtime 的进程内读取权威，Runtime 释放时回收临时文件，不将旧 pid 或旧句柄作为重启后的执行证据。

POSIX Host Shell 以非 login 的 `-c` 方式启动，并在创建外层进程前移除 `BASH_ENV` 与 `ENV`，只执行已治理的命令，不隐式读取或执行用户的 `~/.bash_profile`、`~/.bashrc`、`~/.zprofile`、`~/.zshrc` 或非交互启动注入文件。Prepared sandbox 从进程创建开始使用 hardened environment，不能只在 shell preamble 中事后 unset；preamble 仍移除启动注入变量，避免子 Shell 重新继承。工具链通过宿主进程已投影的环境提供；启动文件错误不得污染命令的 stderr，也不得在审批内容之外引入额外执行。

平台能力、用户模式、精确审批与工作区信任分别生效。Full 不是配置出任意平台能力的手段，Auto 的不确定结果也不能凭工具说明静默放行。

Native Shell 的读取投影由 App composition 选择，独立于写入 scope：开发期使用 `broad`，release-pinned `ExecutionBoundary` 使用 `restricted`。Seatbelt broad 允许文件读取但不扩大 `file-map-executable`，批准 IP 网络仍拒绝 Unix socket；bubblewrap broad 使用只读主机根挂载，之后覆盖 Workspace/runtime 可写目录、隔离 `/tmp`、遮蔽 Host-control 根。Linux broad 还要求 `apply-seccomp` 拦截 AF_UNIX；缺失时 Provider 在 spawn 前拒绝。Windows direct restricted-token 保持现有普通用户读取能力。Shell 命令仍须通过 Policy／审批；结构化文件工具不继承 Shell 的 broad read。

修改后核对生产 dispatcher、policy 与实际 filesystem/process 测试。规范见[文件边界](../../../docs/active/file-reading-shared-boundary.md)、[执行边界](../../../docs/active/execution-boundary.md)、[Shell 平台](../../../docs/active/shell-platform-compatibility.md)。

验证：[read dispatcher](../test/filesystem-read-dispatcher.test.ts)、[mutation dispatcher](../test/filesystem-mutation-dispatcher.test.ts)、[preimage](../test/persistence/filesystem-preimage-artifacts.test.ts)。
