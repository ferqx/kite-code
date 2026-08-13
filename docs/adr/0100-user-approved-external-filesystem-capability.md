# ADR-0100：用户批准产生跨平台单次外部文件系统能力

状态：accepted

日期：2026-08-13

相关：ADR-0043、ADR-0077、ADR-0080、ADR-0081、ADR-0082

## 背景

macOS Seatbelt、Linux bubblewrap 与 Windows restricted-token 都默认把 Shell 写入限制在 Workspace，
但它们对 `/tmp` 和宿主外部路径的可见形态不同。旧链路虽然会把 `externalRead`、`externalWrite` 或
无法限定路径的命令送入用户审批，批准结果却只解除 Tool Approval；native filesystem ceiling 不变。
于是用户明确批准的 `/tmp`、Desktop 或其他普通外部文件操作仍会被 backend 二次拒绝，并且 Linux
私有 tmpfs、macOS `operation not permitted` 与 Windows ACL failure 产生不同表面结果。

这种行为把“用户是否同意”与“命令是否实际获得能力”割裂。审批卡描述的预期效果无法实现，也使
跨平台产品策略取决于 backend 细节。

## 决策

1. 当前交互式 development TUI/foreground CLI 采用统一的逐 invocation 文件系统授权语义。默认
   `workspace_only`；`externalRead`、`externalWrite` 或 `uncertainEffects` 必须先通过当前交互模式的审批，
   之后为该 invocation 投影 `filesystemMode=allow_all`。
2. `allow_all` 是执行前投影到当前 native backend 的 approved-filesystem capability。macOS 仍通过
   Seatbelt profile，Linux 仍通过 bubblewrap mount/PID/network namespace，Windows 仍通过去权
   restricted token 与 Job Object。它不是 host Shell、native failure fallback 或命令 replay。
3. 普通 Workspace-only 操作继续走 Seatbelt、bubblewrap 或 windows_restricted_token。纯网络批准继续
   使用既有逐 invocation network projection，不因网络审批自动获得外部文件系统权限。
4. Auto 模式先把需审批调用交给自动审批模型。模型判定安全时以 `approve_once` 等受支持 grant 产生单次
   文件系统能力并执行；模型判定有风险时升级为人工 Tool Approval，用户批准后执行；自动审批模型异常、
   超时、响应无效或不可用时同样升级人工审批。除这两类情况外，Auto 模式不得无故要求真人审批。
5. 凭据、Shell/Agent/IDE 配置、Git hook/config、启动项以及关键系统文件在审批前硬拒绝；危险路径检查
   同时覆盖 Shell 与内建 read/edit/write/search 工具。提权、关键系统路径删除和 Workspace 根删除继续
   使用既有 destructive deny。
6. 临时目录、缓存目录和普通 Workspace 外文件不是硬拒绝对象；取得批准后不得再因 Kite native
   Workspace sandbox 返回 permission denial。命令自身错误、宿主 OS ACL/TCC、磁盘状态和不存在的目标
   仍可产生真实执行失败。
7. 该 development capability 不等于 Full 或 production qualification evidence。当前 D-04 production
   support set 仍为空；未来 sealed production consumer 必须在 admission、native backend 与审批 UI 中
   共同声明是否支持这一 capability，不能把逐 invocation 扩权冒充平台 qualification。

## 后果

- macOS、Linux 与 Windows 对批准后外部文件访问使用相同产品语义，并由各 native backend 动态投影
  profile、mount namespace 或 restricted-token 权限。
- `/tmp` 在 Linux 私有 tmpfs 与 macOS 宿主路径之间的旧差异不再影响获批调用；获批调用操作宿主所指路径。
- 外部能力只扩大该 invocation 的文件系统视图；native 进程、网络、资源限制、超时、取消与进程树清理
  继续生效。固定极高风险规则仍在扩权前拒绝。
- 文件工具与 Shell 共用危险路径前置拒绝，避免同一目标因工具选择不同而绕过禁止规则。

## 替代关系

本 ADR 仅就“host Shell 只能作为 startup availability fallback”这一表述，增加一个用户明确批准的
逐 invocation capability 例外；它不改变 ADR-0077/ADR-0080 的 startup fallback、no replay 与 backend
qualification 结论。它替代 ADR-0081 中 approved external filesystem invocation 仍必须留在
restricted-token Workspace ceiling 内的隐含选择，不改变 Windows backend 的默认路径或 production
excluded 结论。
