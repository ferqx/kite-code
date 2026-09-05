# ADR-0157：Service 根路径直接返回 Web 并建立 Browser session

状态：accepted

日期：2026-08-31

决策者：用户直接指令

相关：ADR-0156。

## 背景

ADR-0156将Web与Service合并到同一个listener，但为了把one-shot token交给Browser，选择`GET / → 302 /index.html#token`。这会让浏览器
地址栏暴露构建产物文件名，使根地址看起来仍像转发到另一套Web入口，而不是Server自身的默认页面。

## 决策

1. `GET /`直接读取并返回同一Service-owned `index.html`内容，状态为200；`/`是唯一规范产品入口，不重定向到物理文件名。
2. 根页面GET是无业务数据的只读导航。Service在该响应中创建或复用短期、HttpOnly、SameSite Browser session；Web加载后可直接以cookie
   调用同源`/v1`，不要求URL fragment。
3. Native `web_launch`仍为CLI/TUI签发one-shot URL，但URL形态恢复为`origin/#token`。Web捕获fragment时继续执行exchange并轮换cookie；
   没有fragment时验证根响应已经建立的session。
4. `/index.html`可以作为静态文件兼容路径继续返回相同bundle，但CLI、文档与根导航不生成该地址。

本决策只替代ADR-0156的根路径302机制；single-Service、同origin、Service-owned assets、Browser只读权限及无独立Web lifecycle结论不变。

## 安全边界

- 根GET不返回Workspace/Session数据、不开放mutation，只创建受TTL/容量约束的read-only Browser session。
- exact loopback peer与Host检查、CSP、SameSite、HttpOnly、Origin/Fetch Metadata及`/v1` principal检查继续生效。
- Browser session只存在内存，Service stop/restart即撤销，不写Kite Home。
