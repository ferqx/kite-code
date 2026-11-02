import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kite-ai/ui/desktop';
import { type ComponentProps, useCallback, useState } from 'react';

/** Keep setting menus inside the current dialog's theme and focus boundary. */
export function NativeSettingsSelect({
  value,
  onValueChange,
  options,
  ...props
}: Omit<ComponentProps<typeof SelectTrigger>, 'children' | 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      setContainer(
        node?.closest<HTMLElement>('[role="dialog"]') ??
          node?.closest<HTMLElement>('.kite-client') ??
          null,
      );
      if (typeof props.ref === 'function') props.ref(node);
      else if (props.ref) props.ref.current = node;
    },
    [props.ref],
  );
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        // Updating a form's hidden select can emit an empty value while options change.
        if (options.some((option) => option.value === next)) onValueChange(next);
      }}
      disabled={props.disabled}
    >
      <SelectTrigger {...props} ref={triggerRef}>
        <SelectValue>{options.find((option) => option.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent container={container}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
