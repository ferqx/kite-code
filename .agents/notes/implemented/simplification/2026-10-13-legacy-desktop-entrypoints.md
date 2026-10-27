# Agent Note: 旧 Desktop 普通开发与构建入口退役

Status: implemented

## Problem

现行开发、正式构建和CI已选择新八workspace，但旧Desktop仍提供普通 `dev`、服务准备和打包命令，能够从同checkout构建旧Service并沿旧Profile写入。保留历史源码不应同时保留一组容易误认为当前入口的生产者。RSS／完整观测阻碍阶段退出，但不是收束这些旧消费者的技术前置。

## Decision

按[当前开发合同](../../../../docs/development/local-development.md)，六个旧package命令和四个直接脚本使用[统一退役诊断](../../../../scripts/development/retired-entrypoints.ts)的desktop分支，在读取archive、Profile、构建或服务启动前返回退出码2。诊断分别给当前完整Native构建、启动、隔离验证与release help，不静默选择新Profile或混用旧／新writer。该leaf随后与[其他普通应用入口](../architecture/2026-10-13-historical-application-bootstrap.md)统一；本记录的Desktop范围、理由和原断言继续适用。

旧源码、已保存制品和显式历史验收保留准确出处。此次只删除上述消费者内部的Vite／Electron启动、旧identity注入、staging／签名／打包和Service准备链；整个旧authority树及其他历史producer的最终退役仍按V1.3原门禁完成。

## Alternatives considered

- 保持旧普通命令直到RSS／观测和P6全部完成：拒绝。当前正式入口已切换，这些消费者自身可以独立收束；等待会继续让同checkout暴露旧writer。
- 静默将旧命令转发为新候选启动：拒绝。旧Vite热更新不等价于制品启动，默认Profile、准备和参数语义也不能自动替换。
- 删除全部旧runtime／源码／历史验收：拒绝。历史制品与来源仍有用途，其余旧consumer和完整阶段资格尚未闭合。
- 明确拒绝旧普通入口并指向现行完整命令：采用。边界可观察、零迁移／业务副作用，保留历史而避免当前入口歧义。

## Consequences

从当前checkout按旧开发步骤运行会明确失败，旧Vite热更新不宣称已迁入；当前Native用户功能和正式构建／安装／版本／维护链沿新owner。新[完整调用者测试](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/tests/isolated/unified-agent/retired-desktop-entrypoints.test.ts)核十条实际调用、诊断／退出码和旧数据原字节／目录保全，使用标准临时路径及三端HOME环境，无平台skip。macOS已实际通过；原正式release smoke与消费者／CI守卫组合通过，未运行范围和准确证据见[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13旧-desktop-普通开发准备与打包调用者退役)。

这些结果不解除原Shell失败、RSS／完整资源观测、Win/Linux原系统资格或§35阶段退出门禁。
