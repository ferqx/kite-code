# ADR-0084：Windows 受管联网身份采用显式一次性 onboarding

状态：accepted

日期：2026-08-06

相关：ADR-0081、ADR-0082、ADR-0083

## 背景

ADR-0083 证明 approved `allow_all` 需要真实 `KiteSandboxOnline` 登录会话，才能让 Schannel 客户端在
restricted-token backend 中正常工作。最初实现把账户安装挂在首个已审批联网 invocation 上，并通过
临时 pipe 把明文凭据交回原用户做 user-scope DPAPI 持久化。实机中这造成两个问题：普通 Shell 命令会
意外进入 UAC/账户创建 control plane；账户已经创建但凭据 state/receipt 尚未提交时，会留下难以诊断的
半完成状态。

Codex 的强 Windows sandbox 把 setup 作为首次 onboarding 的独立阶段：setup 创建受管身份并持久化
machine-protected credentials/readiness marker；后续命令只使用已完成状态，不负责安装。Kite 当前仍是
lower-assurance development backend，但可以采用相同的生命周期与 credential custody，不必等待完整
Offline/WFP profile。

## 决策

1. 受管联网身份 setup 是独立 control-plane 操作。TUI 在进入主界面前运行只读 status probe；若状态
   missing/invalid，必须展示明确的 setup/exit 选择。CLI 提供 `sandbox status` 与 `sandbox setup`。
2. 只有用户明确选择 setup 后，unelevated orchestrator 才可用固定 runner 的 `runas` helper 请求一次 UAC。
   普通 startup structural probe、local Shell、已审批联网 Shell 与 cleanup/repair 都不得触发提权。
3. elevated helper 创建或轮换固定非管理员账户 `KiteSandboxOnline`，验证 SID 与登录结果，以
   machine-scope DPAPI 保护随机密码，并把 state 写入发起用户的
   `%LOCALAPPDATA%\kite-code\managed-network`。state root DACL 只允许该用户、Administrators 与 SYSTEM。
4. credential state 原子写入后，readiness marker 必须最后提交。失败尽力写结构化 error report。status
   只有在 marker/state version、username、SID、DPAPI 解密和真实登录全部通过时才返回 ready。
5. `networkMode=allow_all` command path 只消费 ready state。missing 返回
   `managed_network_setup_required`，invalid 返回稳定 identity/state 错误；不得自动调用 setup，不得回退
   current-user restricted token 或 host Shell，也不得重放用户脚本。
6. 当前决策只为 ADR-0083 的 Online 身份采用 Codex-style setup lifecycle。它不创建 Offline 身份，不安装
   WFP/防火墙代理规则，也不把 windows_restricted_token 提升为 Full 或 production-qualified backend。

## 后果

- 换机或首次安装不需要用户手工创建 Windows 账户；TUI onboarding 或显式 CLI setup 负责一次性安装。
- 普通 Shell 执行与网络工具审批保持可预测：工具审批不会嵌套 UAC，也不会留下“命令已开始但 setup 未完成”状态。
- 标准用户可在 UAC 中使用另一管理员凭据；凭据 state 仍写入发起用户指定且受限的 state root，而不是
  管理员 profile。
- machine-scope DPAPI 依赖 state DACL 保护读取范围，因此 DACL 设置、marker-last commit 与每次消费时的
  SID/logon 校验都是 setup contract 的组成部分。

## 对既有决策的影响

本 ADR 取代 ADR-0083 第 3 项“首个 approved invocation 可安装账户”以及第 4 项中用于安装凭据交付的
临时 pipe 部分。ADR-0083 的 Online 登录、restricted token、managed command pipe、ACL lease 与 protocol
V4 决策继续有效。
