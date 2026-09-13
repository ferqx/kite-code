import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { ScrollArea } from './components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Button } from './ui';

export interface RightSidebarTab {
  readonly value: string;
  readonly label: string;
  readonly content: ReactNode;
}

export interface RightSidebarProps {
  readonly id?: string;
  readonly label: string;
  readonly title?: string;
  readonly tabs?: readonly RightSidebarTab[];
  readonly children?: ReactNode;
  readonly onClose: () => void;
}

/** Shared rightmost page rail. Content decides whether its header is titled or tabbed. */
export function RightSidebar({ id, label, title, tabs, children, onClose }: RightSidebarProps) {
  const close = (
    <Button
      className="ghost right-sidebar-close"
      size="icon-sm"
      aria-label="关闭"
      title="关闭"
      onClick={onClose}
    >
      <HugeiconsIcon icon={Cancel01Icon} />
    </Button>
  );

  if (tabs?.length) {
    return (
      <aside className="right-sidebar" id={id} aria-label={label}>
        <Tabs className="right-sidebar-tabs" defaultValue={tabs[0]!.value}>
          <header className="right-sidebar-heading">
            <TabsList aria-label={label}>
              {tabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {close}
          </header>
          <ScrollArea className="right-sidebar-scroll">
            {tabs.map((tab) => (
              <TabsContent key={tab.value} value={tab.value}>
                {tab.content}
              </TabsContent>
            ))}
          </ScrollArea>
        </Tabs>
      </aside>
    );
  }

  return (
    <aside className="right-sidebar" id={id} aria-label={label}>
      <header className="right-sidebar-heading">
        <h2>{title ?? label}</h2>
        {close}
      </header>
      <div className="right-sidebar-content">{children}</div>
    </aside>
  );
}
