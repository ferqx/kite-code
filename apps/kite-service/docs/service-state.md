# Service state 与目录锁

本页描述Service与 `@kite-ai/kite-local-runtime/service`/`manager` 的state边界。package拥有no-follow/atomic filesystem
primitive与manager lifecycle implementation；Service shell拥有自己正常发布/清理instance state的时序，release
composition提供显式validated `KiteHomeIdentity`。

Service不读取请求cwd、Workspace `.env`或ambient `KITE_CODE_HOME`来推导identity。V1固定布局为
`<kite-home>/runtime-service/v1/{instance.json,access.token,control.token,instance.lock/,lifecycle.lock/}`；default Store
另固定为同一validated home下的`checkpoints.sqlite`，不能由stdio fixture或client option alias替换。

POSIX目录必须owner UID且`0700`，文件必须owner UID、single-link regular file且`0600`。读取采用
`lstat → O_NOFOLLOW open → fstat/inode recheck → bounded read`；发布采用同目录exclusive temp、fsync、atomic rename、
directory fsync与strict readback。symlink、hardlink、type、owner、permission或parent identity drift均fail closed。
Windows缺少current-user ACL/reparse verifier时明确`unsupported`。

child持有`instance.lock`，manager以`lifecycle.lock`串行ensure/status/stop/restart。lock、PID与descriptor都不是单独健康
证明；manager还必须验证`/readyz`和authenticated process-owned instance handshake。alive/uncertain owner一律保留state且
spawn=0；PID明确dead才可exact quarantine/cleanup，绝不kill。descriptor尚未发布但instance lock存在是starting/crash
window，不能直接spawn。

applied stop进入draining后仍由Service保留state；carrier/application全部关闭成功后才clear。remove/quarantine携带刚读取
的exact descriptor/token/lock identity，并发replacement改变inode/nonce时必须拒绝。

验证：`bun test packages/kite-local-runtime/test/service-state.test.ts packages/kite-local-runtime/test/manager apps/kite-service/test/isolated/native-infrastructure.test.ts`。
