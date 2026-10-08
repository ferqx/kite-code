import { ArrowDown01Icon, TriangleAlertIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AnimatedCollapsibleContent,
  Collapsible,
  CollapsibleTrigger,
} from './components/ui/collapsible';
import { Marker, MarkerContent, MarkerIcon } from './components/ui/marker';
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

/** A terminal notice uses tool-row primitives while retaining its system identity. */
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
  const summary =
    message.failure?.summary || message.text.trim().split('\n')[0] || '本轮回复未完成';
  const development = process.env.NODE_ENV === 'development';
  const detail = message.text || '当前记录未提供具体失败原因。';
  const outcome = message.failure?.outcome;
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
            <p>{development ? detail : detail.replace(/\s*\n+\s*/g, ' ')}</p>
            {development && (message.failure?.reasonCode || outcome) && (
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
