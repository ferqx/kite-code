# Windows MSYS IPC 兼容层

本模块由仓库独立实现，在原无账户受限令牌下补齐 MSYS 信号管道和默认对象 ACL 的兼容性；不改变令牌 SID、权限范围、目录 ACL 或系统策略，不创建账户。原 runner 继续负责协议6、进程 Job、输出及清理。

构建生成 `ktipc.dll`。除 `RtlAddAccessAllowedAce` 的兼容适配外，导出均转发到系统 ntdll。适配只在原令牌含限制 SID、且用户 SID 不在限制集合时，为 MSYS 构造的相关 `GENERIC_ALL` SYSTEM ACL 保留原限制集合中已有的 Logon SID。普通文件访问掩码和其他 SID 原样转发；DLL 没有宿主代理或额外权限。

[本地运行时准备](../../packages/agent/src/jobs/windows-git-bash.ts)只改私有 MSYS 副本的 DLL 导入名称，不改已安装 Git 或机器代码。Full／已批准完整文件范围使用另一份未修改 MSYS 副本，避免与工作区受限进程共享不兼容的 user mapping，同时保持 Full 原始 ACL 行为。实际权限与生命周期由 [Windows owner](../../docs/active/windows-shell-sandbox.md)定义。

Windows x64 使用 `bun run scripts/release/build-windows-runner.ts` 构建；`cargo test --manifest-path native/windows-msys-compat/Cargo.toml` 核解析边界，实际 Bash、fork／管道、Git、并发及后代生命周期由 [Windows Shell 测试](../../packages/agent/test/isolated/jobs/windows-shell.test.ts)覆盖。本机生成转发导出，不分发系统 DLL 或 Git Bash。
