import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import { useConversationActivity } from '../conversation-activity';
import { MessageContent } from './MessageContent';
import { useReadGate } from './ReadGate';
import { Button } from './ui';

/** Submitted prompts share the complete renderer used by Agent replies. */
export const PromptMarkdown = memo(function PromptMarkdown({
  text,
  openFile,
}: {
  text: string;
  openFile?: (path: string) => void;
}) {
  const { readActive } = useConversationActivity();
  const blocked = useReadGate();
  const root = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsing = useRef(false);
  const revealing = useRef<HTMLElement | undefined>(undefined);
  const id = useId();
  useLayoutEffect(() => {
    const element = root.current;
    const content = element?.querySelector('.typeset-chat');
    const toggle = controls.current;
    if (!readActive || !element || !content || !toggle) return;
    if (!text) {
      setOverflow(false);
      return;
    }
    const measure = () => {
      // The controls retain the CSS crop limit even while the prose is expanded.
      const limit = Number.parseFloat(getComputedStyle(toggle).maxHeight);
      setOverflow(content.getBoundingClientRect().height > limit + 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(content);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [text, readActive]);
  useLayoutEffect(() => {
    if (expanded && revealing.current) {
      revealing.current.scrollIntoView?.({ block: 'nearest' });
      revealing.current = undefined;
    }
    if (expanded || !collapsing.current) return;
    collapsing.current = false;
    (root.current?.closest('.user-message-body') ?? root.current)?.scrollIntoView?.({
      block: 'nearest',
    });
  }, [expanded]);
  return (
    <div ref={root} className="prompt-markdown" data-expanded={(expanded && overflow) || undefined}>
      <div
        id={id}
        className="prompt-markdown-viewport"
        onFocusCapture={(event) => {
          // Keyboard navigation must reveal a link or code action hidden by the crop.
          if (!readActive || blocked || expanded || !overflow) return;
          const target = event.target.getBoundingClientRect();
          if (target.bottom > event.currentTarget.getBoundingClientRect().bottom - 48) {
            revealing.current = event.target;
            setExpanded(true);
          }
        }}
      >
        <MessageContent text={text} openFile={openFile} />
      </div>
      <div ref={controls} className="prompt-markdown-controls" hidden={!overflow}>
        {overflow && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="prompt-markdown-toggle"
            aria-label={expanded ? '收起用户消息' : '展开用户消息'}
            aria-controls={id}
            aria-expanded={expanded}
            disabled={!readActive}
            onClick={() => {
              if (!readActive || blocked) return;
              collapsing.current = expanded;
              setExpanded(!expanded);
            }}
          >
            {expanded ? '收起' : '展开'}
            <HugeiconsIcon icon={ArrowDown01Icon} className="prompt-markdown-chevron" />
          </Button>
        )}
      </div>
    </div>
  );
});
