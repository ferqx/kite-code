# Agent Note: 桌面右侧标签数量

Status: implemented

## Problem

网页、文件和工具占用同一右侧标签栏。第九个标签会被拒绝，详情打开失败时还会在会话标题下插入提示。用户要求取消标签数量上限和满额提示。

## Decision

共享标签模型、Electron 页面创建、Native 页授权准备和同 scope 恢复清单一起移除八页限制。重复请求仍按准确目标选择已有标签。选中项滚入可见范围，关页失败时按原身份合并恢复，原标签和关闭控件直接反馈结果。

## Alternatives considered

- 仅移除共享 UI 的检查会容许创建空标签，但真实网页创建和恢复仍会在第九页失败。
- 提高固定阈值会把同样的阻断推迟到新的页数，无法满足已确认的行为。
- 在右侧标签栏显示关闭结果会下移工具栏和网页内容。原标签恢复后仍可再次关闭，用户要求移除这条重复反馈。

## Consequences

Main 继续持有已导航的网页，直到明确关闭或宿主退出。每个存活网页都占用 Chromium 资源，工具和详情 reader 仍只由可见活动页持有。页授权、控制权、有效期、请求背压和同 scope 恢复校验继续独立于打开的标签数。替代[浏览器隔离](2026-10-20-sidebar-browser-isolation.md)、[子详情标签](../feature/2026-10-21-native-child-detail-tabs.md)和[执行轨迹](../feature/2026-11-08-trajectory-workbench.md)决定中的数量部分。当前行为和验证见[Desktop owner](../../../../apps/desktop/README.md#会话标签页与内置浏览器)。
