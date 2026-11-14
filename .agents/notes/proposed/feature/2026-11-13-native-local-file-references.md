# Agent Note: Native 本地选文件直接引用

Status: proposed

## Problem

用户希望本机输入框选择和拖入文件直接引用原路径，让 Agent 按已有权限访问，而不是为每个普通文件自动复制。此前统一导入快照会增加磁盘占用并使用户误认正在修改原件。

## Proposal

仅 Main 自己启动的 paired Service 显式声明同机文件引用能力；能力默认关闭，不从 localhost URL 猜测同机身份。Electron 有真实路径的普通 File 不再读取字节或创建 Artifact/工作副本。无路径或未获得同机能力继续已有 prepared 导入。图片和输出再次作为输入的导入不变。

路径引用不授予权限，不构成内容快照；Agent 读取执行时版本。源文件改动、移动、删除按工具实际结果处理。连接换代清除未发送附件，不重放；已提交 command 沿原 journal 查回，不因恢复重新执行。原文件保护不再由隐式副本提供，写入仍按现有权限与用户目标执行。

## Alternatives considered

统一副本有稳定版本与原件隔离优势，但违背本机直接引用目标并产生冗余存储。只检查 URL 为 loopback 不足以证明服务与文件同机，故不采用。

## Acceptance criteria

已完成局部实现和隔离 DOM/Main/路径回归；真实 Electron 独立夹具已核生产 preload、Composer 选择与磁盘文件 drop；真实 Node 冷恢复携直接路径通过。完整产品与真实权限交互 UI 的全过程仍待验收。此记录保留 proposed，不能作为完整交付证据。

## Risks

直接引用允许读取后来变化的文件；不是历史版本恢复。无法证明同机的客户端必须保持副本导入。完整 UI 和权限回归未执行前不能宣称完整验收。
