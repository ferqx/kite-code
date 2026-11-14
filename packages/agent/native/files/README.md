# Files Node-API 后端

本 crate 由 Agent 的 [构建 companion](../../scripts/build-native-files.ts)编译；[唯一加载器](../../src/files-native-binding.ts)接回原 `WorkspaceFileIo`，不增加 Model Tool、权限来源或恢复状态。正式构建只携带原生资产，不携带或调用编译器。源码开发先运行根 `bun run build:files-native`；根安装脚本也构建该资产。

构建向 stderr 依次报告原生编译、资产准备和依赖许可证收集三个阶段，实时转发 Cargo 诊断，全部完成后输出资产路径；失败仍保留 Cargo 诊断及非零退出。`cargo metadata` 的 JSON 留给脚本解析，不混入进度输出。

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

Linux 的 cap-std 目录能力使用 `O_PATH`，不能直接 fsync。目录 sync 只沿原 Dir 以固定 `.`、read／`O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` 取得可读 FD，先登记到同一 owner，再核准确 device/inode 与目录种类、fsync 并显式关闭；关闭未知优先保留原结果未知及完整父链。没有按绝对路径重开、权限回退或忽略同步错误；文件 sync、macOS 原有 sync 与 Windows 身份复核不变。

ABI `kite-files:2/cap-std:4.0.3` 增加内部 `create-directory` 打开种类，只创建原父能力下的单个新目录。POSIX 用 `create_dir_with(0700)` 后 no-follow 打开；Windows 以 `FILE_CREATE` 取得原目录 HANDLE，使用本人私有 DACL，先登记再核身份，取得未知保原父链。既有目录冲突返回 `EEXIST`，不在 native 内跟随或重试。上层仅对新建工作区文件补父目录，详细范围和失败语义归 [Files owner](../../src/tools/files/README.md#新建文件的父目录与失败反馈)。系统权限拒绝保留 `EACCES`，不再混为一般 IO 错误。

`WorkspaceFileIo.listAt(parent, maxEntries?)` 的可选预算限制实际遇到的目录项（不含 `.`／`..`，包含保护规则过滤的项）。有预算时只调用独立 native `listAtBounded`；同ABI旧 companion 即使通过自身 manifest／binary 校验，缺少此方法仍以 `file_native_bounded_listing_unavailable` 拒绝，绝不向可能忽略多余参数的旧 `listAt` 回退。省略预算的既有调用继续走不限额 `listAt`。Unix 在原目录迭代器取得条目后、名称转换与过滤前扣减；Windows 继续沿原 HANDLE 使用固定64KiB批缓冲，在解析单项后、名称分配与过滤前扣减。遇到首个超额项即返回 `file_directory_entry_limit`，不返回部分列表，也不先构造完整目录数组。参数只属于内部文件能力 API，ABI、工具和协议版本不变。[Shell collector](../../src/business/output-collection.README.md)传入剩余总预算，并在同步 native 调用前后让出事件循环检查取消；条目数量约束不构成阻塞 OS／文件系统调用的硬时延承诺。

## 构建与验证

在本目录执行 `cargo test --locked --lib -- --test-threads=1` 验证本机资源边界。Unix 的嵌套关闭故障核相对父链、原 FD 和整个 owner 在显式关闭及 Drop 后仍被保留；Windows 另核真实8.3根别名拒绝、嵌套目录取得后确认未知、关闭未知不重试，以及实际发布后确认失败。owner 一旦进入 uncertain，任何子句柄关闭都在 OS 调用前拒绝；不能只保根与绝对祖先，或在 close/Drop 中先释放相对父链再检查 uncertain。故障口只在 Rust `cfg(test)` 制品内存在，普通 Node-API ABI 没有开启参数；其他平台的测试源码或编译检查不算该平台实际执行证据。

2026-10-25，Linux x64／Rust1.97.1、`aefb4747` 加本次 owner guard／目录 sync 修复，上述命令3项通过；核真实 root／嵌套目录 sync、原目录改名并由同名新目录替换后仍保原能力、probe 关闭未知、故障后零额外 OS close，以及显式 close 和 Drop 后原 FD／完整 owner 保留。修复前的 `aefb4747` 和隔离构建的 `ee7ad8c6` 均实测目录 fsync 为 `EBADF`，这是既有 Linux 后端缺口，不是新父目录功能引入的回归。另在隔离 crate 副本仅移除 Unix guard，嵌套关闭测试正常编译后在祖先 close 返回成功处失败，确认回归能检出原释放缺口。Windows 嵌套取得／关闭测试本轮仅更新源码，未执行 Windows 原生测试；不据此宣称该平台验收。

2026-11-11，Linux x64／Rust1.97.1、`0d17ab9` 加有界枚举改动，上述命令7项通过。新增测试核零预算、准确上限、超限、未传预算保持原行为、受保护项也占预算、原持有目录与替换路径隔离；10,000项目录在第1,001项即停止，访问计数仅存在于 Rust `cfg(test)`。真实 Node-API 测试另核预算错误映射和参数边界；Shell collector 回归核1000项全局边界、子目录剩余预算及取消让出。搬迁回归在 Bun／Node 中模拟缺少有界方法，核限额请求零无界回退；另以原版同ABI companion（SHA256 `adc748bef08189ce6e4b9db647b8fbe92bcd65ac5b583783650c93f706fbd236`）在隔离副本实际核两种 runtime 都拒绝限额请求、仍支持原无限额读取。Windows 同一测试源码已覆盖拒绝原目录改名的既有约束，本轮未执行 Windows 测试或跨目标类型检查。

[原生能力测试](../../test/isolated/files/native-addon.test.ts)实际核 private temporary ACL、原生身份、create-only／replace、hardlink、junction 和删除；[完整 Windows 工具](../../test/isolated/files/windows.test.ts)、[外部工具](https://github.com/ferqx/kite-code/blob/840f71b315e5b2a48f370449ddb3dd5048dfdee8/packages/agent/test/isolated/files/path-files.test.ts)与[检查点](../../test/isolated/file-checkpoints/capture.test.ts)继续经过原 TS 引擎和 Runtime。[GC 整例](../../test/isolated/files/native-path-lifetime.test.ts)在 Node-API 边界前后强制 GC，保准确 bytes 与对象身份。

[搬迁制品](../../test/isolated/files/native-packaged.test.ts)将真实 companion 与同一加载器移到源码树外，在 Bun 和 Node／空 PATH 下读写，核缺失及 hash／ABI／平台改变零效果拒绝；[完整包](../../test/isolated/files/built-large.test.ts)使用正式 Agent build 和公开 exports 完成9MiB文件与16MiB以上流式 Artifact。[默认 Service](../../../../apps/service/test/isolated/files-native-boundary.test.ts)沿真实 SDK、Full 策略与 Runtime，核加载器／资产在 adapter 前拒绝，普通外部文件仍可读。实际执行状态及剩余范围归 [Files owner](../../src/tools/files/README.md#node-api-文件后端)。

[平台 CI](../../../../.github/workflows/platform-capability-probe.yml)在 macOS、Linux、Windows 各自构建后执行 Rust 资源测试、真实 Node-API companion、三项文件工具、外部路径、检查点与默认 Service 测试，再沿原完整候选流程验证。接线不表示这些远端任务已经运行；长期取舍见[能力边界决定](../../../../.agents/notes/implemented/architecture/2026-10-16-files-node-api-capabilities.md)。

Windows 的 FILE_RENAME_INFORMATION 缓冲长度至少覆盖结构体本身，避免单字符文件名 X／中发布时返回 ERROR_BAD_LENGTH；[Windows 文件测试](../../test/isolated/files/windows.test.ts)通过原父 HANDLE 实际核创建、替换与读取。ABI 与发布原子性保持。
