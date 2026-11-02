import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './native-message.css';

export function humanReadableOperationError(code: string, operation?: string): string {
  switch (code) {
    case 'quit_confirmation_unavailable':
      return '退出确认暂时无法显示，应用仍在运行。请稍后再试。';
    case 'permission_denied':
    case 'permission_mode_denied':
      return '当前没有执行此操作的权限，请检查会话权限。';
    case 'permission_facts_unavailable':
    case 'permission_observation_unavailable':
      return '当前权限尚未核实，请等待状态恢复后再操作。';
    case 'workspace_not_found':
    case 'workspace_missing':
      return '工作区已不存在，请重新选择工作区。';
    case 'workspace_unavailable':
    case 'workspace_observation_unavailable':
      return '工作区暂不可用，请检查目录是否仍存在且可以访问。';
    case 'workspace_untrusted':
    case 'workspace_not_trusted':
    case 'workspace_trust_required':
      return '工作区尚未受信任，请先检查并确认工作区的信任状态。';
    case 'branch_not_found':
      return '所选分支已不存在，请重新选择分支。';
    case 'branch_unavailable':
    case 'branch_read_failed':
    case 'branch_selection_unavailable':
      return '分支暂不可用，请检查仓库和分支状态。';
    case 'native_directory_unavailable':
    case 'directory_unavailable':
    case 'directory_read_failed':
      return '目录暂时无法读取，请稍后重试。';
    case 'session_directory_unavailable':
      return '会话列表暂时无法读取，请稍后重新读取目录。';
    case 'draft_revision_conflict':
      return '草稿已在其他地方更新，当前输入已保留。请重新读取草稿后再保存。';
    case 'draft_storage_unavailable':
      return '草稿暂时无法保存或读取，当前输入已保留。请稍后再试。';
    case 'network_unavailable':
    case 'connection_unavailable':
    case 'connection_lost':
    case 'disconnected':
    case 'service_unavailable':
    case 'native_connection_unavailable':
      return '连接暂不可用，请等待重新连接后再操作。';
    case 'read_only':
    case 'readonly':
    case 'store_read_only':
    case 'file_recovery_readonly':
      return '当前内容为只读，无法执行此操作。';
    case 'outcome_unknown':
    case 'result_unknown':
    case 'network_outcome_unknown':
    case 'conversation_response_unknown':
    case 'caller_outcome_unknown':
    case 'browser_draft_save_unconfirmed':
    case '结果待核实；请查询原命令。':
      return '操作结果尚未确认，请先核对原操作结果，避免重复提交。';
    default:
      return `${operation ?? '这一步'}未能完成，请稍后重试。`;
  }
}

export type NativeMessageProps = {
  message?: { id: number; text: string };
  onDismiss: (id: number) => void;
};

function MessageOccurrence({
  message,
  onDismiss,
}: {
  message: NonNullable<NativeMessageProps['message']>;
  onDismiss: NativeMessageProps['onDismiss'];
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(6000);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    let active = true;
    const deadline = Date.now() + remaining.current;
    const timer = setTimeout(() => {
      if (active) dismiss.current(message.id);
    }, remaining.current);
    return () => {
      active = false;
      clearTimeout(timer);
      remaining.current = Math.max(0, deadline - Date.now());
    };
  }, [message.id, paused]);

  return (
    <div className="native-message">
      <div
        className="native-message-card"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <p>{message.text}</p>
        <button
          type="button"
          className="native-message-close"
          aria-label="关闭提示"
          onClick={() => dismiss.current(message.id)}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}

/** One local, non-modal message; retiring an occurrence cannot dismiss its successor. */
export function NativeMessage({ message, onDismiss }: NativeMessageProps) {
  const current = useRef({ id: message?.id, onDismiss });
  useLayoutEffect(() => {
    current.current = { id: message?.id, onDismiss };
  }, [message?.id, onDismiss]);
  if (!message) return null;
  return (
    <MessageOccurrence
      key={message.id}
      message={message}
      onDismiss={(id) => {
        if (current.current.id === id) current.current.onDismiss(id);
      }}
    />
  );
}
