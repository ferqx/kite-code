import {
  ArrowDown01Icon,
  InformationCircleIcon,
  TriangleAlertIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert, AlertDescription } from './components/ui/alert';
import {
  AnimatedCollapsibleContent,
  Collapsible,
  CollapsibleTrigger,
} from './components/ui/collapsible';
import { Marker, MarkerContent, MarkerIcon } from './components/ui/marker';
import { useDesktopDiagnostics } from './diagnostics';
import type { Message } from './types';
import { Button } from './ui';

const OUTCOME_LABELS = {
  completed: '已完成',
  aborted: '已中止',
  blocked: '执行受阻',
  unknown: '结果待核实',
  budget_exhausted: '执行额度已用尽',
  resource_saturated: '执行资源暂不可用',
};
const RECOVERY_LABELS = {
  none: '未提供后续处理方式',
  retry: '可以重试',
  reconcile: '先核对执行状态与结果',
  new_run: '检查失败原因后开始新一轮',
  operator_action: '先处理相关配置或服务问题',
};

/** Exceptions are alerts, independent of chat messages and Tool execution records. */
export function TurnFailure({
  message,
  expanded = false,
  onToggle,
  restoredExpanded,
}: {
  message: Message;
  expanded?: boolean;
  onToggle: (open: boolean) => void;
  restoredExpanded?: boolean;
}) {
  const summary = message.failure?.summary || '本轮异常结束';
  const diagnostics = useDesktopDiagnostics();
  const detail =
    message.text ||
    '当前记录未提供可核实的错误原因。请检查模型连接和配置；重新发送前，先核对本轮工具执行结果，避免重复操作。';
  const outcome = message.failure?.outcome;
  if (!diagnostics)
    return (
      <Alert className="turn-failure" aria-label={summary}>
        <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
        <AlertDescription>{detail}</AlertDescription>
      </Alert>
    );
  return (
    <Collapsible asChild open={expanded} onOpenChange={onToggle}>
      <article
        className="message tool-activity turn-failure"
        data-restored-expanded={restoredExpanded || undefined}
        aria-label="回复失败"
      >
        <CollapsibleTrigger asChild>
          <Marker asChild className="tool-activity-summary">
            <Button
              variant="ghost"
              aria-label={`${expanded ? '收起' : '展开'}回复失败详情：${summary}`}
            >
              <MarkerIcon className="tool-activity-marker-icon">
                <HugeiconsIcon className="tool-activity-kind-icon" icon={TriangleAlertIcon} />
              </MarkerIcon>
              <MarkerContent className="tool-activity-marker-content">
                <span className="tool-activity-title tool-label">回复失败</span>
                <span className="tool-step-preview" title={summary}>
                  {summary}
                </span>
              </MarkerContent>
              <HugeiconsIcon
                className="tool-activity-chevron"
                icon={ArrowDown01Icon}
                data-icon="inline-end"
                aria-hidden="true"
              />
            </Button>
          </Marker>
        </CollapsibleTrigger>
        <AnimatedCollapsibleContent className="tool-activity-content">
          <section className="turn-failure-details" aria-label="回复失败详情">
            <p>{diagnostics ? detail : detail.replace(/\s*\n+\s*/g, ' ')}</p>
            {diagnostics && (message.failure?.reasonCode || outcome) && (
              <dl>
                {message.failure?.reasonCode && (
                  <>
                    <dt>原因代码</dt>
                    <dd>
                      <code>{message.failure.reasonCode}</code>
                    </dd>
                  </>
                )}
                {outcome && (
                  <>
                    <dt>执行结果</dt>
                    <dd>{OUTCOME_LABELS[outcome.status]}</dd>
                    <dt>直接重试</dt>
                    <dd>{outcome.safeRetry ? '允许' : '未确认安全，请先核对失败原因'}</dd>
                    <dt>后续处理</dt>
                    <dd>{RECOVERY_LABELS[outcome.recoveryEntry]}</dd>
                  </>
                )}
              </dl>
            )}
          </section>
        </AnimatedCollapsibleContent>
      </article>
    </Collapsible>
  );
}
