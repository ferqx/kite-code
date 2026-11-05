import { Input } from './input';

/** shadcn Date Picker / Time Picker input composition, at schedule minute precision. */
export function TimePicker({
  id,
  value,
  onValueChange,
  disabled = false,
  form,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  form?: string;
}) {
  return (
    <Input
      id={id}
      form={form}
      type="time"
      step={60}
      aria-label="时间"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      disabled={disabled}
      required
      className="time-picker-input appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
    />
  );
}
