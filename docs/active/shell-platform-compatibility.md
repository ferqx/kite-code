# 当前规则：Shell 工具平台兼容性

状态：active
最后更新：2026-05-26
最后验证：2026-05-26
范围：

- `src/core/tools/shell.ts`（Shell 执行、bash 选择逻辑）
- `src/core/tools/bash-path.ts`（bash 路径探测）
- `tests/shell-exec.test.ts`（Shell 集成测试）
- `tests/tools.test.ts`（Shell 工具单元测试）

读取时机：

- 修改 Shell 工具的 `buildShellInvocation`、`findSystemBash`、`findBashBinary` 或 bash 选择策略。
- 修改 vendored MSYS2 的内容或布局。
- Shell 命令在 Windows 上报 exit code 127 或其他异常错误。
- 新增 shell 相关的平台适配代码。

相关：

- `tool-gated-autonomy.md`
- `project-conventions.md`
- `file-reading-shared-boundary.md` — MSYS2 路径转换 + readTextContent 边界

验证：

- `bun test tests/shell-exec.test.ts`
- `bun test tests/tools.test.ts`
- `bun run typecheck`

---

## 1. bash 选择优先级（Windows）

三层降级策略，严禁更改顺序：

```
1. 系统 Git for Windows bash（通过 where git → 推导 ../bin/bash.exe）
2. Vendored MSYS2 bash（vendor/msys2/usr/bin/bash.exe）
3. cmd.exe（兜底）
```

## 2. WSL 桩排除（关键安全规则）

**Windows 10+ 在 `%SystemRoot%\System32\bash.exe` 放了一个 WSL 入口桩。**
该桩需要 Hyper-V，未启用时报 `HCS_E_HYPERV_NOT_INSTALLED`。

**强制规则**：
- 选择系统 bash 时，**优先通过 `git` 路径推导**（`<git>/../bin/bash.exe` 或 `<git>/../usr/bin/bash.exe`），不依赖 `Bun.which("bash")`
- 仅在 git 不可用时，才使用 `Bun.which("bash")`，且**必须排除 `SystemRoot` 下的路径**
- 判断逻辑：路径转小写 + 正斜杠后调用 `isWslStubPath()` 检查

## 3. vendored MSYS2 的 DLL 依赖

Vendored bash 依赖 `msys-2.0.dll` 及核心工具所需的其他 DLL（`msys-intl-8.dll`、`msys-pcre-1.dll` 等共 15 个）。如果新增或升级 coreutils，**必须用 `ldd` 检查所有新增 .exe 的 DLL 依赖，确保 DLL 已复制到 `vendor/msys2/usr/bin/`**。可从 Git for Windows 的 `/usr/bin/` 获取缺失的 DLL。

## 4. 测试必须 mock 环境依赖

`findSystemBash` 的核心逻辑（`gatherSystemBashCandidates`、`isWslStubPath`）是纯函数，不依赖文件系统或 PATH。**必须 mock `which` 函数**覆盖以下场景：

- 无 git、无 bash → 返回 null
- git 安装在不同路径 → 推导候选正确
- bash 在 `SystemRoot` 下 → 标记为 WSL 桩
- bash 在其他路径 → 不误判
- 大小写、正反斜杠变体 → 正确识别

**禁止仅依赖真实环境测试**——开发者的终端通常有 Git Bash，会掩盖 WSL 桩问题。

## 5. 集成测试走 TUI 真实代码路径

`tests/shell-exec.test.ts` 必须使用 `createSandboxExecutor`（与 TUI 完全相同的入口），而不是直接调 `shellTool`。确保工具选择、权限策略、沙箱配置等中间层也被覆盖。
