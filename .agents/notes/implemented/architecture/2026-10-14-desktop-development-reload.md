# Agent Note: Desktop 开发热更新与独立 Service 版本

Status: implemented

## Problem

2026-10-14 用户要求开发模式中的 UI 和 Service 修改保存后自动生效。原入口逐次构建静态 renderer 与固定 Service，依赖人工退出／重建。UI 需要保留编辑状态，Service 的 Runtime、原申请和使用权又要求确定的关闭与新实例准入；不能把替换代码等同于已停止旧工作。

## Decision

仅显式 `desktop:dev` 由可信 builder 固定 loopback Vite 地址／nonce，以及每次启动独立的认证父连接。正式 candidate 拒绝开发配置。UI 使用 React Fast Refresh；Service 在独立私有版本目录构建，第三方包打入 bundle，workspace 保原外部 source 与运行资产。监听 Service 及 Agent／AI／Client source，连续保存合并并串行处理，相同源码内容不重启。

父控制使用固定 `127.0.0.1` 上随机端口的 TCP 连接及编译到私有 Main 的 32 字节随机 token；认证后仅接受闭合版本 ID／SHA 请求，Main 自己派生版本路径。token 不在 argv、renderer、Vite 或日志。旧 caller／私有数据／paired 实际关闭及退出0先于新实例，按新身份启动，再同窗口重新加载 UI。历史和原申请保留，任务不自动重发；失去可靠回执或关闭失败停止继续切换。完整当前实现归[Desktop owner](../../../../apps/desktop/README.md#开发热更新与服务重载)。

2026-10-21 补充：父控制停止在连接／认证前也锁存，准确认证连接随后立即 EOF；通道停止后拒绝原 pending／后续 reload，原 unknown 不被新的停止或迟到成功覆盖。Main 的父 EOF／error／close 和 SIGINT／SIGTERM 等待同一自有资源收尾，菜单旧决定不能反向恢复调度。配套进程不再因默认5秒期限截断正常 drain；原完整退出取舍归[正常退出决定](../bug-fix/2026-10-21-paired-graceful-exit.md)。

2026-10-24 补充：工作树中缺少 formatter 导出的真实故障证明，外部 workspace 解析不在入口构建的验证范围内；原父连接在 Service 准入前报告 ready，进一步掩盖失败。构建后先以独立 Bun 实际加载依赖图，禁止自动安装、不进入入口 main 分支，有限等待并回收探测进程。开发 Main 只在原 Service／Client／私有数据准入完成后报告 ready；失败经原认证父通道返回有限错误码。父宿主失败返回非零并等待所属进程退出。外部源码摘要与入口字节分别核对，不以入口 SHA 代表所有运行代码。

同轮真实退出回归另发现，Vite 独立服务器的 SIGTERM 处理器会直接调用进程退出，绕过开发宿主的 finally 并留下版本目录。改用其 middleware 模式，HTTP 与 HMR 共用宿主端口，进程退出与清理归同一宿主；不删除或改写第三方内部信号处理器。宿主自己的处理器保留到清理完成，原认证、CSP、私有文件拒绝和正式候选边界不变。

## Alternatives considered

- 仅自动重启整个 Electron：会在 UI 编辑时丢失窗口和未保存状态，无法满足已确认的 UI 热更新体验。当前 UI 保窗口，仅 backend 变更重载页面。
- 在同一 Service 进程使用 Bun `--hot` 重新执行模块：原 Runtime／Worker／Job 的持有者不能仅按模块重执行证明已关闭；采用新的完整进程及原 paired 生命周期。
- 以继承 stdin 作为 GUI 父控制与生存通道：实际 Windows Electron 在 Vite 启动后立即收到 EOF 并退出0，首次写入也未解决。改用跨平台 Node Socket，同时保留 token、字节边界及串行／未知结果拒绝。
- 在应用目录生成外部第三方依赖的 Service bundle：实际启动无法从该目录找到只属于 Service workspace 的 `hono`。保留 workspace 外部解析以沿用 Worker 资产，打入第三方依赖以使独立版本可执行。
- 只扩大监听目录：外部 workspace 改动不一定改变入口字节，原 SHA 比较仍可能跳过重载；同步比较运行 workspace 的源码内容。
- 每次保存执行整仓类型检查：不能证明后台实际就绪，也扩大热更新成本；此处检查准确模块加载和原 Service 准入，完整类型检查继续属于独立验证。

## Consequences

UI 更新通常保持 React 状态；Service 重载会停止当前开发任务并重置未保存页面内存，持久数据继续属于原开发 Profile。Main／preload、原生模块、Worker 资产和依赖清单变更仍需重新启动／构建。编译失败保持旧服务并允许修正保存重试；未知生命周期不被包装成成功。

2026-10-14 Windows x64、Bun 1.4.2、Electron 44.3.0 实际窗口已验证共享组件即时更新、未发送草稿保留、UI 更新零 Service 重启、Service 自动换 PID／旧 PID 退出、同 Main／Store、编译失败保服务及下一次保存恢复，未调用 Provider。纯配置／父认证／队列／真实版本与 Vite 拒绝边界归[配置测试](../../../../apps/desktop/test/development.test.ts)及[协调测试](../../../../tests/isolated/unified-agent/development-desktop-reload.test.ts)。这些证据仅覆盖开发热更新，不代正式 Native、其他平台或模型执行资格。
