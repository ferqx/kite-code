import { useEffect, useId, useRef, useState } from 'react';
import { ScrollArea } from './components/ui/scroll-area';
import { Button } from './ui';

export interface NewConversationProps {
  projects: readonly { path: string; label: string }[];
  workspace: string;
  branch?: { current?: string; branches: readonly string[]; label: string; repository: boolean };
  busy: boolean;
  onProject: (path: string) => void;
  onAddProject: () => void;
  onBranch: (branch: string) => void;
  onRefreshBranch: () => void;
}

const suggestions = ['研究与理解资料', '整理与归纳内容', '创作可交付成果', '分析并解决问题'];

export function NewConversationWelcome({ onSuggest }: { onSuggest: (value: string) => void }) {
  return (
    <section className="new-conversation-welcome" aria-label="新对话">
      <h1>今天想在这个空间完成什么？</h1>
      <div className="task-suggestions">
        {suggestions.map((suggestion) => (
          <Button key={suggestion} onClick={() => onSuggest(`${suggestion}：`)}>
            {suggestion}
          </Button>
        ))}
      </div>
    </section>
  );
}

const icons = {
  folder: new URL('./assets/folder.svg', import.meta.url).href,
  local: new URL('./assets/local.svg', import.meta.url).href,
  branch: new URL('./assets/branch.svg', import.meta.url).href,
};

function ContextMenu(props: {
  name: string;
  label: string;
  icon: string;
  selected?: string;
  options: readonly { value: string; label: string; detail?: string }[];
  disabled: boolean;
  onSelect: (value: string) => void;
  action: { label: string; run: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(280);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    setWidth(
      Math.max(
        100,
        Math.min(320, window.innerWidth - (anchor.current?.getBoundingClientRect().left ?? 0) - 16),
      ),
    );
    (
      menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu.current?.querySelector<HTMLButtonElement>('button')
    )?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  const choose = (action: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };
  return (
    <div className="context-selector" ref={anchor}>
      <Button
        ref={trigger}
        className="ghost context-trigger"
        aria-label={props.name}
        title={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <img src={props.icon} alt="" width={16} height={16} />
        <span>{props.label}</span>
      </Button>
      {open && (
        <ScrollArea
          ref={menu}
          id={id}
          className="context-menu"
          style={{ width, height: Math.min(280, (props.options.length + 1) * 40 + 12) }}
          role="menu"
          aria-label={props.name}
          onMouseDown={(event) => {
            // WebKit can blur to the document when clicking a button. Keep the
            // menu mounted until its click handler has applied the selection.
            event.preventDefault();
          }}
          onBlur={(event) => {
            if (!anchor.current?.contains(event.relatedTarget as Node)) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
              }
              setOpen(false);
              trigger.current?.focus();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = [
              ...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []),
            ];
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          <div className="context-menu-content">
            {props.options.map((option) => (
              <Button
                key={option.value}
                className="ghost"
                role="menuitemradio"
                aria-checked={option.value === props.selected}
                onClick={() => choose(() => props.onSelect(option.value))}
              >
                <span>
                  {option.label}
                  {option.detail && <small>{option.detail}</small>}
                </span>
              </Button>
            ))}
            <Button
              className="ghost context-menu-action"
              role="menuitem"
              onClick={() => choose(props.action.run)}
            >
              {props.action.label}
            </Button>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

export function NewConversationContext(props: NewConversationProps) {
  return (
    <div className="new-conversation-context">
      <ContextMenu
        name="项目空间"
        label={
          props.projects.find((project) => project.path === props.workspace)?.label ?? '选择项目'
        }
        icon={icons.folder}
        selected={props.workspace}
        options={props.projects.map((project) => ({
          value: project.path,
          label: project.label,
          detail: project.path,
        }))}
        disabled={props.busy}
        onSelect={props.onProject}
        action={{ label: '添加项目…', run: props.onAddProject }}
      />
      <span className="context-environment">
        <img src={icons.local} alt="" width={16} height={16} />
        本地
      </span>
      {props.workspace && props.branch?.repository !== false && (
        <ContextMenu
          name="分支"
          label={props.branch?.label ?? (props.busy ? '正在读取分支…' : '分支暂不可用')}
          icon={icons.branch}
          selected={props.branch?.current}
          options={props.branch?.branches.map((branch) => ({ value: branch, label: branch })) ?? []}
          disabled={props.busy}
          onSelect={props.onBranch}
          action={{ label: '刷新分支', run: props.onRefreshBranch }}
        />
      )}
    </div>
  );
}
