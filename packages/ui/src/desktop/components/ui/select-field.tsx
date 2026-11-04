import { type ComponentProps, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

export interface SelectFieldOption {
  readonly value: string;
  readonly label: string;
}

/** Controlled options, including an explicit empty choice, without forwarding transient resets. */
export function SelectField({
  value,
  options,
  onValueChange,
  placeholder,
  required,
  disabled,
  ...props
}: Omit<
  ComponentProps<typeof SelectTrigger>,
  'children' | 'value' | 'onChange' | 'ref' | 'name'
> & {
  value: string;
  options: readonly SelectFieldOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const selected = value === '' ? -1 : options.findIndex((option) => option.value === value);
  const container =
    trigger?.closest<HTMLElement>('[role="dialog"]') ??
    trigger?.closest<HTMLElement>('.kite-client') ??
    undefined;
  return (
    <Select
      value={selected < 0 ? '' : `option:${selected}`}
      required={required}
      disabled={disabled}
      onValueChange={(next) => {
        const index = options.findIndex((_, index) => next === `option:${index}`);
        if (index >= 0) onValueChange(options[index]!.value);
      }}
    >
      <SelectTrigger {...props} ref={setTrigger} disabled={disabled}>
        <SelectValue
          placeholder={options.find((option) => option.value === '')?.label ?? placeholder}
        >
          {selected < 0 ? undefined : options[selected]!.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent container={container}>
        {options.map((option, index) => (
          <SelectItem key={`option:${index}`} value={`option:${index}`}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
