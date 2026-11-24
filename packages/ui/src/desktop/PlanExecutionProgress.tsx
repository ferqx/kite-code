import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  BulbIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useId, useState } from 'react';
import { ScrollArea } from './components/ui/scroll-area';
import { Button } from './ui';

export type PlanExecutionSnapshot = {
  title: string;
  version: number;
  reviewExecutionId: string;
  steps: readonly {
    id: string;
    title: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'compensated';
  }[];
};
export type PlanExecutionOutcome = 'completed' | 'failed' | 'cancelled' | 'aborted';

const stepLabels = {
  pending: '待开始',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  blocked: '受阻',
  compensated: '已补偿',
} satisfies Record<PlanExecutionSnapshot['steps'][number]['status'], string>;

const outcomeLabels = {
  completed: '本轮已完成',
  failed: '本轮异常结束',
  cancelled: '本轮已停止',
  aborted: '本轮已中断',
} satisfies Record<PlanExecutionOutcome, string>;

function Steps({ steps }: { steps: PlanExecutionSnapshot['steps'] }) {
  return (
    <ol className="native-plan-steps" aria-label="计划步骤">
      {steps.map(({ id, title, status }) => (
        <li key={id} data-status={status}>
          <span className="native-plan-step-icon" aria-hidden="true">
            {status === 'completed' && <HugeiconsIcon icon={Tick02Icon} />}
          </span>
          <span className="native-plan-step-title">{title}</span>
          <span className="native-plan-step-status">{stepLabels[status]}</span>
        </li>
      ))}
    </ol>
  );
}

export function PlanExecutionProgress({
  plan,
  stale,
  outcome,
  open,
  onOpenChange,
  onLocate,
}: {
  plan: PlanExecutionSnapshot;
  stale: boolean;
  outcome?: PlanExecutionOutcome;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLocate: () => void;
}) {
  const stepsId = useId();
  const done = plan.steps.filter((step) => step.status === 'completed').length;
  const current =
    plan.steps.find((step) => step.status === 'running') ??
    plan.steps.find((step) => step.status === 'blocked' || step.status === 'failed') ??
    plan.steps.find((step) => step.status === 'pending' || step.status === 'compensated');
  const turnStatus = outcome
    ? `${outcomeLabels[outcome]}${stale ? ' · 步骤待核实' : ''}`
    : stale
      ? '状态待核实'
      : done === plan.steps.length
        ? '正在整理执行结果'
        : undefined;
  const status = turnStatus ?? (current && stepLabels[current.status]);
  const count = `${done}/${plan.steps.length}`;
  const detail = !turnStatus && current ? `${status} · ${current.title}` : status;
  const progressLabel = detail ? `已完成 ${count}，${detail}` : `已完成 ${count}`;
  return (
    <section className="background-execution-group native-plan-environment" aria-label="计划">
      <h3>计划</h3>
      <div className="native-plan-row">
        <Button
          type="button"
          variant="ghost"
          className="native-plan-locate"
          title={plan.title}
          aria-label={`查看原计划：${plan.title}`}
          onClick={onLocate}
        >
          <HugeiconsIcon icon={BulbIcon} aria-hidden="true" />
          <span>{plan.title}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="native-plan-progress-toggle"
          title={progressLabel}
          aria-label={`${open ? '收起' : '展开'}计划步骤，${progressLabel}`}
          aria-expanded={open}
          aria-controls={stepsId}
          onClick={() => onOpenChange(!open)}
        >
          <span className="native-plan-progress-count">{count}</span>
          {status && <span className="native-plan-progress-current">{status}</span>}
          <HugeiconsIcon icon={ArrowDown01Icon} aria-hidden="true" />
        </Button>
      </div>
      <div id={stepsId} hidden={!open}>
        {open && (
          <ScrollArea
            className="environment-list-scroll native-plan-steps-scroll"
            fade="y"
            nativeScrollbars
          >
            <Steps steps={plan.steps} />
          </ScrollArea>
        )}
      </div>
    </section>
  );
}

export function PlanExecutionHistory<T extends PlanExecutionSnapshot>({
  plans,
  onLocate,
}: {
  plans: readonly T[];
  onLocate: (plan: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  return (
    <div className="native-plan-history">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-expanded={open}
        aria-controls={stepsId}
        onClick={() => setOpen(!open)}
      >
        <HugeiconsIcon icon={BulbIcon} aria-hidden="true" />
        {open ? '收起执行步骤' : '查看执行步骤'}
      </Button>
      <div id={stepsId} hidden={!open}>
        {open &&
          plans.map((plan) => (
            <section className="native-plan-history-version" key={plan.reviewExecutionId}>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="native-plan-history-title"
                onClick={() => onLocate(plan)}
              >
                <span>{plan.title}</span>
                <span className="native-plan-progress-count">第 {plan.version} 版</span>
                <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />
              </Button>
              <Steps steps={plan.steps} />
            </section>
          ))}
      </div>
    </div>
  );
}
