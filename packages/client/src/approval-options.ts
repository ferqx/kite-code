/** Display and select frozen server options; this reader never creates an authorization scope. */
export interface ApprovalOptionView {
  readonly optionId: string;
  readonly kind: 'once' | 'scope';
  readonly presentation: { readonly label: string; readonly details: readonly string[] };
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function readApprovalOptions(request: unknown): readonly ApprovalOptionView[] {
  if (!record(request) || !Array.isArray(request.options) || !request.options.length) return [];
  const options: ApprovalOptionView[] = [];
  const ids = new Set<string>();
  for (const option of request.options) {
    if (
      !record(option) ||
      typeof option.optionId !== 'string' ||
      !option.optionId ||
      ids.has(option.optionId) ||
      (option.kind !== 'once' && option.kind !== 'scope') ||
      !record(option.presentation) ||
      typeof option.presentation.label !== 'string' ||
      !option.presentation.label ||
      !Array.isArray(option.presentation.details) ||
      !option.presentation.details.every((detail): detail is string => typeof detail === 'string')
    )
      return [];
    ids.add(option.optionId);
    options.push({
      optionId: option.optionId,
      kind: option.kind,
      presentation: { label: option.presentation.label, details: [...option.presentation.details] },
    });
  }
  return options.filter((option) => option.kind === 'once').length === 1 ? options : [];
}
