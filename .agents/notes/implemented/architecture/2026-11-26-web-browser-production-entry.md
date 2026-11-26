# Agent Note: Web 生产包依赖入口

Status: implemented

## Problem

只读 Web 从共享 UI 的聚合入口使用目录和历史组件。Bun 构建把浏览器用不到的桌面图表、公式和代码高亮依赖打进 `/app.js`。开发入口和 Terminal 各自构建 React，未显式选择生产版。审计在 Chrome 实测启动脚本为 11.4 MB。

## Decision

Web 从 [UI 浏览器入口](../../../../packages/ui/src/browser.ts)复用原组件。开发 Web、Terminal 制品和实机切换夹具共用 [Bun 生产构建](../../../../apps/web/build-assets.ts)。继续按固定三项资产的清单和字节核验装配只读 Gateway。

## Alternatives considered

- 构建独立 chunk。对照中静态入口图约 5.78 MB，需要让开发和安装宿主验证并提供更多脚本。精简共享 UI 入口后单文件约 4.93 MB，且与现有资产读者兼容。
- 仅指定 React 生产版。对照中仍需约 11.12 MB，桌面依赖仍在产物中。

## Consequences

Web 新增共享组件时明确声明浏览器需要的导出。现有 Markdown、诊断及目录控件继续沿原组件和公共 Browser Client。实际客户端及构建回归归[Web owner](../../../../apps/web/README.md#有限可信资产)。
