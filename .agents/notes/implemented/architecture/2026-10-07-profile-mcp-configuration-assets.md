# Agent Note: Profile MCP 原配置恢复沿当前来源准入

Status: implemented

## Problem

既有离线备份只收集原通用配置与 UI 申请，遗漏默认 MCP 实际读取的 Profile 声明、项目决定和 credential binding 文件。恢复的 UI 历史因此无法与真实原配置对应；将旧决定重绑到恢复后的新 Store 则会扩大执行权。原文件可能损坏或含未知字段，维护操作不能改写用户声明。

## Decision

沿[原离线备份决定](../../implemented/architecture/2026-10-02-offline-profile-backup.md)的私有原字节、独立采集与稳定排他锁，新增三个独立 raw 资产。只在任一实际存在时创建 closed v16；完整记录三者的 presence、capturedAt 与 proof，继承既有 UI 资产合同且允许无 Desktop 或 DB1–7。旧版本白名单不扩大。恢复按原字节复制且不读取 Vault、不复制项目文件、不修补语法、不 retag 决定或重放申请。

默认 MCP source consumer 继续核当前 Store、physical Profile／Workspace identity 与完整 source／entry／transport 摘要。无认证用户来源沿现有信任规则读取；项目批准和 credential binding 的旧 scope 在新 Store 中不匹配，当前普通 Action 与实际 Question 才可建立新的决定。维护只提供资产恢复，不拥有来源许可。

## Alternatives considered

- 只备份 `mcp.json`：遗漏实际决定和 opaque credential ref 记录，不能完整恢复原事实，弃用。
- 扩大 v15 或所有旧版本的白名单：改变既有闭合格式承诺，且 v15 特定要求 Desktop DB7，不适合无 Desktop 的实际 MCP Profile，弃用。
- 恢复后把所有来源都设为不可信：改变既有用户来源产品规则，既有完整 scope 核验已能拒旧项目／credential 权利，弃用。
- 解析、重写或恢复时重绑原记录：丢原字节或擅自创建新执行许可，弃用。

## Consequences

三 raw 文件在独立时点采集，不承诺与 Core／UI 的同一原子瞬间；原文可能包含 inline secrets，私有备份不等于脱敏。Vault 不在备份内，重新绑定不保证目标机器已具凭据。有限本机恢复证据不替代真实浏览器／OS Vault 或三平台发行资格。

公开 API 原测试实际得到 v5且遗漏三文件，新增资产后四项129断言核原全文／部分presence、旧格式／物理实体拒绝及private/proof/取消守卫。实际Node DB7保原v15恢复再核v16和第二次新Store，16MiB原state及旧请求保持；CLI DB5原离线argv保三raw文件。

[正式安装恢复](../../../../tests/isolated/unified-agent/profile-mcp-restore.test.ts)实际1项128断言通过：公开builder/install后删除原candidate，installed CLI backup/inspect/restore生成B，默认Service A/B/B-cold保原决定、C/E和Core Question完整原行；无认证用户来源仍admitted，项目pending及credential binding required，7次cold HTTP均GET、cursor和原文件不变、Model0。当前两份Question追加B记录且原A记录保持，显式owned stdio才initialize/tools-list；准确server/guardian/Service退出，cold不重启，卸载保Profile。手工credential transport未派发，OS Vault／OAuth实际资格继续独立。当前Interaction列表按当前Store过滤，旧answered Question保留不使其成为当前待决卡。准确有限、阶段原完整默认与门禁结果见[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07profile-mcp-配置备份恢复)。
