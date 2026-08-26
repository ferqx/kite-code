# Service lifecycle 与恢复

本页描述KLSV1-04 shell和App-private manager。当前Runtime/History/App Control application由fake/in-process port注入，不是default Store process evidence。

启动顺序固定为state prepare（instance lock与两个token）→ application start → carrier start → descriptor publish → readiness。基础设施port必填，任一步失败都不伪ready；late start会进入同一close barrier，startup/close fault保留state evidence。

普通stop先quiesce mutation gate。active operation返回`service_busy`并resume；空闲时commit drain，control caller先收到`applied + draining`，同一shell再关闭carrier/application并最后清理state。signal是owner shutdown：停止transport、调用recovery-safe`cancelAll`、drain/dispose。gate/owner timeout使用有界失败语义，late quiesce会resume，late commit完成前不并发dispose。cleanup failure不能回放旧applied acknowledgement，internal executable也以失败退出。

manager在process serial queue与cross-process lifecycle lock下执行。20 concurrent ensure只允许一个spawn；descriptor、instance lock、Protocol、client-contract、instance、PID、readiness、token与build identity必须exact。source/installed executable只来自显式绝对路径。spawn port固定detached/stdout ignore，readiness使用独立one-shot handle；release handle从不kill child。

alive/uncertain PID、malformed state、identity drift、unknown stop outcome均fail closed且不spawn/cleanup/retry。restart只在Service已安全清除descriptor/token/instance lock后执行一次ensure；dead PID才允许stale cleanup。

owner tests覆盖shell startup/stop/signal/fault、真实loopback安全矩阵、Native state、20-way ensure、orphan lock、descriptor publication window、dead/alive/uncertain、timeout、busy/unknown stop、restart与resolver。它们是本地isolated/fake evidence；没有真实default Host/Store、relocation、release smoke或三平台qualification。

KLSV1-05另以未公开process harness启动真实detached child，并通过Native connector覆盖Runtime/History/App Control、
restart identity、lost response no-replay与client close后Session继续。application仍是fake port，不改变default Store owner。

验证：`bun run --cwd apps/kite-service test`、`bun run --cwd apps/kite-service typecheck`。
