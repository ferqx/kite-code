# Agent Note: Darwin Browser 复用独占 coalition 监督

Status: implemented

## Problem

Agent Browser 原实现把就绪、终态与目录扫描绑定 Linux namespace。macOS 上需要拥有真实 Chrome 的完整派生进程，并在取消、父进程丢失、失败与服务关闭后核实停止；CLI退出或进程组为空都不足以证明完整停止。

## Decision

复用原 [launchd broker](../../../../packages/agent/src/platform/process/darwin-launchd-supervisor.ts)、[独占 coalition](../../../../packages/agent/src/platform/process/darwin-owned-coalition.ts)与已打包 stdio guardian 的原生程序能力。固定 `--browser-owner` 分支使用自己的 Browser label与nonce，不创建MCP Session、权限或模型循环。改变cwd与launchd启动留在独立broker中。

Browser owner校验三角色的准确PID/birth、原coalition身份及daemon的真实宿主PID；原Linux localPid合同保持。最终要求原daemon实际reap、内核coalition task count回到1、guardian消失、准确注册清除及broker和FD完整关闭。未知保留目录、句柄与原名额；不从bootout或单个进程退出推断停止。Darwin扫描以原父FD相对枚举、no-follow元数据与openat进入目录，关闭失败保sticky unknown。原预算保持。

## Alternatives considered

- 只放开平台guard或改用CLI／进程组：不能证明daemon与Chrome脱离进程组的后代停止，不采用。
- 把Browser伪装成MCP连接：会混淆能力与所有权，不采用；仅复用原生guardian资产，Browser保持独立注册身份。
- 重新实现完整Mac监督器：重复已有经过真实fork／setsid与父死亡验证的原语，不采用。
- 使用`/dev/fd`或普通绝对路径代替Linux扫描：实际Darwin目录读取不等价，且路径重开会丢失父锚定，不采用。

## Consequences

Agent仍通过原Tool／Job／Query／Action运行；浏览器安全沙箱不关闭，用户日常Profile不导入。共享guardian新增可选的有界组合输出停止门槛，普通MCP默认语义保持。macOS需要已构建资产，冷import不启动程序。真实Runtime／Chrome、本机窗口与模型、Linux原生和installed资格分别核对，不由代码存在相互授予。准确实现、验证与未定位的共享回归间歇失败归[Browser owner](../../../../packages/agent/src/tools/browser/README.md)。原[Shell决定](2026-10-07-macos-host-shell-owned-coalition.md)与[MCP决定](2026-10-10-macos-mcp-owned-coalition.md)继续指导各自能力，没有被替代。

## Validation boundary

代码决定及接线已实现，故保持 implemented；它不是最终实机验收声明。44／83断言、真实窗口／gpt-6-luna与父死亡通过均早于最后控制校验及共享内层EOF修改。截至v1审查包，最终修改仅通过受控mock与静态检查；当时新的真实启动已被自动审批拒绝，原unknown绑定缺证与目录保留，不能用当前进程缺失补历史完整停止。父死亡夹具只核一次ps父链快照中成员的PID/birth消失及label缺失，不独立证明原coalition全部成员；源码调用coalition stop另为实现事实。

取消期间合法ready只接收准确所有权证据，不兑现public ready；真正畸形或已超时unknown保持sticky。共享通道不以首terminal提前结算，须完整帧、串行回调、EOF和关闭，缺EOF／close有界失败。Shell／MCP guardian本身发送terminal后退出，不依赖broker先关通道；fake回归覆盖关闭顺序，但不能替代修正后的真实平台资格，也不解释旧MCP间歇失败。

2026-10-27 05:33 UTC，收到针对一个受限独立实例的新授权后，用与v1源码匹配的重新构建guardian完成一次真实native ready／本地快照／准确取消／完整终态与目录清理。旧unknown保留；这只为最终native闭环补资格，不重验44／83、真实模型或Desktop A-B。追加后台后续模型工具要求在该实例已关闭后收到，未擅自再开。

后续05:53 UTC的明确授权窗口轮以最终v1源码取得后台继续新发5个模型Tool、独立页面计数及Run completed的主要证据，一个owner清理confirmed。初始已知snapshot参数失败使driver过严全Tool总断言退出1，辅助回A／UI关闭未执行；独立证据校验与Service原Job ended／dispose收束分开记录，不把整脚本涂绿，不为补辅助步骤重跑。详细时间与限制归Browser／Desktop owner。
