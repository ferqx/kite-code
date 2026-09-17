const labels: Readonly<Record<string, string>> = {
  idle: '等待下一步',
  queued: '排队中',
  creating: '创建中',
  running: '正在工作',
  waiting: '等待交互',
  auto_reviewing: '自动审查中',
  completed: '已完成',
  interrupted: '已中断',
  failed: '失败',
  rejected: '已拒绝',
  cancelled: '已停止',
  unavailable: '暂不可用',
  unknown: '结果未知',
  recovery_required: '需要恢复',
};
export function statusLabel(status: string): string {
  return labels[status] ?? status;
}

const childLabels: Readonly<Record<string, string>> = {
  creating: '创建中',
  running: '运行中',
  waiting: '等待中',
  auto_reviewing: '自动审批中',
  completed: '已完成',
  interrupted: '已中断',
  cancelled: '已取消',
  failed: '已失败',
};

export function childStatusLabel(status: string): string {
  return childLabels[status] ?? statusLabel(status);
}

export function sessionStatusLabel(status: string): string | undefined {
  return status === 'idle' || status === 'completed' ? undefined : statusLabel(status);
}
