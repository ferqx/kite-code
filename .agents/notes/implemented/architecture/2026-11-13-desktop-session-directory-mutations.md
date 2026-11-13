# Agent Note: 桌面会话目录操作与阅读选择分离

Status: implemented

## Problem

用户要从会话行菜单重命名或删除任意可见会话。原 Main 管理入口只接受当前阅读选择，切换选择会释放读取并可能触发会话激活。

## Decision

普通菜单通过 [Main](../../../../apps/desktop/electron/native-caller.ts) 观察当前可用目录中准确的根会话，随后在 [会话管理控制器](../../../../apps/desktop/electron/session-management.ts) 复用已有命令、修订与回执校验。目录观察的生命周期与阅读选择分开，并只接纳一次变更。会话分叉继续由原选择管理。

## Alternatives considered

- 临时选择菜单所在会话，再调用原管理入口。这样会扰动当前的阅读与输入，迟到选择也可能改变操作归属。
- 在 renderer 根据目录缓存拼装控制命令。这样会让展示缓存承担修订与身份校验，且需要重复已有的命令和结果未知处理。

## Consequences

Main 需要维护目录观察并在目录失效时撤销。外部改动仍由最新 view 与服务端 CAS 仲裁。迟到回执只更新对应行，当前阅读仅在自身已确认删除后退出。具体操作、证据与范围见 [Desktop owner](../../../../apps/desktop/README.md)。
