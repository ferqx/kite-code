import { Box, Text } from 'ink';
import { useTheme } from '@/app/tui/theme';
import type { AgentPlan, PlanStatus } from '@/protocol/events';

const STATUS_ICON: Record<PlanStatus, string> = {
  pending: '○',
  in_progress: '▶',
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

interface TaskProgressBlockProps {
  plan: AgentPlan;
}

/** 审批通过后的只读任务进度列表 / Read-only task progress list shown after plan approval */
export default function TaskProgressBlock({ plan }: TaskProgressBlockProps) {
  const t = useTheme();

  if (!plan.steps || plan.steps.length === 0) return null;

  return (
    <Box flexDirection="column" marginX={1}>
      {plan.steps.map((s, i) => (
        <Text key={`${s.step}-${i}`} color={statusColor(s.status, t)}>
          {STATUS_ICON[s.status]} {s.step}
        </Text>
      ))}
    </Box>
  );
}
