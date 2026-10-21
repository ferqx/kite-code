# Agent Note: 会话标签页与内置浏览器隔离

Status: implemented

## Problem

用户希望以浏览器式右栏统一新标签页和“变更”工具，并实际访问网页。远端页面不能获得应用的 preload、会话读取、Service 或文件权限；原文件 reader 的关闭资格和响应式布局不能被标签保活破坏。

## Decision

共享 UI 只拥有标签模型、导航展示与工具 slot；Native Main 使用独立内存 session 的 WebContentsView，应用主 frame 经有限 IPC 指挥 HTTP／HTTPS 导航，网页本身没有应用 preload。禁用 Node、webview、DevTools、权限申请和下载；外部协议不分发，HTTP 弹窗留在当前标签。最多8个标签，浏览器 Cookie 不落盘。

标签模型置于响应式 Group 之上，避免宽窄切换卸载 UI 后丢失网页历史。网页组件卸载只隐藏 native view，模型负责关闭；切会话／root 重载／崩溃／窗口关闭真正销毁。变更工具仅在活动可见时挂载，关闭或切换结束所属 GET。显示 metadata 和浏览器状态不能成为业务操作 authority。完整实现与验证归[Desktop owner](../../../../apps/desktop/README.md#会话标签页与内置浏览器)；[Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)与[navigationHistory](https://www.electronjs.org/docs/latest/api/navigation-history)定义宿主能力。

## Alternatives considered

- iframe：宿主实现较轻，但普通站点的嵌入策略会限制浏览，无法满足简单通用网页标签。
- webview tag：需要给 renderer 开启额外 guest 管理能力；当前功能只需 Main 拥有单向有限导航，因此不采用。
- WebContentsView：选用 Main 持有和独立 session，代价是原生 view 几何、窗口覆盖和销毁须显式管理。

## Consequences

此实现是简易用户浏览器，工具首页只有变更，不提供导入、扩展、下载或模型自动浏览。Main／preload 改动必须完全重启客户端；网页不随应用主题重写。真实窗口夹具与 DOM 测试分别核隔离／导航和 reader／响应式生命周期，不能代证所有外部网站或跨平台原生合成。
