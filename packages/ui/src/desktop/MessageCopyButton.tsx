import { Copy01Icon, CopyXIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConversationReadActive } from '../conversation-activity';
import { Button } from './ui';

/** The host supplies exact text; this control never reconstructs a message or Turn. */
export function MessageCopyButton({
  text,
  copyRole,
  writeClipboardText,
  disabled = false,
}: {
  text: string;
  copyRole?: 'user' | 'assistant';
  writeClipboardText?: (text: string) => Promise<void>;
  disabled?: boolean;
}) {
  const readActive = useConversationReadActive();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyAttempt = useRef(0);
  const current = useRef({ text, disabled });
  current.current = { text, disabled: disabled || !readActive };
  const installed = useRef({ text, disabled });
  const resetAt = useRef(0);
  const scheduleReset = useCallback(() => {
    if (!resetAt.current) return;
    const remaining = resetAt.current - Date.now();
    if (remaining <= 0) {
      resetAt.current = 0;
      setCopyState('idle');
      return;
    }
    copyResetTimer.current = setTimeout(() => {
      copyResetTimer.current = undefined;
      resetAt.current = 0;
      setCopyState('idle');
    }, remaining);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Read admission changes retire pending clipboard attempts without resetting their visible feedback.
  useEffect(() => {
    if (installed.current.text !== text || installed.current.disabled !== disabled) {
      installed.current = { text, disabled };
      resetAt.current = 0;
      setCopyState('idle');
    } else scheduleReset();
    return () => {
      copyAttempt.current++;
      if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
      copyResetTimer.current = undefined;
    };
  }, [text, disabled, readActive, scheduleReset]);
  const copyLabel =
    copyState === 'copied'
      ? '已复制消息'
      : copyState === 'failed'
        ? '复制失败，请重试'
        : copyRole === 'user'
          ? '复制本轮用户消息'
          : '复制本轮Agent回复';
  async function copyMessage() {
    if (!text || current.current.disabled) return;
    const attempt = ++copyAttempt.current;
    resetAt.current = 0;
    if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = undefined;
    const active = () =>
      attempt === copyAttempt.current && current.current.text === text && !current.current.disabled;
    try {
      if (writeClipboardText) await writeClipboardText(text);
      else await navigator.clipboard.writeText(text);
      if (!active()) return;
      setCopyState('copied');
      resetAt.current = Date.now() + 2000;
      scheduleReset();
    } catch {
      if (active()) setCopyState('failed');
    }
  }
  return (
    <Button
      type="button"
      className="message-copy"
      data-copy-state={copyState}
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      aria-disabled={!readActive || disabled || undefined}
      aria-label={copyLabel}
      title={copyLabel}
      onClick={() => void copyMessage()}
    >
      <HugeiconsIcon
        className={copyState === 'copied' ? 'size-[18px]' : undefined}
        icon={copyState === 'copied' ? Tick02Icon : copyState === 'failed' ? CopyXIcon : Copy01Icon}
      />
    </Button>
  );
}
