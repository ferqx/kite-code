# Agent Note: Windows 桌面安装目录选择

Status: implemented

## Problem

Windows 离线安装器的确认框只显示当前用户的默认目录。自定义位置也需要支持磁盘根目录下的新文件夹。现有 managed Native 安装把协调文件放在安装根的上一级，并核对该目录的所有权和权限。

## Decision

[安装窗口](../../../../scripts/release/windows-setup/location-dialog.cc)允许编辑路径或使用 Windows 文件夹选择器。新安装在所选位置建立或验证一个当前用户的目录，并在其中安装 managed Native 客户端。选中前一版的直接安装目录时，[目录准入](../../../../scripts/release/windows-setup/install-location.ts)核对原 marker 并使用该根。离线安装器与标准发布命令共用[Windows 归档安装](../../../../scripts/release/windows-native-install.ts)。

## Alternatives considered

- 把任何所选路径直接交给现有安装器，会在磁盘根目录等上级目录没有当前用户所有权的位置失败。
- 放宽协调目录上级的权限检查，会让其他写入者影响选择锁和候选发布。所选目录内的管理根可使用原校验。
- 所有安装都切换到新的子目录，会在此前已装位置创建第二份客户端。原安装 marker 用于识别并选择既存管理根。

## Consequences

新目录位于用户选择的本地磁盘。已有文件、路径别名和目录权限继续按原对象规则核对。发行包复用原 Windows x64 归档和内含 Bun。用户流程与构建方式归 [Native owner](../../../../apps/desktop/docs/native-release.md#构建与安装)。
