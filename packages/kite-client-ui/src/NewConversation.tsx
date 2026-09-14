import { ArrowDown01Icon, Folder01Icon, GitBranchIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type ComponentProps, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
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

function ContextMenu(props: {
  name: string;
  label: string;
  icon: ComponentProps<typeof HugeiconsIcon>['icon'];
  selected?: string;
  options: readonly { value: string; label: string; detail?: string }[];
  disabled: boolean;
  onSelect: (value: string) => void;
  action: { label: string; run: () => void };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="context-selector">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            className="ghost context-trigger"
            aria-label={props.name}
            title={props.label}
            disabled={props.disabled}
          >
            <HugeiconsIcon icon={props.icon} />
            <span>{props.label}</span>
            <HugeiconsIcon className="context-trigger-chevron" icon={ArrowDown01Icon} />
          </Button>
        </DropdownMenuTrigger>
        {open && (
          <DropdownMenuContent
            forceMount
            className="context-menu"
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={16}
            loop
            portalled={false}
            aria-label={props.name}
          >
            <DropdownMenuRadioGroup value={props.selected}>
              <DropdownMenuGroup>
                {props.options.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    className="context-menu-item"
                    value={option.value}
                    indicatorPosition="end"
                    onSelect={() => props.onSelect(option.value)}
                  >
                    <span className="context-menu-label">
                      {option.label}
                      {option.detail && <small>{option.detail}</small>}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="context-menu-item context-menu-action"
                onSelect={props.action.run}
              >
                <span>{props.action.label}</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        )}
      </DropdownMenu>
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
        icon={Folder01Icon}
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
      {props.workspace && props.branch?.repository === true && (
        <ContextMenu
          name="分支"
          label={props.branch?.label ?? (props.busy ? '正在读取分支…' : '分支暂不可用')}
          icon={GitBranchIcon}
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
