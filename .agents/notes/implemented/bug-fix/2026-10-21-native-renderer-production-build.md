# Agent Note: Native renderer 构建不继承测试运行时

Status: implemented

## Problem

合并后的真实 child-stream 窗口完成原100次主子切换和资源断言，但50ms以上长任务超过原少于10项的门禁。CPU profile发现，Bun test以 `NODE_ENV=test` 调用 `buildNativeDesktop` 时，非development分支产物包含React与JSXDEV开发栈；名义上的正式renderer并未固定生产运行时。测试诊断开关与React编译模式属于不同边界，不能用开启诊断解释开发运行时进入正式产物。

## Decision

仅在[Native builder](../../../../apps/desktop/scripts/build-native.ts)的非development renderer分支显式设置 `esbuild.jsxDev=false`，并把 `process.env.NODE_ENV` 定义为 `production`。正式资产不随调用进程的test／development环境选择React或JSX开发路径；Vite开发服务器仍使用原开发管线。显式隔离制品的 `testDiagnostics` 构建常量与原权限保持独立，不由NODE_ENV授予测试入口。

[原child-stream窗口测试](../../../../apps/desktop/test/isolated/native-child-stream-electron.test.ts)在真实构建的renderer字节中拒绝 `runWithFiberInDEV` 和开发act提示，随后继续原100次切换、完整正文、草稿、资源及性能门禁。该资产守卫不代替全部候选库存、窗口或发布验证。

## Alternatives considered

先检查Conversation布局、缓存与编辑器是否需要进一步优化；profile将本轮主要长任务归于正式构建混入的开发运行时，因此修正构建输入边界，没有为本次问题改写这些机制。

## Consequences

同一原窗口修正后观测到0项50ms以上长任务，切换P95约317ms；这是本机定向复验，不把旧失败改签为通过，也不宣称合并后全量、安装或其他平台已通过。原性能阈值、Conversation／KeepAlive／Editor机制和资源断言保持；最终相关整文件和完整默认结果分别记录。当前构建合同与验证范围由[Desktop owner](../../../../apps/desktop/README.md)、[Native发行owner](../../../../apps/desktop/docs/native-release.md)及[发布边界](../../../../docs/active/release-control.md)维护。
