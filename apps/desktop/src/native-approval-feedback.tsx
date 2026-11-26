import { useLayoutEffect, useRef, useState } from 'react';
import type { NativeApprovalNotice } from './native-approval-presentation';
import { NativeToast } from './native-message';

const identity = (notice: NativeApprovalNotice) =>
  JSON.stringify([notice.key, notice.phase, notice.commandId, notice.retryable]);
const errorText = (notice: NativeApprovalNotice) =>
  notice.retryable
    ? '审批回答未提交，请核对当前请求后重试。'
    : notice.phase === 'unknown'
      ? '未能确认审批答复结果，不会重复提交。'
      : '审批提交失败，未确认获得批准。';

type Props = {
  scope?: string;
  notices: readonly NativeApprovalNotice[];
  onLookup: (notice: NativeApprovalNotice) => Promise<void>;
  paused?: boolean;
  container?: HTMLElement;
};

/** Error-only, one occurrence at a time. Dismissal never changes an answer or its recovery. */
export function NativeApprovalFeedback(props: Props) {
  const dismissedFailures = useRef(new Set<string>());
  return props.scope ? (
    <ApprovalToastScope
      key={props.scope}
      {...props}
      dismissedFailures={dismissedFailures.current}
    />
  ) : null;
}

function ApprovalToastScope({
  scope,
  notices,
  onLookup,
  paused,
  container,
  dismissedFailures,
}: Props & { dismissedFailures: Set<string> }) {
  const [dismissed, setDismissed] = useState(new Set<string>());
  const [lookup, setLookup] = useState<{ key: string; failed: boolean }>();
  const flight = useRef<string | undefined>(undefined);
  const current = useRef<{ key?: string; visible?: boolean; lookup: Props['onLookup'] }>({
    lookup: onLookup,
  });
  const sequence = useRef(0);
  const [occurrence, setOccurrence] = useState<{ key: string; id: number }>();
  const prefix = `${scope}:`;
  const pending = notices.filter((row) => {
    const key = identity(row);
    return !dismissed.has(key) && !dismissedFailures.has(prefix + key);
  });
  const notice = pending[0];
  const key = notice && identity(notice);
  useLayoutEffect(() => {
    current.current = { key, visible: !paused, lookup: onLookup };
    return () => {
      current.current = { lookup: onLookup };
    };
  }, [key, paused, onLookup]);
  useLayoutEffect(() => {
    if (key && !paused && occurrence?.key !== key) setOccurrence({ key, id: ++sequence.current });
  }, [key, paused, occurrence?.key]);
  useLayoutEffect(() => {
    const present = new Set(notices.map(identity));
    // A new attempt or a changed result may notify again. Ordinary refreshes cannot.
    setDismissed((previous) => {
      const retained = new Set([...previous].filter((item) => present.has(item)));
      return retained.size === previous.size ? previous : retained;
    });
    for (const item of dismissedFailures)
      if (item.startsWith(prefix) && !present.has(item.slice(prefix.length)))
        dismissedFailures.delete(item);
  }, [notices, prefix, dismissedFailures]);
  if (!notice || paused || !occurrence || occurrence.key !== key) return null;
  const activeKey = key!;
  const activeId = occurrence.id;
  return (
    <NativeToast
      container={container}
      message={{
        id: activeId,
        role: 'alert',
        text:
          lookup?.key === activeKey && lookup.failed
            ? '暂时无法核对原审批答复，请稍后重试。不会重复提交。'
            : errorText(notice) +
              (pending.length > 1 ? `另有 ${pending.length - 1} 项审批异常。` : ''),
        actions: [
          {
            label: '核对原答复',
            disabled: flight.current === activeKey,
            onClick: () => {
              if (
                !current.current.visible ||
                current.current.key !== activeKey ||
                flight.current === activeKey
              )
                return;
              flight.current = activeKey;
              setLookup({ key: activeKey, failed: false });
              void current.current.lookup(notice).then(
                () => {
                  if (flight.current === activeKey) flight.current = undefined;
                  if (current.current.key === activeKey) setLookup(undefined);
                },
                () => {
                  if (flight.current === activeKey) flight.current = undefined;
                  if (current.current.key === activeKey) {
                    setLookup({ key: activeKey, failed: true });
                    setOccurrence({ key: activeKey, id: ++sequence.current });
                  }
                },
              );
            },
          },
        ],
      }}
      onDismiss={
        notice.phase === 'unknown' && !notice.commandId
          ? undefined
          : (id) => {
              if (!current.current.visible || id !== activeId || current.current.key !== activeKey)
                return;
              if (notice.phase === 'failed') dismissedFailures.add(prefix + activeKey);
              setDismissed((previous) => new Set(previous).add(activeKey));
            }
      }
    />
  );
}
