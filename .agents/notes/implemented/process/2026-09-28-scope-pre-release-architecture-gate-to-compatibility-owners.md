# Agent Note: 架构门禁按受控兼容 owner 判定旧版本身份

Status: implemented

## Problem

`check:pre-release-architecture` 原本对全部生产源码路径、实体和 active 文档统一拒绝 `StoreN`、`Legacy` 等标记。其目标是防止未发布阶段保留第二套业务实现，但现行启动准备必须识别已验证的旧 Store 格式、转换私有候选，还必须观测不遵守当前维护锁的旧写入者。原规则因此把安全迁移所需的准确来源身份与过时的业务兼容分叉混为一谈，并阻断门禁。

## Decision

1. 版本或旧写入者身份只在受控 Store 启动维护、格式转换和迁移准入 owner 内成立。SQLite 候选转换必须先核对准确来源 schema 与 epoch，在独占维护下保存备份、转换私有候选并校验连续性；旧进程观测只保护同一数据 home 的迁移，不授予旧进程 Runtime authority。普通 History、Host、客户端和当前 Store writer 不得因此加入旧格式 fallback 或双写。
2. 架构门禁以源码中明确的 owner 边界约束这些标记，继续拒绝其他生产源码的版本化命名、旧 alias 和第二 composition root。受控 owner 是职责约束，不是允许任意新文件、任意版本或任意兼容分支通过的泛化路径豁免；新增来源仍需现行产品合同、精确格式校验及定向测试。
3. active 文档可准确写明受支持的来源格式与目标格式；禁止版本标记的生产命名规则不应用于抹除产品和恢复合同中的版本信息。

## Alternatives considered

- 删除旧格式转换和旧写入者观测以维持全局正则：会破坏已确认的会话连续性；旧进程不遵守新维护锁，单靠锁无法保护来源库。
- 对所有生产路径、实体和文档放开版本命名：会让旧业务 façade、双 codec 和 fallback 再次进入正式入口，削弱门禁。
- 建立永久例外文件或可扩展 allowlist：会把边界从实际源码 owner 移到第二份人工名单，产生无证据的准入漂移。

## Consequences

门禁可以同时验证唯一当前业务入口与受控离线转换。旧格式的存在不代表运行时可按旧格式恢复或写入；未知来源仍 fail closed。门禁规则改变时须以确切的正反例测试证明：已确认的 Store 维护与迁移准入可通过，普通生产源码新增旧版本 façade 仍失败。当前来源集合和发布边界由[本机 App Server 契约](../../../../docs/active/app-server-local-runtime.md#store-与版本)维护，实际 Store 准入与转换由[SQLite owner](../../../../packages/runtime-storage-sqlite/README.md#格式与实际入口)维护。

## Historical relationships

本决定部分取代[未发布命名与模块边界](../simplification/2026-08-23-pre-release-clean-cutover-module-boundaries.md)对版本化源码及兼容恢复的全局禁令；其禁止旧业务 alias、第二路径和长期 façade 的理由继续有效。它保留[源码级架构门禁](2026-08-24-source-based-architecture-gates.md)拒绝生成快照及永久例外清单的取舍。旧写入者准入的安全理由及范围见[按数据 home 约束迁移准入](../simplification/2026-09-27-scope-source-store-migration-admission.md)。
