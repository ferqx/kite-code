import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type ComponentProps, type CSSProperties, type ReactNode, useId } from 'react';
import {
  fileTreeFileIcon,
  fileTreeFolderIcon,
  fileTreeIconDirectory,
} from '../../lib/file-tree-icons';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';

type FileTreeRowProps = Omit<ComponentProps<typeof Button>, 'children'> & {
  label: string;
  path?: string;
};

function FileTreeIcon({
  icons,
  className,
}: {
  icons: ReturnType<typeof fileTreeFileIcon>;
  className?: string;
}) {
  function image(file?: string) {
    if (!file) return undefined;
    const path = `./${fileTreeIconDirectory}/${file}`;
    const url = globalThis.document ? (URL.parse(path, document.baseURI)?.href ?? path) : path;
    return `url("${url}")`;
  }
  return (
    <span
      aria-hidden="true"
      data-slot="file-tree-icon"
      className={className}
      style={
        {
          '--file-tree-icon-light': image(icons.light),
          '--file-tree-icon-dark': image(icons.dark),
        } as CSSProperties
      }
    />
  );
}

export function FileTree(props: ComponentProps<'div'>) {
  return <div {...props} role="tree" data-slot="file-tree" />;
}

export function FileTreeFolder({
  label,
  path = label,
  className,
  open,
  onOpenChange,
  children,
  ...props
}: FileTreeRowProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}) {
  const groupId = useId();
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} data-slot="file-tree-folder">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('group w-full justify-start', className)}
          {...props}
          role="treeitem"
          aria-controls={groupId}
          aria-owns={open && children ? groupId : undefined}
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            className="size-3 text-muted-foreground group-aria-expanded:rotate-90"
            aria-hidden="true"
          />
          <FileTreeIcon icons={fileTreeFolderIcon(path, open)} />
          <span className="min-w-0 truncate" data-slot="file-tree-name">
            {label}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent id={groupId} role={children ? 'group' : undefined}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function FileTreeFile({
  label,
  path = label,
  className,
  children,
  ...props
}: FileTreeRowProps & { children?: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn('w-full justify-start', className)}
      {...props}
      role="treeitem"
    >
      <FileTreeIcon icons={fileTreeFileIcon(path)} className="ms-4" />
      <span className="min-w-0 truncate" data-slot="file-tree-name">
        {label}
      </span>
      {children}
    </Button>
  );
}
