const labels: Readonly<Record<string, string>> = {
  idle: '等待下一步',
  queued: '排队中',
  running: '正在工作',
  waiting: '等待交互',
  completed: '已完成',
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

export function sessionStatusLabel(status: string): string | undefined {
  return status === 'idle' || status === 'completed' ? undefined : statusLabel(status);
}
