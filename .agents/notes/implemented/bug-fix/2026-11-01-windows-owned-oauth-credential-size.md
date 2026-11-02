# Agent Note: Windows owned OAuth 材料的原生分段

Status: implemented

## Problem

Windows MCP 官方 SDK OAuth 示例已完成浏览器回跳和 PKCE 换码，但默认原生凭据写入返回 publication unknown。实际 `@napi-rs/keyring` 将 password 按 UTF-16 保存，1280字符成功、1281字符失败；[Windows 单项限制](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)为2560字节。完整 OAuth 材料还包含动态 client、discovery 和 token 元数据，正常示例就超过该容量，而[配置 owner](../../../../packages/agent/src/config/README.md#同-vault-的-owned-oauth-材料)承诺完整 UTF-8 材料最多64KiB。

## Decision

只在 Windows OS backend 的 owned OAuth 域内分段，继续使用同一个 `@napi-rs/keyring` 和准确 service/account。固定88个派生槽容纳至多64KiB UTF-8材料的Base64，段内容含独立随机写入标记；base先写writing，再写段和清未用槽，最后发布ready。读取核状态、段标记、长度、SHA-256及base重读，拒绝不完整或混合材料。Remove核全部固定槽不存在后才删除base，删除中断仍留base供明确重试。旧单项owned材料可读，下次写入转换。macOS/Linux和手工引用路径保持。

## Alternatives considered

- 只降低 OAuth 材料上限或只保存 token：会破坏现有64KiB承诺，或丢失DCR/discovery及重启恢复需要的字段。
- 压缩单项材料：官方小样例可能容纳，但无法保证有界64KiB的不可压缩材料；不能据此宣称问题完整修复。
- 随机命名分段账户：部分写入后base发布失败可能留下无法从base定位的账户，需要额外目录或枚举。固定槽让准确 owned 删除始终有有限、完整的目标集合。
- 文件秘密或第二套加密store：不符合唯一OS Vault边界，不采用。

## Consequences

每次更新和删除都有有限额外原生调用；Windows真实65536字节、Unicode及缩小更新与fresh读／删除检查通过。多项原生写入不构成事务，失败保持原 publication unknown；不自动回滚，也不声称跨进程写／删原子化。完整性核对使混合／并发替换不能成为可用材料。所有槽仍属于同一已授权 owned 域，普通引用接口不能访问槽，无账户枚举、文件回退或公开协议版本变化。

实现与必要故障断言归[Windows分段](../../../../packages/agent/src/config/windows-owned-credential.ts)及[回归](../../../../packages/agent/test/isolated/config/windows-owned-credential.test.ts)；客户端流程及其资格限制归[Desktop owner](../../../../apps/desktop/README.md#native-mcp-完整设置)，不从这篇取舍推导系统浏览器或正式安装资格。
