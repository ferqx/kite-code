import { type ComponentProps, type ComponentType, type ReactNode, useState } from 'react';
import { AnimatedCollapsibleContent } from './components/ui/collapsible';

type ContentProps = ComponentProps<typeof AnimatedCollapsibleContent>;

function DeferredProcessBody({ render }: { render: () => ReactNode }) {
  return render();
}

/** Do not project cold closed details; keep current facts through the normal exit lifecycle. */
export function DeferredProcessContent({
  open,
  render,
  component: Content = AnimatedCollapsibleContent,
  ...props
}: Omit<ContentProps, 'children' | 'forceMount'> & {
  open: boolean;
  render: () => ReactNode;
  component?: ComponentType<ContentProps>;
}) {
  const [visited, setVisited] = useState(open);
  if (open && !visited) setVisited(true);
  if (!open && !visited) return null;
  return (
    <Content {...props}>
      <DeferredProcessBody render={render} />
    </Content>
  );
}
