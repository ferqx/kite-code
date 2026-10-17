# Agent Note: Windows Bun 构建副本提前解析受限系统导入

Status: implemented

## Problem

Bun 1.4.2 的真实 Windows x64 EXE 有11组 delay imports。现有 Terminal builder 要求每个子进程在开始执行前就限定 System32 静态导入搜索；`DependentLoadFlags` 不约束运行后的 delay-load helper。直接接受该目录会丢失加载前边界，原样拒绝又阻止完整 Terminal 物化。

后续实际 Native 预检发现 Electron44.3.0 GUI 主程序同样有52组 RVA v2 delay imports，包含 `ffmpeg.dll` 与系统 `WINSPOOL.DRV`／`bthprops.cpl`。继续一律拒绝源 Electron 会阻断同一 Native 构建；只接受任意延迟目录则仍丢失原边界。

实际编译还暴露三个独立生成问题：Bun 的 standalone 输出沿用编译进程 executable 的 DACL，传 `compile.executablePath` 仍会生成不合格权限；C 输出的同目录复制会改变被持续 pin 的源目录元数据；Bun 1.4.2 standalone 的 `import.meta.main` 为 false，使原条件入口静默返回0。不能靠修复外部对象权限、放宽原对象检查或只验证编译成功解决。

## Decision

[builder](../../../../scripts/release/build-windows-terminal-launcher.ts)只对新 console 或 Electron 副本提前物化经验证的 RVA v2 delay imports。普通与延迟描述符合并到退役 delay descriptor 的原只读、非执行、非写入存储；容量不足就拒绝。保留所有原 INT／IAT 地址、IAT 原始内容、代码、节位置、文件长度和 Bun 嵌入程序。普通 Windows loader 在运行代码前填写同一 IAT，原调用不再进入 delay thunk；转换后 delay directory 必须清零，已有 LoadConfig 必须封闭 console 的 `0x800` 或 Electron 的 `0xa00`。

拒绝未知属性、bound／unload／timestamp、路径和重复 DLL、坏 thunk／hint／ordinal、非执行 stub、非写入 IAT、descriptor／导入数据／其他 directory／relocation 冲突、节重叠及所有越界。缺失 LoadConfig 仍拒绝，不补造加载器字段。第一阶段 C 的准确三 DLL 检查不变；Electron 最终镜像仍拒绝 delay imports，保持原 APPDIR＋System32 合同，仅接受两个准确系统非DLL basename `winspool.drv`／`bthprops.cpl`；console 不接受这两个额外名称。

固定 verifier source 通过已封闭且持续 pin 的私有候选 Bun 子进程编译；环境有限、关闭配置自动加载、命令有期限且只在实际 child 关闭后交接。输出继续通过原权限和 PE 门禁。Terminal／Native 各用固定的 executable-only entry，在顶层调用原 verifier；可导入 library 保原 entry guard，不全局把所有模块的 `import.meta.main` 定义为 true。真实编译的两个 entry 必须在缺少安装身份时执行原 guard 并返回1。C 中间输出另置私有子目录，复制到其父输出目录不改变正在 pin 的源目录库存。所有目标均新建，不修改原 Bun、原安装或既有权限。

这一决定只部分替代[Terminal 提案](../../proposed/architecture/2026-10-10-windows-managed-terminal-frontdoor.md)和[Native 准入决定](../architecture/2026-10-10-windows-managed-native-admission.md)中对源 console／Electron delay imports 的一律拒绝；最终无delay、原父链、ACL、原对象 pin、未知关闭、安装选择及完整资格要求继续适用。当前行为与本机执行证据归 [Terminal owner](../../../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现)。

## Alternatives considered

- 删除 delay-import 检查或仅设置 LoadConfig：不能限制 delay helper 的动态加载，拒绝。
- 运行后设置 DLL 搜索策略：晚于第一批静态加载，且不能推定所有新子进程继承该策略，拒绝。
- 使用 LIEF 通用 PE 重建：已评估其导入修改接口；需要另一个构建运行时，通用布局重建增加 IAT 和 Bun 嵌入程序位置变化的风险。当前形状可在原存储内完成有界转换，因此不引入通用重建器。
- 新增节或扩充 headers：需要移动原数据或调整节／嵌入程序布局；当前采用容量不足即拒绝，不实现任意 PE 修复。
- 预建私有 compiler outfile：Bun 实际替换了该对象，仍生成不合格 DACL，不能解决；事后修改任意来源文件的 ACL 也不采用。
- 全局 define `import.meta.main=true`：会让依赖库的条件入口也执行，无法保持模块准入边界；采用固定 executable-only wrapper 显式调用原 verifier。

## Consequences

系统 DLL 将在进程启动时提前加载，缺少依赖或符号会提前失败；接受范围仅为已验证形状，未来 Bun 改变布局可能再次明确拒绝。原签名在新副本中不再代表修改后的字节，manifest hash 只提供完整性，不授 publisher／签名资格。

[字节回归](../../../../tests/isolated/unified-agent/windows-terminal-launcher.test.ts)覆盖原字节保持、ordinal／名称导入和各种拒绝；[真实 Windows 回归](../../../../tests/isolated/unified-agent/windows-terminal-runtime.test.ts)执行 Bun／SQLite／crypto／loopback HTTP，删除 source 后运行 standalone，并在 executable 目录和 cwd 放置无效 `dbghelp.dll`／`USERENV.dll` 验证阴影不被采用。Windows 使用当前实际平台，不以 availability skip 代证；其他平台只跳过 Windows 专用 syscall 用例。

[真实 Electron 回归](../../../../tests/isolated/unified-agent/windows-native-runtime.test.ts)完整复制已安装44.3.0分发，对新副本封闭7个EXE/DLL，准确版本和独立SQLite在空PATH／cwd伪造DLL及两个非DLL系统模块下正常执行，全部原分发文件SHA保持。提前加载让原可选系统模块或符号缺失在启动时失败；不能从本机通过推导所有Windows变体可用，实际窗口与安装生命周期仍独立验收。

依据：[PE 格式](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format)、[DEPENDENTLOADFLAG](https://learn.microsoft.com/en-us/cpp/build/reference/dependentloadflag?view=msvc-170)、[Bun compile API](https://bun.com/docs/bundler/executables)、[LIEF 导入修改](https://lief.re/doc/stable/formats/pe/modifications/imports.html)。完整 Native、跨代码升级、PTY、其他平台、发布者与正式发行资格仍按原门禁独立验证。
