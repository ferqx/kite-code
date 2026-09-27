# Agent Note: 产品手册、内部实现说明与当前知识

Status: implemented

## Problem
旧文档需要读者拼接 Agent Note 替代链，并在 Space、Book 和 owner 文档间选择事实。不同 Agent 会话由此容易误解已定义产品行为。

## Decision
产品手册按共享概念与客户端指南/参考定义预期，workspace 与 active 解释实际实现和约束。源码、测试与手册冲突时明确核对，不简单把代码现状升级成产品承诺。

取消 Space；有效计划归 plans，必要证据归发布/测试消费者。过期 Agent Note 和 Book 提炼有效知识后从当前树删除，不改写历史正文，Git 保留过程。

替代 [Agent Note 0140](2026-08-26-workspace-documentation-authority-v2.md) 中“代码路径变化必须有某份关联文档 diff 才能通过”的门禁策略：V2 继续提供 owner 映射及 all/staged/range 作用域；未改文档只提示核对，结构、路径和必要验证错误仍阻断。导航与历史不能代替当前文档，普通重构不得制造无意义文档修改。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
功能说明和实现说明各有负责位置。TUI、Web 的差异明确记录，不抽象未来客户端。维护流程见[文档维护](../../../../docs/development/documentation.md)，当前知识不依赖历史替代链。

## Historical relationships

决策者：用户明确要求实施多客户端文档重构
