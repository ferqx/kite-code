# Agent Note: 紧凑审批浮卡与真实待执行输入队列

Status: implemented

## Problem

主、子 Agent 同时等待工具审批时，重复审批面板和完整请求挤占正文，根工具待批又隐藏权限入口，用户无法在当前页面改为自动审核。已经接受但未消费的提示词还缺少安全编辑、删除和真实执行顺序调整。通用取消与局部前端数组都不能提供这些保证。

## Decision

普通工具审批使用整个 Composer 上方的一张紧凑独立浮卡，以 `‹ 1/3 ›` 分页。当前项按原 Store／Interaction 锚定，新项到达不切走用户正在查看的项目。主 Agent 无名称；子名称仍按准确 Store／Session／Run 核实，随机不可变 Session identity 在固定图标和配色池中确定稳定外观，不依赖名称、渲染次数或当前 Run。

工具标签与等宽目标分层，长文本单行省略，全文通过原 Tooltip 查看，不保留详情展开。原附件 reader 自动完整核验后才授予回答回调。批准一次和“本次会话批准”仍只使用原请求实际提供的 `approve_once/same_command`，后者仅为本会话相同命令。普通 root／child 工具审批保留输入和权限入口；问答、计划及 MCP 特殊交互保持原合同。运行中主、子工具仍由最新持久模式和最终 dispatch read-set 决定，展示变化不签发授权。

队列属于同一 Composer 外框。真实 pending 提示词单行显示 Markdown、全文悬浮，支持拖拽、删除和取出编辑，无序号或业务状态串。编辑先精确撤回原 pending Command，确认成功后完整原文填入普通输入，由用户手动提交新的输入；没有编辑事务、取消、恢复或自动重提。附件等不能无损转为普通纯文本 draft 时禁编辑，仍保删除和排序。

Core 以独立 `pending_order` 和单调变更计数绑定队列 revision，真实 Runtime 按同一顺序消费，原 Command.seq、正文、附件和 digest 保持。`result.include` 保原槽；最终事务中已消费的输入不能撤回，更不能因此停止其 Run。Service／Client 以独立 capability 和闭合请求暴露读取、撤回及排序。

Main 保有完整观察、原文本、Main 分配的 operation ID、封闭请求及 journal。renderer 只选择已观察 ID。未知只查询原 ID，绝不重发；已撤回但尚未交付的编辑可显式查回原文，填入普通输入后 ack，不自动覆盖新草稿。ack 只表示交付编辑器，不表示草稿已经落盘。同 scope 普通校准保留队列 DOM 与悬浮层并暂停变更，换 Store、Session 或读取代次撤销原展示与操作资格。

## Alternatives considered

- 独立 Desktop 本地队列无法管理已被 Service 接受的输入，也不能保跨客户端、重启和实际消费顺序。
- 通用 Command 取消在消费竞争中可能触及已经开始的 Run，不能用于取出编辑或删除。
- 重写 Command.seq 会破坏历史出处和 cursor；仅调整前端数组则不改变真实执行。
- 带取消／恢复的编辑模式已由用户明确否决。取出成功即移除，重新提交是普通新输入。
- 每次刷新移除队列会使全文 Tooltip 失效；保留同 scope 节点和明确禁写分别满足阅读稳定与当前资格要求。

## Consequences

增加 Core 迁移0004及 Desktop 私有数据库v11，迁移资产、故障回滚、防 ABA、冷读和维护兼容均纳入回归。Main 完整观察和 journal 有界，超限明确拒绝，不截断正文或裁掉未决／未交付操作。未保存的普通草稿继续沿原显式保存合同。

实现与当前验证归 [Desktop owner](../../../../apps/desktop/README.md#原运行中消息队列)、[Store owner](../../../../packages/agent/src/storage/README.md#待消费输入的撤回与排序)及[授权边界](../../../../docs/active/authorization.md)。本机真实 Electron 候选验证原主／子 Run、权限切换、未派发重判、长 Shell、稳定队列 DOM、Markdown、拖拽、删除、编辑和手动新 ID 提交，进程正常退出。受控模型与 macOS 证据不代表付费 Provider、签名安装或其他平台资格。

实现通过相对冻结基线的差量整合回持久主目录，保留并行会话恢复任务和远端提交；未依赖临时工作树作为唯一交付副本。
