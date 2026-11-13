# Agent Note: 模型凭据统一加密保存

Status: implemented

## Problem

同一用户的桌面、CLI 和 TUI 共享模型设置。macOS 钥匙串为每个旧 API key 记录可读取程序的身份，从旧 Bun 或安装版 Node 换到开发版 Node 时可能在发送消息过程中弹出授权框。用户选择统一加密保存模型凭据，由操作系统保护解密密钥，并保留定时任务和 Service 重启后的读取能力。

## Decision

Service 在用户配置旁按相同格式保存 AES-256-GCM 凭据记录。随机解密密钥单独保存在当前用户的 macOS 登录钥匙串、Windows Credential Manager 或 Linux 持久 Secret Service。三个客户端都沿同一 Service 接口。常规模型请求只走无交互读取。macOS 遇到旧 ACL 时，连接设置的显式保存可确认旧条目或解密密钥。正式签名 DMG 为配套 Node 指定稳定的 Kite 签名标识。

可访问的旧系统条目沿原 `credentialRef` 迁移，保留原条目供旧版回滚。替换凭据后，用户配置只保存新引用。原有手工内联 key 继续由 Service 从配置解析。配置路径和模型身份遵循[单用户配置决定](2026-10-15-single-user-configuration.md)。MCP、Trace 与 Codex 各自的凭据来源由原 owner 管理。

## Alternatives considered

- 在每个平台继续逐条存入系统凭据库。这个方案需要不同的原生存储行为，macOS 还会随读取程序身份变化逐条要求确认。
- 在应用目录保存明文或随密文附带可直接读取的密钥。现有同用户程序可能访问该目录，这两种方式都会丢失系统对解密密钥的保护。
- 用用户输入的口令派生密钥。Service 冷启动需要用户操作，无法覆盖用户选择的后台任务场景。

## Consequences

系统凭据服务必须可用。凭据被锁定时正常发送得到明确错误，解密密钥遗失或记录被篡改时停止绑定。已初始化的库不自动生成替代密钥。当前持久锁和认证密文核对保护并发 Service 操作，无法防止同用户进程把所有本地状态回退到旧副本。正式签名标识也不能将同一解释器内的任意脚本当作独立安全主体。

旧版可读原有系统条目。它需要重新录入新版创建或替换的凭据。实现和验证归 [Service owner](../../../../apps/service/README.md) 与 [模型手册](../../../../docs/handbook/features/models-and-configuration.md#配置范围)。
