# 新对话、项目与分支

桌面入口按 [13 · New Conversation](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4096-1964) 提供新对话准备页面。与 Web 共用 [SessionPage](../../../packages/kite-client-ui/src/SessionPage.tsx)；Web 不提供新对话、本地项目或分支写操作。

## 页面与草稿

侧栏“新对话”是品牌下方的全局入口，与空间区域同级。首次打开或明确进入该入口时，[App](../src/App.tsx)显示准备页，不立即创建 Runtime Session；原会话的订阅与任务不会因为进入准备页而被取消。欢迎区、四个建议及输入框上沿的项目／本地／分支栏由共享 [NewConversation](../../../packages/kite-client-ui/src/NewConversation.tsx) 维护。

空间列表项的 `+` 在目标项目激活期间仍阻止重复导航操作，但顶部“新对话”入口保持稳定的导航外观，不因短暂的禁用周期闪烁。

建议只填入可编辑输入；已有内容时追加一行并聚焦，不发送。准备草稿独立于已有会话草稿，跨项目和分支选择保留；切回历史会话恢复其原草稿，重复进入“新对话”不清空。仅保留在当前进程，不增加浏览器持久草稿库。

首次发送前，[客户端适配](../src/client.ts)重新读取 Git 环境、工作区信任和模型快照；路径检查通过后，互不依赖的分支、信任和模型读取并行完成。实际项目、分支、HEAD 或模型选择变化时更新显示并中止本次发送。工作区有改动不会阻止在原分支发起任务。没有可用模型、没有信任或连接不可用时不创建会话。

检查通过后沿现有 `create_session → selectSession → start_turn` 执行。`create_session` 成功后立即选择新会话并退出准备页，不等待空历史加载和目录刷新后才切换画面；目录刷新在首次提交结束后异步进行。首次提交期间，侧栏已有会话保持正常视觉并可切换，提交仍显式绑定刚创建的 sessionId，不会因用户切换阅读目标而误发到其他会话。发送失败保留新会话草稿并使用同一会话重试。创建回执未知时保存该次尝试的 sessionId 并取消就绪资格，内部恢复后查询它，不自动再次创建。服务仍负责 Session、Run、命令幂等和授权；页面只管理准备状态和提交反馈。

## 原生项目目录

[项目模块](../electron/projects.ts)在 Electron `userData/projects.json` 保存用户经目录选择器明确选择的规范化路径和最近打开时间。路径去重、最近使用在前，写入使用同目录临时文件替换；只读加载不创建目录或文件。列表只表示项目选择记录，不表示工作区已信任。损坏列表明确报错，不静默覆盖；失效目录保留在列表，但选择时拒绝并提示重新添加。主进程继续使用迁移前的 `dev.kite-code.desktop` userData 目录，迁移不另建项目偏好 authority。

具名 bridge 的 `pickWorkspace` 只选择并登记目录，不改变当前服务。`activateWorkspace` 接受已登记且规范路径未变化的目录，要求旧服务已经关闭；`checkWorkspace` 验证目录而不要求 Git。`listProjects` 只返回选择记录。启动先通过只读 `runtimeStatus` 接入已有服务或启动应用级历史服务，项目、模型与分支检查不阻塞历史，具体见[历史与恢复](history-and-recovery.md)。

界面先选择并验证目标，有活动任务时再确认是否停止旧项目连接；取消目录选择或切换确认时，旧连接和草稿不变。确认后等待旧连接清理，再激活新项目并读取其信任、模型、会话和分支。用户主动添加／选择目录即授权该工作区：`activateProject` 对可决定且不涉及关联外部目录的未授权项目，沿现有 `decideWorkspaceTrust` 提交实际 identity、revision 和 scope digest。已连接的当前项目再次被明确选择时也可完成授权，不必断开。启动、项目列表恢复和普通 `connect` 不产生授权决定；关联外部目录仍显示路径单独确认。失败或冲突不伪造 trusted、不自动重试，输入保留并显示重试入口。Git 读取失败不能把一个已成功连接的项目伪装成已断开，错误单独显示并允许刷新。

## 页面刷新与连接恢复

`main.tsx` 持有唯一 `DesktopClient`，App 热更新保留连接。完整刷新后查询宿主，自动重新接入原 Service protocol peer；没有服务时可启动不指定执行工作区的历史服务，不创建会话或发起任务。

[Electron renderer 连接](../electron/runtime/renderer-connection.ts)让 Service protocol peer 与主进程宿主同寿命：保存该 peer 的真实 initialize 结果，刷新后的 initialize 使用同一结果，不再次初始化 Service。每次页面接入递增连接代次，RPC id 带该代次发送，迟到响应不能匹配新页面的请求。主进程在同 document 导航开始、renderer 崩溃或销毁时 detach；旧页面挂起的 receive 被唤醒取消，已知旧订阅及迟到的旧 subscribe 结果会被取消。新页面沿原 Runtime Client 重新查询快照、订阅和加载历史。这里只管理传输身份与订阅，不保存第二份 Run 或授权状态；Service 仍逐次核对访问与命令条件。

主进程 stdout 队列限制 16 个、每帧最多 1 MiB；重接额外只保留一份初始化结果、至多一条待交付响应和受 Service 订阅额度约束的订阅身份。旧页面的关闭请求仍受宿主代次校验，不能关闭新页面正在使用的服务。切项目、退出继续走 EOF 清理流程；页面刷新不会触发这些操作。

`sessionStorage` 的 `kite.desktop.navigation` 只保存当前窗口的项目路径和所选 sessionId，用于刷新后回到同一会话或新对话页；它不授予信任，也不保存消息、执行状态或待发送命令。恢复只在宿主真实当前项目匹配时加载该会话，仍核对 Service 会话归属。已保存项目不会从列表删除；未发送草稿仍只在页面内，完整刷新不保证保留。原生应用或服务真正退出不等同于页面刷新，不承诺把已经停止的执行自动重放。

## 原生 Git 边界

`queryWorkspaceBranch` 返回已登记项目的真实仓库根目录、当前分支、HEAD、本地分支和工作区改动状态。非 Git 目录不展示分支控件，可正常发送且不要求安装 Git；detached HEAD 显示短提交标识，尚无提交的仓库保留真实初始分支名。没有远端抓取、新建分支或 worktree 管理。

`switchWorkspaceBranch` 消费查询时的环境身份和目标分支；[Electron 宿主](../electron/host.ts)在当前项目锁内核对路径、分支与 HEAD，要求没有自有服务进程，再执行 [Git 模块](../electron/git.ts)的受限操作。目录必须是仓库根目录，不能通过选择子目录修改上级仓库。使用参数数组、禁用 hooks 与 fsmonitor、限制输出和执行时间，不拼接 Shell，也不自动 stash、提交、清理、强制切换或执行恢复命令。

客户端切换前实时查询当前项目任务，运行、排队或等待中的任务均阻止切换；目录达到现有 1,000 条上限时无法完整核实，保守拒绝。暂存、未暂存或未跟踪的改动阻止切换；选择当前分支不产生操作。通过检查后关闭桌面服务并等待清理，宿主再次核对 Git 状态后切换，再读取实际分支并重新连接。

Git 失败、超时或回执未知不会触发重试和自动切回。刷新失败时撤销旧分支快照，不把旧选择当成已确认事实。外部终端和其他程序的 Git 操作不由桌面统一协调，发送前检查只能拒绝已经观测到的变化，不提供跨程序目录锁。

## 验证

[UI 测试](../test/ui.test.tsx)覆盖全局入口、草稿隔离、建议追加、菜单键盘与焦点、即时项目／分支选择、首次发送和失败后不重复创建。[导航测试](../test/navigation.test.ts)用真实 App Server 与受控 Native 回执验证环境变化、活动任务阻止切换、切换回执丢失后读取实际状态，以及创建回执未知后的同 sessionId 恢复。[丢失回执测试](../test/resilience.test.ts)覆盖新对话检查后实际写入且不重放任务。

[Electron 本机操作测试](../test/host-native-operations.test.ts)覆盖项目列表持久化／去重／失效、已有分支切换、工作区改动、子目录和编辑器路径边界；[renderer 连接测试](../test/host-renderer-connection.test.ts)覆盖 initialize 复用、旧代次隔离与旧订阅清理。配套 Service 与窗口 smoke 分开记录。这些测试不替代系统目录选择器、真实窗口鼠标操作或外部 Provider 资格；HTML 预览使用生产组件与隔离测试数据，Electron 原生 smoke 成功前仍保持待验状态。
