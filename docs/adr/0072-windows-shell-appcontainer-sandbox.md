# ADR-0072：Windows production Shell 采用 Classic AppContainer + Job Object + native launcher

状态：accepted
日期：2026-08-04
决策者：`github:@ferqx`（Security + Platform，single-maintainer）
关联：D-04、ADR-0054、ADR-0061、ADR-0065

## 背景

Windows 当前 backend 为 `none`：`detectSandboxBackend()` 在 win32 不返回任何候选，probe
全部投影 `unavailable`，支持矩阵对 Windows 记录为 "no filesystem/network sandbox backend is
implemented"。现有 `createWindowsJobGuard()` 只做进程清理（Job Object 关联 + 终止时
`TerminateJobObject`），不设置 `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` 或
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，且 Job Object 本身不能限制 filesystem 或 network。
因此 Windows 需要一个新的原生后端，才能在 D-04 的逐项准入体系下产生任何 production 候选。

## 决策

1. Windows production Shell 的候选后端采用 **Classic AppContainer + Job Object + native
   launcher**，backend 标识为 `windows_appcontainer`：
   - Classic AppContainer 提供 filesystem（token/ACL 默认 deny + 显式 AppContainer SID ACE）
     与 network（零 capability 全关）边界；
   - Job Object 提供完整进程树、`JOB_OBJECT_LIMIT_ACTIVE_PROCESS` 硬上限与
     `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 清理；
   - native launcher 为 Rust `windows` crate 实现的独立进程，经版本化、framed 协议与 Bun/TS
     adapter 通信，执行完整启动时序并返回结构化 execution receipt。
2. 不用 Windows Sandbox、WSL2、Docker、只用 Job Object：
   - Windows Sandbox（WDAG）是独立 VM：启动秒级、需虚拟化，不能作为 per-invocation Shell
     边界；WSL2 是另一个 VM 文件系统，不是 Windows 原生边界；Docker Desktop 依赖前两者且是
     重型第三方依赖；
   - 只用 Job Object 无法限制 filesystem/network，只能做进程树记账与清理，补不了隔离。
3. 必须 suspended create → assign Job → resume：`CreateProcessW` 以 `CREATE_SUSPENDED` 创建，
   挂起状态先 `AssignProcessToJobObject`，再 `ResumeThread`。否则根进程在关联 Job 前已可执行
   并派生逃逸 Job 的 descendant。这是硬不变量，不允许省略。
4. V1 只支持 `networkMode=off`：AppContainer 零 capability 结构性全关网络；host allowlist
   需要逐 descendant 的 DNS/redirect 安全实现，V1 不承诺。`network=off` 之外的能力保持关闭。
5. Skill child 与 local stdio MCP 继续关闭（`skillChild=false`、`localStdioMcp=false`）：
   V1 只声明 Shell 进程能力，不因同一 sandbox executor 存在而向 forked Skill 或本地 stdio
   MCP 继承资格。二者需要各自的 native child inheritance conformance 与 transport 固定。
6. 实现完成不等于 production qualified：`windows_appcontainer` 的实现与 probe 可以完成，
   但 `productionSupported` 必须保持 `false`、outcome 保持 `excluded`。只有新追加 ADR、
   真实 Win10 22H2 与 Win11 原生证据、独立 release gate 同时成立，才能评估更新 approved
   qualification registry。GitHub-hosted Windows Server 不能代替 Win10/Win11 客户端证据。

## 备选方案

- Windows Sandbox / WSL2 / Docker：拒绝（VM 级重依赖，per-invocation 不可行）。
- 只用 Job Object 加固现有 guard：拒绝（不能证明 filesystem/network isolation）。
- 用 Bun `bun:ffi` 直接调 kernel32/advapi32：拒绝（AppContainer SID 派生、ACL 授予、
  STARTUPINFOEX 属性列表等复杂状态机用 Rust `windows` crate 更可验证、可测试）。
- 先批准再回退裸 shell：拒绝（审批不能创造技术隔离，ADR-0054 已禁止）。
- 用完整性级别 + restricted token 替代 AppContainer：拒绝（无内置 network 隔离，需手写
  ACL 全套，AppContainer 一体完成）。

## 后果

- Windows 获得一个可执行、可探测的候选 backend；probe 的 Windows 分支从全 `unavailable`
  变为真实 native conformance 结果。
- 责任新增：AppContainer SID 的 ACE 会短暂写入宿主 DACL，必须在使用后移除；移除失败
  invocation 必须 fail closed。这是 Seatbelt/bubblewrap 没有的清理义务。
- 责任新增：vendored Shell runtime 与 runner 二进制必须 SHA-256 固定，缺失/损坏/版本不匹配
  时拒绝执行。
- 用户 profile 的默认只读残余面必须由真实 Win10/Win11 原生 probe 如实测量；若存在，Windows
  无法证明 `workspaceOutsideReadDeny` 为 `enforced`，`excluded` 结论保持并在文档记录限制。
- 空支持集保持不变，直到新增 ADR + 两代客户端证据 + release gate 三者齐备。

## 回滚

可以关闭 Windows Shell（回到 `none`）、收紧 `windows_appcontainer` 的 filesystem scope、或
删除整个候选后端。不能回滚为：sandbox 缺失时裸 shell 回退、用户审批恢复非隔离执行、把 Job
Object 清理当作 filesystem/network enforcement、用 GitHub-hosted Windows Server 证据冒充
Win10/Win11 客户端证据、或把实现完成当作 production qualification。