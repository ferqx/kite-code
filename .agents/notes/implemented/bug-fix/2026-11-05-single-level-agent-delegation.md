# Agent Note: 普通委派只允许一层子 Agent

Status: implemented

## Problem

用户已明确只有主 Agent 可以创建直接子 Agent，子 Agent 不得再创建下一层。旧普通 worker 继承了创建工具，且受理入口没有此限制：浏览器不可用的默认配置中，下一层真实受理并读取了文件。浏览器开启时的配置身份错误只造成偶然拒绝，不能证明层级限制成立；任务提示也不能替代执行边界。

## Decision

Core 根据真实子 Session，在实际模型目录中按准确内置工具身份去除创建定义；模型可用目录和效果准入分别负责限制，不把注册存在当成创建授权。真正的新建拒绝归原 Host `operations.ensure`：先查准确旧回执，再读来源 Session 的持久父子关系，子会话新建 Agent 时以现有可信未受理资格明确拒绝。三种审批模式共享该入口，不增加身份或审批系统。

不在共用配置 resolver 拒绝所有子来源，因为它也服务协作者的续作。同一次执行先查准确原回执，直接协作者的消息、观察、停止和续作保留原语义；普通 Tool→自身 Job 沿原执行链运行。公开英文说明仅让子 Agent 将额外委派需求交回父 Agent，不引导换角色、工具或审批模式绕过。

## Alternatives considered

- 补齐下一层丢失的隐藏工具标记，让它能启动：违背用户明确的一层约束，保留该现象为排查证据，不将其实现成开放能力。
- 只隐藏模型工具或追加提示：自定义工具仍能走新建入口，因此还需实际会话关系校验。
- 在共用 resolver 统一拒绝子来源：会把新建限制错误应用到协作者的管理，改在原新建受理入口实施。
- 用并发上限代替层级限制，或增加另一套管理器：并发数量不表达父子层级，现有 Session 与原 Operation 入口已足够。

## Consequences

主 Agent 可以按原规则创建多个直接协作者；子会话的新建请求在准备配置及受理前被拒绝，Full 也不扩大层级。权限交集、准确身份、取消、未知效果和直接协作者管理继续由原 owner 核验，不为找回结果重跑工作。完整当前行为归[协作 owner](../../../../packages/agent/src/extensions/task/README.md)；[Core 回归](../../../../packages/agent/test/isolated/child/single-level.test.ts)与[Service 回归](../../../../apps/service/test/isolated/child-single-level.test.ts)分别验证执行边界和角色目录，固定本地模型不代替真实模型任务质量或客户端资格。
