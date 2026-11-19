# Agent Note: 完整文件范围原位使用已安装 Git Bash

Status: implemented

## Problem

两份私有运行时依赖自选的复制清单。完整文件范围使用原版 MSYS，原安装已提供完整的命令、资源和布局。

## Decision

从宿主 `PATH` 已解析的 Git 识别同一安装，完整文件范围直接启动其中的 `usr/bin/bash.exe` 并使用对应的 Git 程序目录。清单绑定已核实的源路径和字节摘要。每次派发重新核实所选路径，Runner 仍核解释器摘要并拥有命令及子进程。旧调用明确绑定私有 Full 副本时，沿原绑定核实。

工作区写入与只读使用带 [MSYS 兼容库](../../../../native/windows-msys-compat/README.md)的私有副本。实际 V7 Runner 对照中，原安装的入口在受限令牌下创建内部信号管道时报 Win32 5，脚本未开始执行。原安装在完整文件范围下成功运行命令、读取 PNG 的 magic 数据并清理后台子进程，覆盖离线和允许联网两种范围。

## Alternatives considered

- 两种文件范围均原位启动。现有受限令牌下的进程会在 MSYS 初始化时退出。
- 保留完整文件范围的副本。复制清单需要跟随 Git 发布的资源布局，遗漏共享数据会影响自带命令。

## Consequences

新准备只创建受限副本。完整文件范围的登记资产变化或路径替换会让原绑定在派发前失败，重新发现生成新的绑定。原安装与受限副本的 MSYS 共享对象空间分开。

这部分替代[随附命令决定](../simplification/2026-11-12-use-git-bash-utilities.md)和[退出状态决定](2026-11-16-supervised-shell-exit-status.md)中的 Full 副本。受限运行时、相对布局及执行后的收尾理由仍适用。验证范围归 [Windows Shell owner](../../../../docs/active/windows-shell-sandbox.md)。
