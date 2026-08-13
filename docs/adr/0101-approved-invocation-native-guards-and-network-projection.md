# ADR-0101：审批能力必须可兑现并保留原生固定保护

状态：accepted

日期：2026-08-13

相关：ADR-0083、ADR-0085、ADR-0100

## 背景

ADR-0100 引入逐 invocation 的外部文件系统能力后，首次实现仍有四个缺口：网络客户端通过自身参数写入
外部文件时只投影网络能力；execution boundary 存在时 Shell 即使获得批准仍被强制断网；`full_access`
主要依赖命令字符串扫描保护凭据；Windows 又在未升级 wire protocol 和固定 runner 的情况下增加了新的
filesystem enum 值。

这些缺口会让审批卡描述的效果无法兑现，或让批准后的宽文件系统视图绕过固定高风险保护。

## 决策

1. Shell effects 必须按网络、外部读和外部写分别分类。`curl -o`、`wget -O/-P` 等客户端参数必须投影
   文件系统效果；无法证明方向的 `scp`、`sftp`、`rsync` 使用 `uncertainEffects`。
2. 当前交互式 development TUI/foreground CLI 中，获得 execution grant 的 network 或
   `uncertainEffects` invocation 直接向已选 native sandbox 投影单次 `networkMode=allow_all`。静态
   execution-boundary allowlist 不能产生一个随后仍被强制断网的虚假审批；未来 sealed production consumer
   若不能兑现受管网络能力，必须在审批前拒绝该调用。
3. approved-filesystem capability 仍在 native sandbox 内执行，并保留固定保护：Seatbelt 生成 home/
   Workspace 凭据与持久化身份 deny；bubblewrap 在 broad root bind 后以只读 bind 或隐藏 mount 覆盖既有
   固定身份；Windows approved token 携带 restricted-only guard SID，runner 为既有固定身份写入该 SID 的
   deny ACE，调用结束后移除。命令字符串检查仅是 defence in depth。
4. 内建文件工具在审批前同时检查 lexical path 与 canonical target，symlink 不能把受保护目标伪装成普通
   文件。
5. Windows invocation protocol 升级为 V6，runner 版本升级为 0.8.0。旧 V5 manifest 必须在发送
   `full_access` 前 fail closed；Windows canonical build 必须重新生成 runner digest 和 manifest。

## 后果

- 用户或 Auto 审批的混合网络/文件命令在三个平台获得相同维度的单次能力。
- broad filesystem view 不等于移除 native sandbox；进程、网络、资源限制和固定保护继续生效。
- 当前 production support verdict 仍为空。`allow_all` development grant 不能冒充 allowlist 或 Full
  qualification evidence。
- Windows runner source、manifest 与 binary 必须作为同一发布单元更新；旧 artifact 不再被误判兼容。
