# Agent Note: macOS MCP 连接使用独立 owned resource coalition

Status: implemented

## Problem

正式 MCP stdio 连接需要正常RPC和允许派生进程的本地工具，结束时必须收束自己的后代。继承PGID不能覆盖setsid／orphan，Node已回收根后数值组也不能继续充作准确所有权。既有两进程出生／退出记录只说明已知PID，不证明完整树；冷结果不得建立新的连接或控制权。

## Decision

保持原可信准入、connection Job、完整输出和冷读接口。Service直接创建私有broker，同一built guardian资产由本用户launchd以固定MCP标签启动；秘密握手核准确guardianPID后才传配置。fresh guardian在业务前取得稳定unique／pidversion／resource coalition且kernel count=1。自然根退出、cancel与父EOF／SIGKILL收束同一次closing；仅原成员的audit-token信号，原guardian仍匹配且kernel count=1、原server真实exit／reap才确认树空。broker再核准确label absence、原dev／ino私有目录清理及guardian原identity absence。认证前broker死亡且无业务时，guardian连接失败仅凭原独占count1清理自己的准确注册；没有terminal不补造成功。

closed v2严格区分三角色：broker和server的所属父方可观察exit／reap；launchd guardian只存真实出生／PPID1／kernel终态，exit保null。原六字段binding和owner由lifecycle再次核对，读证据不成为authority。旧v1保原两进程语义，不升级为树证明；nonce、配置、env和秘密不持久保存。正式default Service固定原Profile coordination，独立可信装配可选绝对controlBase。这里没有借用Shell的权限、sandbox或coalition；原Shell held-root／exact reap合同保留。

## Alternatives considered

- 继续PGID或PPID census：真实setsid／reparent可以逃组，枚举不足以证明没有短命后代；不能满足完整连接退出。
- 扩Darwin owned-child的stdin／原生pipe：可复用held-root，但本次MCP已有正确ChildProcess输入／输出和真实reap，增加native写端会扩实现及验证范围。独占coalition空树已覆盖其直接根和所有后代，不需要在已回收根上再次组信号。
- 把旧guardian字段重命名语义却仍填reaped：实际launchd是父方，Service只回收broker；会伪造退出事实。选择新closed v2并保v1冷兼容。
- 套用默认Shell Seatbelt：MCP没有该文件／网络授权合同，复用隔离权限会改变工具行为；只复用所有权和私有transport primitives。
- 将本次coalition或FD命名为全Runtime resources／handles：覆盖范围及指标不符，完整资格仍拒绝。

## Consequences

依赖同已验证Shell基础的launchd和固定libproc ABI，当前本机范围macOS arm64／Bun1.4.2，其他平台仍明确unsupported。身份漂移、容量不足、失联或准确清理失败保持unknown；没有外部owner代启动daemon、任意同UID对抗或OS资源限额承诺。远端Tool效果仍不能由transport收束证明撤销或停止。

唯一新增逃逸验收放入原自然退出整例，保原完整RPC／cancel／EOF／SIGKILL／cold消费者与预算；认证前broker强杀对应源码审查发现的真实注册清理缺口。原失败和实际复验由[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10正式-mcp-完整所属进程树与旧组路径退役)维护，当前机制由[MCP owner](../../../../packages/agent/src/mcp/README.md#显式-stdio-guardian-port)维护。原[Shell决定](2026-10-07-macos-host-shell-owned-coalition.md)继续约束其独立权限与held-root，不被本决定替代；[资源采集决定](../testing/2026-10-08-blocked-full-workload-collection.md)继续约束原增长门槛和全局unsupported。
