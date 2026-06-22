import { Box, Text } from 'ink';
import { useTheme } from '@/app/tui/theme';
import type { AgentPlan, PlanStatus } from '@/protocol/events';

const STATUS_ICON: Record<PlanStatus, string> = {
  pending: '○',
  in_progress: '●',
  completed: '✓',
};

function statusColor(status: PlanStatus, t: ReturnType<typeof useTheme>): string {
  switch (status) {
    case 'completed':
      return t.success;
    case 'in_progress':
      return t.primary;
    case 'pending':
      return t.muted;
  }
}

const MAX_VISIBLE = 5;

interface TaskProgressBlockProps {
  plan: AgentPlan;
}

/** 审批通过后的紧凑任务进度 / Compact task progress shown after plan approval.
 *  以当前 in_progress 步骤为中心展示相邻步骤，超过上限时折叠首尾。 */
export default function TaskProgressBlock({ plan }: TaskProgressBlockProps) {
  const t = useTheme();

  if (!plan.steps || plan.steps.length === 0) return null;

  const inProgressIdx = plan.steps.findIndex((s) => s.status === 'in_progress');
  // 如果有多条 in_progress（模型 bug），取最后一条
  const center = inProgressIdx >= 0 ? inProgressIdx : plan.steps.length - 1;
  const total = plan.steps.length;

  let visible: { step: string; status: PlanStatus; idx: number }[];
  let headSkipped = 0;
  let tailSkipped = 0;

  if (total <= MAX_VISIBLE) {
    visible = plan.steps.map((s, i) => ({ ...s, idx: i }));
  } else {
    // 以 center 为中心取窗口 / Window around the center step
    const half = Math.floor((MAX_VISIBLE - 1) / 2);
    let start = Math.max(0, center - half);
    let end = Math.min(total, start + MAX_VISIBLE);
    if (end - start < MAX_VISIBLE) {
      start = Math.max(0, end - MAX_VISIBLE);
    }
    headSkipped = start;
    tailSkipped = total - end;
    visible = plan.steps.slice(start, end).map((s, i) => ({ ...s, idx: start + i }));
  }

  return (
    <Box flexDirection="column" marginX={1}>
      {headSkipped > 0 && (
        <Text color={t.dim}>
          ✓ {headSkipped} completed ···
        </Text>
      )}
      {visible.map((s) => (
        <Text key={`${s.step}-${s.idx}`} color={statusColor(s.status, t)}>
          {STATUS_ICON[s.status]} {s.idx + 1}. {s.step}
        </Text>
      ))}
      {tailSkipped > 0 && (
        <Text color={t.dim}>
          ··· +{tailSkipped} remaining
        </Text>
      )}
    </Box>
  );
}
