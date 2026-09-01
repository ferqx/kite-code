# ADR-0165：Source TUI 默认使用 invocation-scoped standalone Service

状态：accepted

日期：2026-09-01

决策者：用户直接指令

相关：ADR-0152、ADR-0159、ADR-0164、`docs/active/single-service-local-runtime.md`。

## 背景

installed TUI需要按canonical Kite Home共享唯一Service，以便多个客户端复用Store并由active candidate收敛实际build。源码开发入口此前也
复用同一endpoint：普通`bun run tui`遇到兼容旧`dev:` Service时继续使用旧源码，并要求开发者运行`tui:fresh`执行跨build换代。这让日常
source启动承担共享owner、build drift、busy replacement和旧进程恢复复杂度，也与“source默认standalone”的已选产品边界不一致。

## 决策

1. installed TUI继续按canonical Kite Home使用shared Service；现有active-candidate收敛、inactive-client reconnect与busy保护保持不变。
2. source `bun run tui`默认生成一个有界随机invocation identity并创建owner-only临时Runtime Home，用于派生Native endpoint并隔离SQLite、
   Artifact和运行状态。Service另从canonical Kite Home读取配置、Trust、MCP与Skills；不创建持久化descriptor、registry或locator。
3. source TUI退出时先关闭Session/client connection，再通过同build manager停止其composition-owned Service。setup失败也执行相同cleanup。
4. source TUI只有显式`--server shared`才连接canonical shared endpoint。当前不接受任意URL、remote/LAN或外部token；新增其他server target
   必须先定义认证、Trust与lifecycle ownership。
5. 删除`tui:fresh`入口、source previous-build replacement authority及其专用恢复分支。显式shared source连接发生`dev:` drift时只展示事实，
   不自动停止owner。

## 局部替代关系

- 局部替代ADR-0152/0159“所有source与installed客户端默认按Kite Home共享同一Service”的结论；installed及显式shared source仍遵守该边界。
- 局部替代ADR-0164关于普通source跨`dev:` build复用及`tui:fresh`换代的结论；installed build收敛结论不变。

## 后果

- 普通source TUI不会观察先前source或installed Service，因此正常启动不存在build drift提示或跨build替换。
- 同一配置Home可同时服务installed shared Service和若干source standalone Service；standalone各自拥有独立临时Store与endpoint，不产生多个
  Runtime owner写同一个SQLite。配置/Trust写仍落在canonical配置Home。
- `--server shared`是明确选择共享开发owner及其版本事实的调试入口，不拥有跨buildstop authority。
- qualification必须证明两个source invocation得到不同endpoint、未创建伪Kite Home目录，并在TUI teardown后停止各自Service。

## 回滚

回滚必须恢复source shared默认、`tui:fresh`及对应版本提示、测试和current authority，不能只把endpoint改回canonical而留下无owner cleanup。
