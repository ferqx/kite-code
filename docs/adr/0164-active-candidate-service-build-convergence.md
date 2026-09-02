# ADR-0164：Installed active candidate 收敛常驻 Service build

状态：accepted

日期：2026-09-01

决策者：用户直接指令

相关：ADR-0152、ADR-0156、ADR-0159、`docs/deprecated/single-service-local-runtime.md`、
`docs/active/release-control.md`。

## 背景

ADR-0159允许兼容客户端通过Native `describe`跨`expectedBuildId`读取ready Service，以免源码checkout或dirty build为同一个
Kite Home启动第二个Runtime/SQLite writer。但manager把`describe`成功直接压缩成`ready`，丢失Service返回的actual build。
因此安装V2并切换active candidate后，新CLI/TUI仍可能长期复用V1 Service及其Web assets；既有installed previous-build
replacement只有fake client返回`incompatible`时才可达，与真实Service允许跨build `describe`的行为不一致。

build identity仍不等于wire compatibility，但installed active candidate还承担部署收敛责任。能够通信只能说明可以安全读取身份，
不能证明常驻Service已经来自当前candidate。

## 决策

1. Native `describe`继续跨expected build返回兼容Service的真实instance、build、version、HTTP origin和access capability；不得恢复
   build-as-wire-gate。
2. single-Service manager保留`describe`的actual build并按executable mode决策：exact build直接复用；source普通ensure只复用
   `dev:`→`dev:` drift；source↔installed返回`incompatible/build_mismatch`且不替换。
3. installed active candidate发现另一installed build时复用既有verified previous-build replacement：先验证active pointer，再把旧Service
   自报的build/instance/PID/start与reservation核对，以旧build client发送有界stop；confirmed absent后才spawn当前candidate，并再次读取
   actual build确认收敛。
4. inactive/退役candidate不得取得replacement authority，但其仍运行的TUI在双方均为installed build且Protocol/client-contract兼容时，可以
   通过只读`describe`与普通ensure复用当前Service并显式reconnect；exact-build `service_stop/restart`继续阻止其降级owner。identity uncertain、
   Protocol/client-contract drift和source↔installed既不复用也不替换。active mutation或Host-owned queued/running/waiting Session operation
   继续返回`service_busy`并保持旧Service ready；
   response不确定后只观察exact absence，不重放stop。
5. TUI `/status`显示client/service version、actual/expected build和派生version status。只有`dev:`→`dev:` drift提示`tui:fresh`；其他
   mismatch不得伪装成开发态操作建议。展示状态不新增持久化lifecycle state。
6. 当前Native protocol/client contract未提升，因此不增加bootstrap operation、后台upgrade watcher、持久化pending state或多版本兼容层。
   第一次真实protocol bump必须新增ADR，届时基于具体旧/新codec和发布消费者决定最小bootstrap compatibility contract；不能提前把
   speculative双交换带入普通startup。

## 局部替代关系

- 局部替代ADR-0159“所有兼容跨构建manager ensure都视为ready”的结论：只读发现继续跨build，source `dev:` drift继续复用；installed
  active candidate则必须收敛另一installed build。
- ADR-0159的single-Service、single-SQLite、exact lifecycle control、Protocol/client-contract fail-closed和禁止第二Service结论不变。
- ADR-0156的Service-owned Web assets不变；installed换代完成后Web root必须来自当前candidate Service。

## 备选方案

### 继续永久复用兼容的旧installed Service

拒绝。它让已安装版本、实际执行Runtime和Web assets长期不一致，也使Service修复无法确定生效。

### 每次build drift立即强杀并启动当前Service

拒绝。active Run、identity uncertain或stop response丢失时会破坏lifecycle authority和no-replay边界。

### 现在引入稳定bootstrap与自动pending-upgrade watcher

拒绝。当前没有protocol bump或后台自动换代产品要求；它们会新增普通startup exchange、兼容分支和运行状态，却没有当前生产消费者。

## 后果

- 新installed candidate首次ensure会在Service空闲且身份可验证时收敛到当前build；busy或不确定时保持旧owner而不spawn。
- 升级前仍运行的兼容TUI可在Service instance/token轮换后显式reconnect，但不能停止或降级当前Service；不兼容模拟客户端保持
  `spawn=0/stop=0`并返回fail-closed诊断。
- source开发仍可跨`dev:` build观察同一Service，并通过显式`tui:fresh`选择换代。
- `/status`不再把installed或混合模式mismatch误导为source drift。
- qualification必须用真实child证明旧installed build经成功`describe`后被当前candidate替换，且Web assets来自当前build。
- qualification还必须用门控Provider证明真实TUI Turn进行中时换代返回`service_busy`且old build/instance不变；Turn terminal后第二次ensure
  才能换代，并允许兼容旧TUI显式reconnect。多TUI qualification还必须证明busy response后mutation admission已resume、另一TUI仍可
  query/create Session、所有兼容旧TUI都能重连，以及waiting interaction与running model request同样阻止换代。
- real Native qualification必须在旧Service实际接受stop后丢弃一次response，证明manager不重发previous-build stop，只以exact absence收敛并
  启动current candidate；旧TUI随后只能接受新instance/generation。
- 若stop response丢失后old owner仍alive且absence未确认，本次结果必须保持`outcome_unknown`、`spawn=0`和old owner不变；不得把请求已发送
  推断为stop已接受，也不得在同一次ensure中重发。
- 多active manager并发换代不引入跨进程upgrade lock：每个manager最多发送一次stop，Service owner single-flight并发control requests，native
  lifecycle reservation继续裁决唯一spawn winner。不得为消除loser `EEXIST`另建持久upgrade intent或第二coordination root。
- current candidate启动失败不自动恢复或重启旧build：本次结果保持unavailable且不重放旧stop；后续ensure可以重试current spawn。未来若要求
  自动rollback，必须另立ADR并先解决Store schema与active pointer降级authority，不能隐藏在普通ensure catch中。
- failed current child在ready前留下reservation时沿既有dead-only stale cleanup处理：只有exact PID/start/instance/build reservation确认dead才清理；
  下一次ensure随后重试current spawn，旧installed stop仍不得重放。

## 回滚

回滚必须新增ADR。可以恢复installed兼容build长期复用，但必须同时恢复对应状态文案、真实child qualification与current authority；不得只删除
actual-build分支而保留“active candidate已收敛”的文档承诺。不得以启动第二Service或共享SQLite writer作为回滚方案。
