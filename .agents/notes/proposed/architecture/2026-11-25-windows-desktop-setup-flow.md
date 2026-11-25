# Agent Note: Windows 桌面安装流程与恢复

Status: proposed

## Problem

Kite 的 Windows x64 离线安装器已经支持当前用户首装、原目录更新和卸载。新版失败结果页会区分应用暂存文件的回收结果，但还缺少首次失败的 Win32 操作和系统错误码。更新时，[安装 worker](../../../../scripts/release/windows-setup/install.ts)先通过 [Native 替换](../../../../scripts/release/windows-native-install.ts)验证并发布新版，再移除旧版。随后 [Win32 安装器](../../../../scripts/release/windows-setup/setup.cc)才写入启动器与 Windows 安装登记。如果这两步之间中断，旧登记可能指向已经移除的旧版。

VS Code 将面向当前用户的安装和全系统安装作为独立制品。安装脚本把可选任务、快捷方式、启动和登记分别定义。后台更新有独立准备状态，等待旧进程退出后再应用新版。Inno Setup 也提供本地安装日志，可以核对文件尝试和替换结果。 [VS Code Windows 安装](https://code.visualstudio.com/docs/setup/windows) · [VS Code 安装脚本](https://github.com/microsoft/vscode/blob/main/build/win32/code.iss) · [Inno Setup 日志参数](https://jrsoftware.org/inno-setup/documentation/topic_setupcmdline.htm)

## Proposal

继续用当前用户 Windows x64 离线安装作为主入口。包内运行时负责安装，用户 Profile 在首次启动时创建。沿用现有路径选择、开始菜单、可选桌面快捷方式和完成页启动选项。参考 [Inno Setup 向导页面](https://jrsoftware.org/inno-setup/documentation/topic_wizardpages.htm)和[安装执行顺序](https://jrsoftware.org/inno-setup/documentation/topic_installorder.htm)，在同一 Kite 向导内明确区分确认、写入、恢复和结果。VS Code 脚本明确处理后台更新等待及取消，旧版本能否恢复仍取决于各提交点的实现。

| 阶段 | 行为与职责 |
| --- | --- |
| 确认安装位置 | 首装在选择目录、配置快捷方式之后显示摘要。更新确认直接显示已登记目录和保留的数据。在写入前核对包内路径冲突，并结合实际暂存路径检查目标可用性及路径能力。 |
| 准备可启动版本 | Native 安装代码在同卷私有暂存目录中写入并核验候选。当前已登记的版本在准备期间保持可启动。 |
| 切换启动和卸载入口 | 核实新候选已经可用。由同一模块负责切换启动器、活动候选和用户登记。提交前发生故障时保留旧入口并回收本次暂存；提交后由重跑补齐快捷方式或继续旧版清理。 |
| 清理与结果 | 核实新入口后回收旧版。写入或校验失败时沿用已交付的暂存回收边界。回收时使用进度页现有状态区，失败后直接切换到同一布局的结果页，显示原始错误与回收结果。将首次失败阶段、Win32 操作、系统错误码、包内相对路径和制品摘要保存在本机私有诊断文件中，使清理之后仍可核对。 |
| 卸载 | 通过已核实的安装登记定位当前产品。等待相关应用退出后回收受管程序和 Windows 集成，保留独立的用户数据。 |

优先让目标路径预检和故障诊断可验收，再核对各更新阶段的恢复责任。安装器引擎和版本化制品布局由[发行制品方案](../../../../docs/plans/windows-desktop-packaging.md)确定。该方案以干净环境首装和新格式更新为验收范围。

## Alternatives considered

- 继续把 Win32 向导作为长期发布入口。这保留了现有职责，但无法对齐已确认的 Inno Setup 制品要求。新版仍需处理候选完整性、文件身份及提交后的恢复。
- 仅调整向导步骤和界面。这样无法缩短更新登记切换的中断窗口，也无法从通用错误码追溯首个失败操作。

## Acceptance criteria

- 使用空用户目录和没有第三方运行时的进程环境验证首装、首次启动、同版本重跑和卸载。
- 使用相对路径冲突、目录不可用、长路径和真实文件占用的 Windows 反例，检查失败前的写入边界、失败结果页及故障记录。
- 在新版写入、启动入口切换、登记和旧版清理处分别注入中断，重跑后核对可启动版本、Windows 登记、快捷方式及已保留数据。
- 使用两个新格式制品验证更新和卸载，核对失败或取消后可恢复的版本。

## Risks

程序文件、启动器和用户登记跨不同 Windows 接口，单次文件重命名不能覆盖全部切换。Inno Setup 在保存卸载程序和日志后完成提交，后续错误退出的回收边界与提交前不同。Kite 需要用自己的登记与启动检查定义提交完成，再测试两个方向的恢复。长路径及 ACL 行为也需要在实际 Windows 配置上验证。 [Inno Setup 安装顺序](https://jrsoftware.org/inno-setup/documentation/topic_installorder.htm) · [当前实现与实测](../../../../apps/desktop/docs/native-release.md#构建与安装)
