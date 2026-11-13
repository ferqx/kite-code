# Agent Note: Native 默认桌面构建与独立终端登记

Status: implemented

## Problem

macOS arm64 和 Windows x64 的桌面安装器已有可独立运行的制品，通用 Native 构建仍要求先构建完整 Terminal。切换默认布局时，组合安装登记过的独立终端命令可能继续指向已失去 CLI/TUI 入口的 Native 候选。

## Decision

支持桌面专用运行时的两个目标默认构建该布局。`--terminal` 明确要求组合制品，Linux 沿用完整 Terminal。原[组合制品与独立登记决定](2026-10-04-native-complete-closure-and-cli-registration.md)继续适用于组合候选。两层校验、使用权、固定 Bun 与配套 Service 的绑定适用于两种布局。

macOS managed 安装核验新候选和原独立 Terminal 后，在两前缀的原锁内按 nonce 撤销自己仍持有的登记，再发布桌面 `active` 并移除 Native 的终端前门。撤销先于发布使发布失败时独立命令仍有已验证的 Terminal。回退到组合候选恢复 Native 前门，重新转发须显式登记。Windows 使用现有安装器替换路径和旧制品的排他移除所有权，沿原 nonce 撤销旧登记。

## Alternatives considered

- 只改构建默认值会留下指向旧 Native 入口的独立终端登记。
- 让桌面候选接受 `--cli-prefix` 会承诺候选没有交付的 CLI/TUI 路径。拒绝该组合并保留显式组合构建，使登记始终选中完整制品。
- 将 Linux 一起切换会超出现有桌面运行时构建和清单的目标范围。

## Consequences

桌面制品和独立 Terminal 可分别构建。已安装的独立终端继续使用原前门，已有任务和 Profile 沿原数据与使用权边界处理。组合包资格和桌面切换验证分别执行，实际覆盖归 [Native 发行说明](../../../../apps/desktop/docs/native-release.md#标准命令登记与卸载恢复)。
