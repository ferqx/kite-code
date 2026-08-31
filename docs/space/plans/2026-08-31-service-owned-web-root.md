# Service 同源 Web 根页面实施方案

状态：completed

日期：2026-08-31

优先级：P0

决策：ADR-0156、ADR-0157、ADR-0158

替代：[`Web REST 客户端收敛实施方案`](2026-08-31-web-rest-client-convergence.md)中的独立Web lifecycle部分；REST数据面与安全边界保持有效。

## 目标

```text
npm run server / TUI ensure
              ↓
one Kite Service · one loopback origin
  /              → Web index + read-only HttpOnly session
  /index.html     → Web SPA
  /assets/*       → static assets
  /api-docs       → API docs
  /v1/*           → REST API
  /_kite/*,/rpc   → Native Runtime
```

Service只有在上述同源Web资源与Runtime/API共同可用后才发布ready。不存在第二进程、第二listener、Web attach、Web status或Web stop。

## Tasks

| Task | 状态 | 产出 | 验证 |
| --- | --- | --- | --- |
| SWR-00 | completed | ADR-0156、计划与替代边界 | docs structure |
| SWR-01 | completed | static root进入exact child env；Service启动时验证并挂载 | executable/infrastructure/carrier tests |
| SWR-02 | completed | 曾将Native协议收敛为`web_launch`并删除Web lifecycle；由SWR-05继续简化 | local-runtime/CLI tests |
| SWR-03 | completed | source `server`/TUI入口、direct-root与真实child验证、current docs | default test、typecheck、release build/verify/smoke、docs、overengineering gates |
| SWR-04 | completed | 根路径直接200、root cookie bootstrap与canonical Web入口 | direct-root/browser REST、default/release/docs gates |
| SWR-05 | completed | 删除launch token、Browser exchange与Native `web_launch`；CLI/TUI返回稳定根地址 | Browser/CLI/TUI/contract/default/release/docs gates |

## 验收条件

1. `npm run server`构建Web、ensure唯一Service并打印稳定的同源根地址。
2. `npm run tui`构建Web并ensure同一个Service；无需额外Web命令。
3. Service根地址直接返回index并建立HttpOnly只读session；无需token/exchange即可读取Workspace/Session/History REST。
4. `web_launch/web_ensure/web_status/web_stop`不再出现在当前Native协议、CLI help、production composition或current docs。
5. 静态资源缺失时Service不发布ready；已有ready Service不从客户端接受另一个asset root。
6. Browser关闭/logout不影响Service；只有`service stop/restart`改变listener生命周期。
7. 完成owner tests、真实child、TUI启动、release smoke、文档影响与`overengineering-check`。

## 完成证据

- ADR-0156阶段曾验证`/index.html#token`与根路径302；ADR-0157/SWR-04已替代为`GET /`直接200 HTML并建立read-only
  HttpOnly session。ADR-0158/SWR-05进一步删除了launch token registry、fragment捕获、Browser exchange schema/route/client与Native
  `web_launch`；`agent web --json`现在输出`{"state":"ready","url":"http://127.0.0.1:<port>/"}`。
- 真实Browser验证同源GET允许缺失Origin但仍要求same-origin Fetch Metadata：页面状态为connected，显示`kite-code` 3个会话与
  `web-rest-client-convergence` 4个会话；cross-site GET保持403，logout仍要求exact Origin。
- 真实Browser在最终Service `http://127.0.0.1:53369/`保持根地址并显示`kite-code` 3个会话与
  `web-rest-client-convergence` 4个会话；没有fragment或exchange请求。TUI-first/Web-first/concurrent ensure由真实child suite覆盖。
- 默认测试通过366个workspace、98个integration与61个isolated files；全仓typecheck、Agent API、Runtime package与pre-release
  architecture Gate通过。
- macOS arm64最终dirty-source candidate `dbf884e55509866c4794e802`通过build、verify与release smoke。
- `check:docs-impact`、`check:docs`与最终`overengineering-check`通过。
