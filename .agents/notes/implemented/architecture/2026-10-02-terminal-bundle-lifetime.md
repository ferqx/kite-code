# Agent Note: 可搬迁终端闭包与独立制品使用权

Status: implemented

## Problem

V1.3 新 CLI/TUI 在 checkout 内以构建后的 Service entry 启动，不能据此保证离开源码目录仍有正确 npm 依赖、Worker、监督进程和 Web 资源。安装升级需要保留运行中的原制品；启动 CLI 退出后，独立 daemon 仍可能读取该制品。业务 profile 锁也不能代表发行目录仍在使用。

本决定适用新通用终端候选这一已交付切片。根正式/default/CI入口已选择新闭包，完整发行与跨平台仍由 [V1.3](../../../../docs/plans/unified-agent-refactor-v1.md)约束，当前行为见[终端 owner](../../../../apps/cli/docs/terminal-release.md)。

## Decision

候选包含新六 workspace 的真实构建输出、固定 Bun、实际 package-local npm 图以及宿主资产。闭合 manifest 保存全部普通文件摘要与内部相对链接，整体 manifest 字节形成 candidate ID。入口只使用该候选，公开 Client 契约保持原有限身份。私有 startup 增加可信闭合 `runtimeProtection:{kind,root,manifestSha256}`，不向 Model、JSONC 或 HTTP 开放。独立 Service 的 shared tree verifier 在实际 entrypoint/Bun/build 与原 manifest 全部一致后，才将完整 candidate root 用作默认 Files 的保护范围。

依赖图保留包自己的解析边和多版本身份。归档仅保存普通文件及 manifest 链接声明，先验证归档 SHA，再校验路径、正文、链接与完整物化结果。未签名清单只提供完整性；source commit/dirty 不替代发布者认证。

安装以完整校验且 fsync 的不可变候选加原子 current/previous 指针发布。运行中的宿主持有候选外固定 sibling OS shared 使用锁，独立 Service/daemon 自持 lease；原 Runtime、Workspace handles 和 streaming/readers 全部确认关闭后才释放，失败保持 lease/listener 诊断。卸载须完整枚举管理范围并取得所有 candidate 的 exclusive 使用锁；它不操作业务数据或猜测进程。回滚只交换代码指针，不能回滚数据。

## Alternatives considered

- 直接把旧 OSS 候选选择器和 Store 发布协议套到新包：旧清单与运行契约绑定旧可执行入口、文件数量及 Store 维护，不足以证明新目录闭包；初期保留旧正式入口并分别验收；当前根正式/default/CI已使用新工具，完整能力与平台仍按各自证据核对。
- 将 CLI/TUI 入口直接打包宿主源码并使用根目录 npm 依赖：真实搬迁暴露 `ink` 解析位置丢失；改用公开 CLI 子路径，并保留 package-local 图，不通过根目录扁平依赖掩盖多版本与 peer 关系。
- 只由启动 CLI 持有候选 lease：CLI 的 server start 返回后 daemon 继续工作，卸载可能删除其后续读取的资源；Service wrapper 因此必须自持 lease。
- 在 Service 再复制一份 CLI manifest verifier，或由 Service 依赖 CLI：同一 closure 的判断会漂移，也会倒置 workspace 依赖；抽取 Service 的独立 runtime-assets leaf，由 CLI wrapper 复用，纯 parser 与实际 IO verifier 分开。
- 以裸 builtin 名称跳过 manifest 中的 npm dependency：真实 parser 的 `tr46` 调用 `punycode/`，完整 tree 检查仍会漏掉尚未复制的包；声明依赖必须按实际 package-local 解析图复制，只省略显式 `node:`/`bun:`。
- 将归档中的真实 tar links 直接交给通用解包器：链接与路径交错使写入边界难以核实；本实现先核普通字节，再按封闭 manifest 重建内部链接。

## Consequences

候选包含较多文件且启动会完整核验，复制、归档和安装成本高于单入口 hash；它使实际运行闭包可独立复验。安装使用锁与 Profile 锁职责分开，不能互相授权。解压输出有显式字节边界；这不限制 Run 的语义容量。

真实 macOS 测试覆盖搬迁后执行、固定模型一次 Run、Worker 读取原历史、共享 TUI/daemon、active 更新和回滚后旧实例持续、live lease 拒绝卸载、停止后删除安装内容并保留独立数据。负例覆盖未知空目录/外部 hardlink、篡改、路径穿越、sidecar 链接覆写与候选内部输出。测试升级候选来自同一 bundle 的不同 productVersion，不冒充已发布 predecessor。断电、Linux/Windows、签名、生产 sandbox/exporter 和完整 §35 均仍待各自资格；不能由该 Note 的 implemented 推定完整 V1.3 完成。

公开 builder/default native paired 与实际 daemon 的独立资格为 1/23，两次完整候选实跑证明子进程接收原三字段 proof、保护完整 closure、邻接普通文件读写成功、CLI 父退出后 candidate 仍 busy、准确 stop 后才 free。裸 npm/builtin 碰撞的 actual installed graph 另行运行 JSDOM 与 Unicode URL，缺必需包明确拒绝。这些资格不替代 cleanup IO failure、custom 单文件全部依赖、正式安装或其他平台；仍按当前 owner 和进度的有限范围判断。


正式 Terminal manifest 现绑定实际包内 SQLite 引擎及完整 standard/native 四入口；根正式前门已选择该候选，Source/显式选择不读取安装登记。Native outer 包含完整 inner，Main 与 Service 各持两 root。Node 原锁 owner 与继承 Bun helper 的 close-only 副本，在实际 release/exit/SIGKILL 和双 holder 中核实：helper 不执行 UNLOCK，最后 holder 关闭后才 free；本机 8 tests/201 assertions，不扩为 Windows inherited lease。

新的双 prefix 登记与准确 nonce CAS、标准命令实际选择、卸载恢复及父 shell cache 限制，见[Native 登记决定](2026-10-04-native-complete-closure-and-cli-registration.md)；Bun/Node 独立固定引擎与 Worker 单次 loader，见[SQLite 选择决定](2026-10-04-selected-sqlite-engine-and-worker-identity.md)。这些是已交付切片，不把对应 Note 状态作为全部能力、平台或发布者认证通过。
