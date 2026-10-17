# Files Node-API 后端

本 crate 由 Agent 的 [构建 companion](../../scripts/build-native-files.ts)编译；[唯一加载器](../../src/files-native-binding.ts)接回原 `WorkspaceFileIo`，不增加 Model Tool、权限来源或恢复状态。正式构建只携带原生资产，不携带或调用编译器。源码开发先运行根 `bun run build:files-native`；根安装脚本也构建该资产。

Rust 固定1.97.1，cap-std／cap-fs-ext 固定4.0.3，napi-rs 和官方 windows-sys 的准确依赖由 [Cargo.lock](Cargo.lock)封存。Windows 固定 x64 MSVC 和静态 CRT；Linux 目标为 GNU libc，macOS 按实际 CPU 构建。构建显式选定目标，清除常见 Rust compiler／target／flags 环境覆盖，并记录 crate 配置及来源摘要。其他平台的编译检查不替代本机运行资格。

Windows DLL 在 [build.rs](build.rs)固定 `/DEPENDENTLOADFLAG:0x800`，将其静态导入的解析限制到 System32；不依赖每个 DLL 名都在 KnownDLLs 中，也不修改进程全局搜索状态。[Microsoft 合同](https://learn.microsoft.com/en-us/cpp/build/reference/dependentloadflag?view=msvc-170)适用于 Windows10 RS1及以上。搬迁测试直接读取实际 PE 的 x64／PE32+、无 delay import 与 DependentLoadFlags，再在 Bun／Node 实际加载；`dumpbin /LOADCONFIG`另核编译输出。

## 库与项目策略的分工

| 合同 | 实现与限制 |
| --- | --- |
| 能力对象、读写与完整 EOF | cap-std `Dir/File`，Node-API 只传局部 ID 和有主缓冲，不传 HANDLE、FD 或裸指针 |
| POSIX 相对路径、no-follow、发布 | cap-std／cap-fs-ext；保原 create-only hardlink／replace rename 与文件、目录 fsync |
| Windows 原目录固定 | [Windows owner](src/windows.rs)逐段使用官方生成 `NtCreateFile` 类型绑定，拒绝 delete sharing，取得后先登记再验证；cap-std 管理已打开的能力对象与文件流 |
| Windows 身份与私有文件 | 官方 `FILE_ID_INFO` 全64位 volume＋128位 FileID；原 SID、nlink1、非 reparse 检查；CREATE_NEW 的准确私有 DACL |
| Windows 发布与删除 | 原 temporary HANDLE 向原父 HANDLE 的 `FileRenameInformation`，原对象 disposition；不采用 cap-std 的按名称 rename，不增加绝对路径回退 |
| 关闭与 unknown | 显式逐个关闭，成功后才解除 Rust 所有权；失败保原对象及父链、不重试不确定 HANDLE。发布后核实失败继续 unknown |
| 原生代码准入 | 固定相对资产位置，检查无 symlink／单链接、平台、CPU、ABI 和完整哈希后加载；缺失不编译、不搜索源码或系统替代 |

cap-std 本身不是本项目全部安全规则的替代：其 Windows metadata 接口只给64位 file index，rename 按名称实现，上游内部 `Drop` 也不提供显式关闭失败证明。因此 Windows 的取得、元数据、枚举、发布、删除和关闭由同一 Rust owner 使用生成 SDK 绑定补齐；没有手写 extern 声明、结构体字节偏移或 Bun FFI 参数表。POSIX owner 维护原 UID、物理根、单链接上层检查和显式 FD 关闭。

Windows 的目录身份核实不是 POSIX directory fsync，不作断电持久性承诺；末次 baseline 复核与非合作编辑器之间仍不是原子 filesystem CAS。普通 Workspace 的既有 ACL 不修改。严格外部路径、字节恢复和普通 Workspace 默认读取保持原差别。

## 构建与验证

在本目录执行 `cargo test --locked --lib` 验证 Windows 真实8.3根别名拒绝、取得后确认未知与关闭未知保原父链／不重试，以及实际发布后确认失败。故障口只在 Rust `cfg(test)` 制品内存在，普通 Node-API ABI 没有开启参数。

[原生能力测试](../../test/isolated/files/native-addon.test.ts)实际核 private temporary ACL、原生身份、create-only／replace、hardlink、junction 和删除；[完整 Windows 工具](../../test/isolated/files/windows.test.ts)、[外部工具](../../test/isolated/files/path-files.test.ts)与[检查点](../../test/isolated/file-checkpoints/capture.test.ts)继续经过原 TS 引擎和 Runtime。[GC 整例](../../test/isolated/files/native-path-lifetime.test.ts)在 Node-API 边界前后强制 GC，保准确 bytes 与对象身份。

[搬迁制品](../../test/isolated/files/native-packaged.test.ts)将真实 companion 与同一加载器移到源码树外，在 Bun 和 Node／空 PATH 下读写，核缺失及 hash／ABI／平台改变零效果拒绝；[完整包](../../test/isolated/files/built-large.test.ts)使用正式 Agent build 和公开 exports 完成9MiB文件与16MiB以上流式 Artifact。[默认 Service](../../../../apps/service/test/isolated/files-native-boundary.test.ts)沿真实 SDK、Full 策略与 Runtime，核加载器／资产在 adapter 前拒绝，普通外部文件仍可读。实际执行状态及剩余范围归 [Files owner](../../src/tools/files/README.md#node-api-文件后端)。

[平台 CI](../../../../.github/workflows/platform-capability-probe.yml)在 macOS、Linux、Windows 各自构建后执行 Rust 资源测试、真实 Node-API companion、六工具、外部路径、检查点与默认 Service 测试，再沿原完整候选流程验证。接线不表示这些远端任务已经运行；长期取舍见[能力边界决定](../../../../.agents/notes/implemented/architecture/2026-10-16-files-node-api-capabilities.md)。
