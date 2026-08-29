# 第十三章 Store 8 迁移运维

本章是解释性runbook；当前行为以`docs/active/release-control.md`、Runtime/SQLite/Service owner README、ADR-0150与源码为准。

## 13.1 适用范围

正式命令只处理一个已经完成Store 6→7 cutover、active pointer仍指向完整Store 7 generation的本地Kite home：

```text
kite maintenance migrate-run-store \
  --target-generation <fresh-generation> \
  [--kite-home <absolute-kite-home>]
```

`target-generation`必须是尚不存在的安全generation ID，例如`store-8-20260830-01`。命令不是startup migration；fresh home由普通
Coordinator ensure直接初始化Store 8，Store 6、Store 8、partial/corrupt layout或已存在target都会fail closed。不要手工移动SQLite、
删除journal/fence或编辑`active-layout`来“帮助”命令。

## 13.2 执行前条件

1. 停止所有会主动重新连接Kite的CLI、TUI与Browser tab；否则Worker的client activity hold会让迁移返回`active_work`或
   `maintenance_required`。
2. 确认没有仍在执行的Turn、pending Interaction、Tool/effect、Subagent、sandbox cleanup或未知external outcome。命令不会force
   cancel或把unknown伪装成terminal。
3. 使用目标installation对应的`kite` executable和同一absolute Kite home。不要同时运行两个migration命令。
4. 保留原Store 7 generation和全部journal/fence；迁移是copy-and-switch，不会改写source。

## 13.3 命令实际做什么

```text
CLI exact parser
  → authenticated stopCoordinator（control plane先draining）
  → manager确认Coordinator exact PID/start-token已退出
  → 持有Coordinator lifecycle lock直到pointer decision与cleanup结束
  → 锁内复核descriptor、endpoint、launch intent与instance lock全部absent
  → Gateway manager验证identity、请求stop、等待exact exit
  → Worker manager枚举持久scope、只停止idle Worker、等待exact exit
  → Host State settlement + SQLite authority/effect/WAL/source digest深检
  → 写source-bound fence/journal
  → copy Catalog + 全部Workspace Store到fresh Store 8 generation
  → Store 8 preflight与logical digest复核
  → atomic active-layout pointer switch
```

Coordinator wire version仍是1；current protocol/client revision v2只新增本地受认证`stopCoordinator` lifecycle method。Worker和Web Gateway
peer不能调用它。CLI不能提交`coordinatorStopped=true`之类的boolean，也不能绕过manager/Store检查。

## 13.4 结果与处理

成功输出一行closed JSON并以0退出：

```json
{"status":"committed","sourceLayoutGeneration":"generation-store-7","targetLayoutGeneration":"store-8-20260830-01","catalogDigest":"…","workspaceStoreDigests":[]}
```

blocked同样先输出closed JSON，但随后以非零退出。常见原因：

| reason | 含义 | 操作 |
| --- | --- | --- |
| `maintenance_required` | Coordinator/Gateway/Worker不能被精确证明已停止，或process/control identity不确定 | 关闭客户端，等待idle drain；查询并处理不确定owner后，用新的fresh target重试 |
| `active_work` | State、Interaction、effect lease、cleanup/recovery或external outcome未收敛 | 先通过现有Runtime recovery/interaction journey收敛；不要force terminal |
| `source_corrupt` / `unowned_workspace` | Store 7、Catalog、Workspace binding或State codec验证失败 | 保持所有writer停止，保留evidence，进入显式恢复决策 |
| `source_changed` | barrier后source digest/WAL发生变化 | 查找仍存活的旧writer；不得继续copy或双写 |
| `copy_interrupted` / `target_invalid` / `layout_invalid` | target copy、journal、manifest、pointer或preflight不完整 | 不启动writer；按journal/fence判断是否仍处于允许的pre-write窗口 |

response丢失时不要根据终端文本猜测成功。重新读取当前active pointer/journal/fence的权威工具仍是production ensure/preflight；直接重跑可能
因partial target而blocked，这是保留证据的预期行为。

## 13.5 回滚边界

- pointer切换前且target明确未写，只能依据ADR-0150 journal/fence的pre-write窗口丢弃该target；source保持immutable。
- pointer已切到Store 8但`targetWriteState=none`时，也只能由现有narrow rollback helper在全部identity/digest验证通过后回退。
- 任一Store 8新写、write state unknown、pointer/owner不确定后禁止自动回Store 7。保持blocked并执行新的显式recovery decision。
- 不允许同时启动Store 7与Store 8 writer，不允许`try Store 8 → catch → Store 7`。

## 13.6 验证与平台状态

实现变更至少运行SQLite、Runtime Host、Service/Coordinator、CLI、release migration、fault/soak、candidate build/verify/install smoke及文档门禁。
本地macOS结果不能代替GitHub-hosted macOS/Linux/Windows。任何hosted platform缺失migration command、ACL/no-follow、atomic replace、installed
candidate或rollback evidence时，该平台仍是pending/unsupported，不能用workflow定义或本地模拟升级为supported。
