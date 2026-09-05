# ADR-0151：Web Gateway 先验证静态资产并以 exact launch intent 恢复失败启动

状态：accepted

日期：2026-08-30

决策者：用户直接指令

相关：ADR-0147、ADR-0148、ADR-0150，
[`Coordinator / Workspace Worker / Web 当前规则`](../active/coordinator-workspace-worker-web.md)。

## 背景

源码 checkout 在`apps/kite-web/dist`尚未构建时执行`kite web`，Gateway manager会先写`control.token`再spawn。
child在carrier创建期因静态目录缺失退出，未发布readiness；descriptor与instance lock都不存在，只剩无法绑定到exact
PID/start-token的credential。后续ensure为避免重复spawn只能fail closed，CLI又丢失typed原因，用户不得不理解并人工清理内部state。

浏览器、Vite dev server、Gateway与Coordinator/Worker的启动职责也容易混淆：浏览器页面不能承担本机server启动，Vite只服务asset，
而真正的Gateway还拥有loopback auth、Coordinator discovery和Worker Observer连接。

## 决策

1. Gateway manager必须在生成credential、写state或spawn前验证canonical static root、`index.html`、
   `api-docs/openapi.json`与至少一个allowlisted Vite JS asset；失败返回`web_assets_missing`，state保持空。
2. native spawn后，父进程立即读取child exact PID/start-token。只有取得该证明后才写入包含instance/build、process identity、
   credential SHA-256与时间的launch intent，再写credential。secret不进入intent或Coordinator wire。
3. readiness/spawn后失败时，manager用intent的PID/start-token复核process。confirmed dead才删除本次exact intent、匹配credential与
   matching instance lock；alive或uncertain保留证据，不kill、不重放spawn。
4. `kite web recover`复用同一lifecycle lock与no-process proof。descriptor/intent/instance lock能证明exact child已死时可清理；
   live、uncertain、identity drift及旧credential-only state继续fail closed。
5. Coordinator wire version仍为1，但strict protocol/client revision提升到v3并增加封闭的`web_*` lifecycle diagnostics；CLI必须显示
   diagnostic，不能只输出通用ensure failed。
6. 源码开发提供`bun run web:dev`：先Vite build，再执行同一asset preflight，最后调用`kite web` ensure并打印一次性URL。
   TUI/CLI按需ensure Coordinator/Worker；`kite web`按需ensure Coordinator/Gateway；Browser只连接现有Gateway；Vite dev server不等于Gateway。

## 备选方案

- 仅在文档中要求先build：拒绝。首次误操作仍会留下不可恢复state。
- 缺asset后无条件删除credential：拒绝。spawn outcome不确定时会丢失活进程证据并允许重复launch。
- 扫描PID或force kill后恢复：拒绝。PID不是exact identity，manager没有kill authority。
- 让Browser或Vite自动启动Gateway：拒绝。两者都没有Native lifecycle、credential或Coordinator authority。

## 后果

- 正常缺asset失败不再写任何Gateway state，build后直接重试成功。
- 父进程崩溃或readiness失败仍有hash-bound、path-free恢复证据；清理条件比credential-only marker更严格且可自动化。
- 旧credential-only残留没有exact process proof，仍需保守拒绝；新流程不会再制造该形态。
- protocol/client v3要求Coordinator、CLI、TUI、Worker与Gateway使用同一build/revision，旧strict peer按不兼容处理。

## 回滚

可以移除开发者便捷命令，但不得恢复“先写credential再验证asset”的顺序。若launch intent实现需要替换，替代方案仍必须在任何删除前
保存并复核exact PID/start-token与credential binding，保持unknown不重放、无force kill和typed diagnostic。
