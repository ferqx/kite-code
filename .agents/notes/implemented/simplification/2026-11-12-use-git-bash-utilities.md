# Agent Note: Windows Git Bash 使用随附命令

Status: implemented

## Problem

Kite 已从本机 Git for Windows 准备两套 Git Bash 运行时。常用命令仍由另行打包的 Microsoft Coreutils 覆盖，每次派发还要复制一份二进制并创建命令链接。

## Decision

使用所选 Git Bash 副本内的 `usr/bin` 命令。只读目录查询也固定到同一副本的绝对 `ls.exe` 路径。原运行时清单涵盖这些文件，派发前完整校验。Service 和原生 Runner 仍以 V7 在同一制品构建，Windows 包移除独立 Coreutils 及临时命令链接。实现归 [Jobs owner](../../../../packages/agent/src/jobs/README.md#默认-windows-git-bash)。

## Alternatives considered

- 继续打包独立 Coreutils。它能固定命令版本，本机验证表明 Git Bash 随附命令已满足常用文件和文本操作。
- 直接使用安装目录或环境 PATH 上的同名程序。两种文件授权范围已有各自校验的 MSYS 副本，命令和依赖沿同一副本运行可以保持其身份和隔离边界。

## Consequences

可用命令和参数随本机 Git for Windows 版本。受限与完整文件范围各自使用原副本，内置 `rg` 继续随包提供。后续检查沿 [Windows Shell owner](../../../../docs/active/windows-shell-sandbox.md) 和[桌面 PowerShell 回退](../architecture/2026-11-12-windows-desktop-powershell-fallback.md)的边界执行。
