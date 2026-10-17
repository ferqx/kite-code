# Agent Note: Files 的能力对象与 Node-API 边界

Status: implemented

## Problem

文件工具原先通过手写 Bun FFI 声明、结构体布局和临时 Buffer 地址调用 POSIX／Windows 文件 API。Windows 实际发布曾因 wrapper 与相对 rename 不兼容返回 errno87；路径、SID、结构体内存和资源关闭的正确性需要由项目独自维持。用户要求评估稳定开源库，确认原安全边界保留后直接替换，并验证真实 Windows 与打包模块。

需要保留的不只是文本读写：原父目录对象、完整 volume／128-bit FileID、私有 temporary、reparse／短名拒绝、严格 owner／链接数、准确 baseline、已发布 unknown，以及关闭未确认时保留原资源，都是现有 Files 合同的一部分。

## Decision

以固定 cap-std／cap-fs-ext4.0.3 的能力对象和 napi-rs 的 Node-API 模块替换文件工具 leaf 的 Bun FFI。JS 只持 owner 内的局部 ID 和有主数据；原 HANDLE、FD、裸指针和 SID 不越过边界。TS 继续拥有完整正文、baseline、CAS、工具、授权与检查点业务，不建立第二个文件引擎。

cap-std 不能单独承担完整 Windows 合同：上游 metadata 只暴露64位 file index，rename 使用名称，内部关闭探针的 Drop 也不能提供本项目要求的关闭失败证据。因此同一 Rust owner 通过官方生成的 windows-sys 类型补齐句柄取得、完整身份、私有 DACL、枚举、原 temporary HANDLE 向原父 HANDLE 发布、原对象删除及显式关闭。Windows 取得的对象在进一步核实前登记；关闭失败不重新构造或重试不确定 HANDLE，保原 owner 及父链。cap-std 负责已取得的能力对象和流 IO，生成的 SDK 负责 ABI，项目负责策略。

POSIX 保原 no-follow、UID、单链接上层检查、create-only 已知 temporary hardlink、replace rename 及文件／目录 fsync。已知 temporary 的第二个链接仍由 TS 验证准确预期，不能把 Windows 的单链接 owner 检查机械套入 POSIX 发布中间态。

构建使用固定 Rust、Cargo.lock 和本机明确目标；Windows 固定 x64 MSVC／静态 CRT。固定相对 companion 与 ABI、平台、CPU、完整哈希、来源摘要、锁文件及许可证一起进入 Agent 和产品清单。运行期缺失或损坏直接拒绝，不查源码、环境变量或编译器回退；默认 Service 将加载器及整个 companion 纳入既有保护路径，Full 也不能读取或改写。

新 Windows DLL 还固定仅从 System32 解析静态依赖的链接标志；只列出系统 DLL 名不能替代这个边界。实际 PE 字段与搬迁加载均由用例核实，避免换成 Node-API 后新增 Workspace／cwd 的依赖库搜索。

## Alternatives considered

- 继续维护手写 Bun FFI：能局部修补，但仍需自行保证 ABI 布局、路径／Buffer 寿命和每个资源出口，不满足本次替换目标。
- 只把 Node fs 或 cap-std 的通用路径方法接到现有接口：不能提供 Windows 全 FileID、原 temporary HANDLE 相对发布和关闭未知证据，拒绝以便利接口降低既有合同。
- 在 napi-rs 内继续手写 extern、数字结构体偏移或 Win32 参数表：只是搬迁维护负担，采用生成 SDK 类型及 `size_of!/offset_of!`。
- 同时迁移 Profile、SQLite、Shell、安装锁等原生 owner：它们拥有独立策略和验收，不属于本次文件工具替换，保留原负责模块。

## Consequences

开发与构建增加 Rust 和平台 linker 的明确前提，用户运行制品不需要编译器。能力库升级仍须重新核实项目策略和平台行为；使用成熟库本身不授予安全或发布资格。普通 Workspace ACL 不修复，Windows 目录身份核实不宣称 POSIX directory fsync 或断电持久性，最终 baseline 与非合作 writer 之间仍有竞态。

本轮 Windows 工具、资源故障、源码树外 Bun／Node、完整 Agent 包及 Service 保护路径的实际命令与限制归 [Files owner](../../../../packages/agent/src/tools/files/README.md#node-api-文件后端)，构建分工归 [native owner](../../../../packages/agent/native/files/README.md)。三平台 CI 接线不是其他平台已实测的证据，完整安装和所有客户端继续经过原门禁。

本决定替换[路径修复记录](../bug-fix/2026-10-16-workspace-tool-paths.md)中发布修复的 Bun FFI 实现载体；其路径、原生身份统一、授权和 Native 默认路径展示仍适用。[Windows 原 HANDLE 提案](../../proposed/architecture/2026-10-10-windows-workspace-files-owned-handles.md)的原对象安全理由和未完成的完整产品／安装资格保留，不因这次迁移整体转为 implemented。
