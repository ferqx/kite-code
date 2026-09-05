# Kite Web UI Design System实施方案

状态：completed

日期：2026-08-31

优先级：P1

## 目标

在不改变single-Service REST、Browser权限或持久状态的前提下，为Kite Web建立可维护的Light/Dark视觉系统、清晰的信息层级和
Agent-operable view contract，并以真实Browser响应式检查作为验收证据。

## Tasks

| Task | 状态 | 产出 | 验证 |
| --- | --- | --- | --- |
| KUI-01 | completed | 当前页面、组件、状态与布局审计 | source + Browser baseline |
| KUI-02 | completed | semantic token、Light/Dark主题与owner-local规范 | Web typecheck/test/build |
| KUI-03 | completed | Sidebar、Header、Timeline、Tool/Empty视觉收敛 | desktop/mobile Browser |
| KUI-04 | completed | accessibility、responsive、console与视觉验收 | 3 viewport × 2 theme |
| KUI-05 | completed | overengineering、docs-impact与阶段收口 | repository gates |

## 验收条件

1. 组件不硬编码Light/Dark颜色，所有主题差异由semantic token承载。
2. Workspace、Session、connection、History和Tool状态不只依赖颜色表达。
3. 1280、1024和390宽度下不存在不可达关键操作或页面级横向溢出。
4. 真实Browser Light/Dark均展示现有Workspace/Session数据且console无error/warning。
5. 不新增该阶段未要求的Server API、Browser mutation、持久偏好、第二UI framework或无当前消费者的future Inspector scaffolding。

## 完成证据

- `apps/kite-web` typecheck、Vitest测试与Vite production build通过；主题切换、Docs accessible name与Disconnect缺席进入App test。
- 真实Store 9数据在Dark/Light均显示2个Workspace、7个Session与selected state；Browser console为0 error / 0 warning。
- 1280×默认viewport、1024×768和390×844下`scrollWidth === innerWidth`；390px保留可读connection subtitle、具名图标操作与modal drawer。
- 长Session ID下Sidebar 304px、Viewport 283px、内部wrapper 283px保持一致；item `scrollWidth === clientWidth`，文字使用ellipsis而不撑宽容器。
- overengineering检查删除无consumer的`shadow-float`并保持Dark确定性默认；没有theme persistence、system-sync分支、第二framework或无consumer的future panel抽象。
