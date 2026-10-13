import { Copy01Icon, CopyXIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useRef, useState } from 'react';
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
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyAttempt = useRef(0);
  const current = useRef({ text, disabled });
  current.current = { text, disabled };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Text and visibility changes retire prior clipboard attempts and timers.
  useEffect(() => {
    setCopyState('idle');
    return () => {
      copyAttempt.current++;
      if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
      copyResetTimer.current = undefined;
    };
  }, [text, disabled]);
  const copyLabel =
    copyState === 'copied'
      ? '已复制消息'
      : copyState === 'failed'
        ? '复制失败，请重试'
        : copyRole === 'user'
          ? '复制本轮用户消息'
          : '复制本轮Agent回复';
  async function copyMessage() {
    if (!text || disabled) return;
    const attempt = ++copyAttempt.current;
    if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = undefined;
    const active = () =>
      attempt === copyAttempt.current && current.current.text === text && !current.current.disabled;
    try {
      if (writeClipboardText) await writeClipboardText(text);
      else await navigator.clipboard.writeText(text);
      if (!active()) return;
      setCopyState('copied');
      copyResetTimer.current = setTimeout(() => {
        copyResetTimer.current = undefined;
        setCopyState('idle');
      }, 2000);
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
