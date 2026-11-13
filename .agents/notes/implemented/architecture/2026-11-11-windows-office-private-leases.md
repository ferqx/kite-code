# Agent Note: Windows Office 历史副本只读访问

Status: implemented

## Problem

用户撤回所有本地插入功能后，继续保留不可达写接口没有必要；直接删除历史副本读取又会破坏已有草稿的准确版本引用。Windows也不能把POSIX mode视作私有权限证明。

## Decision

新界面只预览原件和发起选区修改请求，移除新增、插入、写备注、open/apply RPC和后台batch/publish。旧immutable引用保留严格只读reader，不初始化或重新生成历史。Windows能力沿原附着Profile派生固定只读命名空间，保独立SH、祖先及文件HANDLE、ACL和单链接核验，任何创建或写入方法不再导出。

## Alternatives considered

- 只隐藏按钮、保留写RPC：保留不必要能力并可能被旧renderer调用，拒绝。
- 删除所有Office处理：会误删用户仍需要的Agent创建/修改与预览能力，拒绝。
- 删除历史reader或用原件替代旧副本：会使草稿的revision/SHA失真，因此保留只读兼容。
- 沿用chmod或放宽Windows权限：不能证明私有ACL，拒绝。

## Consequences

Agent OfficeCLI、输出Artifact和原Profile维护权限不变。旧草稿只可消费已存在、摘要匹配的历史版本；损坏明确失败。用户若以后恢复本地编辑，须重新确认范围并验证，不能自动重新启用此次保留的未提交实验。平台证据与限制归[Desktop owner](../../../../apps/desktop/README.md#办公输出文件)。
