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
  /** Inline content is visible before a separate group disclosure exists. */
  open: boolean | 'inline';
  render: () => ReactNode;
  component?: ComponentType<ContentProps>;
}) {
  const [visited, setVisited] = useState(open === true);
  if (open === true && !visited) setVisited(true);
  if (open === 'inline' && visited) setVisited(false);
  if (open === false && !visited) return null;
  return (
    <Content {...props}>
      <DeferredProcessBody render={render} />
    </Content>
  );
}
