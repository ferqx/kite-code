import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import { useConversationReadActive } from '../conversation-activity';

export const ClipboardWriteContext = createContext<((text: string) => Promise<void>) | undefined>(
  undefined,
);

/** The surrounding message projects its existing verified copy eligibility. */
export const CodeCopyEligibilityContext = createContext(true);

/** Exact-text clipboard feedback shared by messages and code blocks. */
export function useTextCopy(
  text: string,
  writeClipboardText?: (text: string) => Promise<void>,
  disabled = false,
) {
  const conversationReadActive = useConversationReadActive();
  const copyEligible = useContext(CodeCopyEligibilityContext);
  const readActive = conversationReadActive && copyEligible;
  const inheritedWrite = useContext(ClipboardWriteContext);
  const writer = writeClipboardText ?? inheritedWrite;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyAttempt = useRef(0);
  const mounted = useRef(false);
  const current = useRef({ text, disabled, writer });
  current.current = { text, disabled: disabled || !readActive, writer };
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
  useLayoutEffect(() => {
    mounted.current = true;
    if (installed.current.text !== text || installed.current.disabled !== disabled) {
      installed.current = { text, disabled };
      resetAt.current = 0;
      setCopyState('idle');
    } else scheduleReset();
    return () => {
      mounted.current = false;
      copyAttempt.current++;
      if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
      copyResetTimer.current = undefined;
    };
  }, [text, disabled, readActive, writer, scheduleReset]);
  const copyMessage = useCallback(async () => {
    if (
      !mounted.current ||
      !text ||
      current.current.disabled ||
      current.current.writer !== writer ||
      current.current.text !== text
    )
      return;
    const attempt = ++copyAttempt.current;
    resetAt.current = 0;
    if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = undefined;
    const active = () =>
      mounted.current &&
      attempt === copyAttempt.current &&
      current.current.text === text &&
      current.current.writer === writer &&
      !current.current.disabled;
    try {
      if (writer) await writer(text);
      else await navigator.clipboard.writeText(text);
      if (!active()) return;
      setCopyState('copied');
      resetAt.current = Date.now() + 2000;
      scheduleReset();
    } catch {
      if (active()) setCopyState('failed');
    }
  }, [text, writer, scheduleReset]);
  return { copyState, copyMessage, readActive };
}
