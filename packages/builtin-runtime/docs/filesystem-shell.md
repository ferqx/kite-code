# 文件与 Shell 执行机制

入口：[filesystem](../src/filesystem/)、[sandbox execution](../src/sandbox/execution/)、[shell semantics](../src/shell-semantics.ts)、[policy compiler](../src/policy-compiler.ts)。

执行器接收已准备、绑定 identity 的参数与授权上下文，不自行扩大路径、网络或凭据范围。filesystem read/write、Shell 和 typed Git 各有机制，不能以显示名或“看起来只读”替代 effects 和 policy facts。

文件读取共享规范路径与范围检查；修改需保持目标、preimage 和发布边界一致。symlink、目标被替换、并发修改和原子写失败都必须保持明确结果，不能写到重新解析出的另一个对象。

Shell preparation 决定可执行环境与沙箱能力，实际 dispatch 后输出、退出码和 cleanup 归对应执行 port。执行前拒绝没有退出码；失败不保证没有副作用。Host 丢失或取消后的进程清理由 Host/platform port 承担。

平台能力、用户模式、精确审批与工作区信任分别生效。Full 不是配置出任意平台能力的手段，Auto 的不确定结果也不能凭工具说明静默放行。

修改后核对生产 dispatcher、policy 与实际 filesystem/process 测试。规范见[文件边界](../../../docs/active/file-reading-shared-boundary.md)、[执行边界](../../../docs/active/execution-boundary.md)、[Shell 平台](../../../docs/active/shell-platform-compatibility.md)。

验证：[read dispatcher](../test/filesystem-read-dispatcher.test.ts)、[mutation dispatcher](../test/filesystem-mutation-dispatcher.test.ts)、[preimage](../test/persistence/filesystem-preimage-artifacts.test.ts)。
