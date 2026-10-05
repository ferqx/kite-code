# Agent Note: 正式制品的准确 SQLite 选择与 Worker 引擎身份

Status: implemented

## Problem

新 Store 以多个实际 Worker 和 WAL 保存原业务记录。运行时的 SQLite 名称或版本区间不能证明 WAL-reset 修复；Bun 在 macOS 使用系统库，而 Electron 内的 Node 数据库是另一引擎。源码执行成功不能证明搬迁制品仍使用同一个库，晚于首次 Database 改 loader 也不能修正既有连接。

本决定记录已交付的包内选择合同及 macOS 实际资格，不宣称 Linux/Windows 发布结果。当前发行条件由 [release control](../../../../docs/active/release-control.md)负责，代码合同见 [Agent 引擎 owner](../../../../packages/agent/src/sqlite-engine.README.md)。

## Decision

固定包内 `storage/engine/engine-selection.json` 与完整 manifest，绑定 target、driver、linkage、实际 version/sourceId；动态库另有准确长度和 SHA，Terminal manifest 再绑定 engine manifest SHA。构建以复制后的 Bun 实测引擎，macOS 只从明确或有限构建依赖位置复制，并核系统动态依赖；正式运行只使用包内资产。

公共 Store、readonly/preflight 与 maintenance 在 Profile/数据库访问前初始化同一选定引擎。Bun 的 native loader 在该 OS 进程内共享；parent 仅设置一次，Worker 核原 selection 与实际引擎，不再调用 setter。当前 Bun 1.4.2 的实际第二次同路径 setter 拒绝，因而不按文档示例重复设置；两个真实 Store Worker 的并发 WAL 事实用于复验。

完全没有选定资产的源码允许明确 `development_no_selection`，不获发布资格。只要资产目录存在，缺失、损坏、篡改、错误 target/source 或迟初始化均拒绝；失败状态不静默转 builtin。`@kite-ai/agent/sqlite-engine` 的 import/parser/verifier 保持 Node-safe，不因导入就打开数据库。

正式修复证明采用已审查的准确上游 sourceId 或确证 backport，不建立永久 minimum 或“最新”规则。当前集合是官方 [3.51.3](https://www.sqlite.org/releaselog/3_51_3.html)和[3.53.4](https://www.sqlite.org/releaselog/3_53_4.html)。Native 单独实测并绑定 Electron `node:sqlite`；Bun 引擎资格不能替它放行。

## Alternatives considered

- 沿用 macOS 系统 builtin：当前源码 Apple SQLite 3.51.0 无对应已审查修复身份，真实读取候选 WAL 曾 `SQLITE_CANTOPEN`；保留该失败，不删除 WAL 或改 journal mode。
- 只按 SQLite 版本区间放行：版本文字不能证明补丁或 backport，也会误拒正确修复来源；改为准确 sourceId 集合与实际多连接、备份/恢复证据。
- 每个 Worker 重复设置同一路径：Bun 1.4.2 的真实调用会因已初始化拒绝；共享 native loader 后复核同一实际引擎即可，不复制 setter。
- 运行时搜索 Homebrew 或环境变量库：搬迁与用户环境会改变执行库，并扩大 DLL/loader authority；搜索仅限明确构建阶段，运行固定包内路径。
- 将 Electron 的 SQLite 标注为 Bun 已选版本：它是独立 Node embedded engine；分别绑定清单与启动前实测。

## Consequences

已交付测试核复制/搬迁的实际 macOS 3.51.3、两个 Worker、24 次并发 WAL 写、准确 backup/new Store restore 和 cold readonly/preflight；损坏 sidecar 在新 Profile 前拒绝。当前 Electron 44.3.0 / Node 24.20.0 实测 3.53.4，并在开 UI DB 前核 manifest。

额外库与 metadata 增加制品闭包和启动核验成本。Linux/Windows builtin 的代码合同存在，未知 sourceId 拒绝，尚无本轮原生发布资格；该 Note 的 implemented 不表示三平台、publisher 认证、断电或全部 V1.3 已完成。资产校验与不合作编辑器不是原子 filesystem 操作，使用权仍由[候选生命周期](2026-10-02-terminal-bundle-lifetime.md)负责。
