import {
  ArrowDown01Icon,
  Delete02Icon,
  DragDropVerticalIcon,
  PencilEdit01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useRef, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import { MessageContent } from './MessageContent';
import { Button } from './ui';

export interface QueuedPrompt {
  id: string;
  text: string;
  /** Inputs with images or other context cannot be replaced by a text-only draft. */
  editable?: boolean;
  steerable?: boolean;
}
export interface QueuedMessagesProps {
  items: readonly QueuedPrompt[];
  disabled?: boolean;
  pendingId?: string;
  onEdit: (id: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onReorder: (ids: readonly string[]) => void | Promise<void>;
  onSteer?: (id: string) => void | Promise<void>;
}

/** Presentation only: the host withdraws or reorders the actual pending inputs. */
export function QueuedMessages(props: QueuedMessagesProps) {
  const [open, setOpen] = useState(true);
  const dragged = useRef<{ id: string; order: string } | null>(null);
  const blocked = !!props.disabled || props.pendingId !== undefined;
  const ids = props.items.map((item) => item.id);
  const order = JSON.stringify(ids);
  const move = (id: string, target: number) => {
    if (blocked || target < 0 || target >= ids.length) return;
    const from = ids.indexOf(id);
    if (from < 0 || from === target) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(target, 0, id);
    void props.onReorder(next);
  };
  if (!props.items.length) return null;
  return (
    <Collapsible className="composer-queue" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="composer-queue-heading">
          <span>已排队 {props.items.length} 条</span>
          <HugeiconsIcon icon={ArrowDown01Icon} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <TooltipProvider delayDuration={350}>
          <ul
            className="composer-queue-list"
            aria-label="排队消息"
            aria-busy={props.pendingId !== undefined}
          >
            {props.items.map((item, index) => (
              <li
                key={item.id}
                data-queued-prompt={item.id}
                className="composer-queue-row"
                onDragOver={(event) => {
                  if (blocked || !dragged.current || dragged.current.order !== order) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  if (!dragged.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const source = dragged.current;
                  dragged.current = null;
                  if (source.order === order) move(source.id, index);
                }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="composer-queue-drag"
                  aria-label="移动排队消息"
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  disabled={blocked}
                  draggable={!blocked}
                  onDragStart={(event) => {
                    if (blocked) {
                      event.preventDefault();
                      return;
                    }
                    event.stopPropagation();
                    dragged.current = { id: item.id, order };
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-kite-queued-prompt', item.id);
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                  }}
                  onKeyDown={(event) => {
                    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    move(item.id, index + (event.key === 'ArrowUp' ? -1 : 1));
                  }}
                >
                  <HugeiconsIcon icon={DragDropVerticalIcon} />
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Focus makes the complete Markdown accessible without a pointer. */}
                    <div
                      role="document"
                      className="composer-queue-preview"
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: Read-only Markdown tooltip needs a keyboard focus target.
                      tabIndex={0}
                      aria-label="排队消息全文"
                    >
                      <MessageContent text={item.text} />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent
                    className="kite-client composer-queue-tooltip"
                    side="top"
                    align="start"
                    sideOffset={8}
                  >
                    <MessageContent text={item.text} />
                  </TooltipContent>
                </Tooltip>
                {props.onSteer && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="引导发送排队消息"
                    disabled={blocked || !item.steerable}
                    onClick={() => {
                      if (!blocked && item.steerable) void props.onSteer?.(item.id);
                    }}
                  >
                    引导发送
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="编辑排队消息"
                  disabled={blocked || item.editable === false}
                  title={
                    item.editable === false
                      ? '包含附件或其他上下文，无法作为纯文本重新编辑'
                      : undefined
                  }
                  onClick={() => {
                    if (!blocked && item.editable !== false) void props.onEdit(item.id);
                  }}
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="删除排队消息"
                  disabled={blocked}
                  onClick={() => {
                    if (!blocked) void props.onDelete(item.id);
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} />
                </Button>
              </li>
            ))}
          </ul>
        </TooltipProvider>
      </CollapsibleContent>
    </Collapsible>
  );
}
