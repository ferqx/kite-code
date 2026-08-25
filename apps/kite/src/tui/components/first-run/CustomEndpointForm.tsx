import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';
import type { ConnectionFormState, ProviderDefinition } from './types';

interface CustomEndpointFormProps {
  provider: ProviderDefinition;
  form: ConnectionFormState;
  editingField?: string;
  error?: string;
  onEditingFieldChange: (field?: string) => void;
  onCancelEdit: (field: string, restoreValue: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onUpdateField: (field: keyof ConnectionFormState, value: string) => void;
}

type FocusTarget = 'baseURL' | 'apiKey';

export function CustomEndpointForm({
  provider,
  form,
  editingField,
  error,
  onEditingFieldChange,
  onCancelEdit,
  onSubmit,
  onBack,
  onUpdateField,
}: CustomEndpointFormProps) {
  const t = useTheme();
  const focusOrder: FocusTarget[] = ['baseURL', 'apiKey'];
  const [focusTarget, setFocusTarget] = useState<FocusTarget>('baseURL');
  const preEditRef = useRef<string>('');
  const prevEditingRef = useRef<string | undefined>(undefined);

  // Save pre-edit value when entering edit mode
  if (editingField && !prevEditingRef.current) {
    preEditRef.current = form[editingField as keyof ConnectionFormState];
  }
  prevEditingRef.current = editingField;

  const isFormReady = (overrideForm?: Partial<ConnectionFormState>) => {
    const f = { ...form, ...overrideForm };
    return (
      (f.baseURL.trim() || provider.defaultBaseURL) &&
      (provider.apiKey === 'optional' || f.apiKey.trim())
    );
  };

  const finishEditing = (editedValue?: string) => {
    const override =
      editedValue !== undefined && editingField ? { [editingField]: editedValue } : undefined;
    if (editedValue !== undefined && editingField) {
      onUpdateField(editingField as keyof ConnectionFormState, editedValue);
    }
    onEditingFieldChange(undefined);
    if (isFormReady(override)) {
      onSubmit();
    }
  };

  useInput((input, key) => {
    // ── Editing mode ──
    if (editingField) {
      if (key.escape) {
        onCancelEdit(editingField, preEditRef.current);
        return;
      }
      if (key.return) {
        const current = form[editingField as keyof ConnectionFormState];
        finishEditing(current);
        return;
      }
      if (key.backspace || key.delete) {
        const current = form[editingField as keyof ConnectionFormState];
        onUpdateField(editingField as keyof ConnectionFormState, current.slice(0, -1));
        return;
      }
      if (key.ctrl && input === 'u') {
        onUpdateField(editingField as keyof ConnectionFormState, '');
        return;
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: filter terminal escape sequences
      if (!input || /[\x00-\x1f\x7f]/.test(input)) return;
      const current = form[editingField as keyof ConnectionFormState];
      onUpdateField(editingField as keyof ConnectionFormState, current + input);
      return;
    }

    // ── Navigation mode ──
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      const idx = focusOrder.indexOf(focusTarget);
      setFocusTarget(focusOrder[Math.max(0, idx - 1)]!);
      return;
    }
    if (key.downArrow) {
      const idx = focusOrder.indexOf(focusTarget);
      setFocusTarget(focusOrder[Math.min(focusOrder.length - 1, idx + 1)]!);
      return;
    }
    if (key.return) {
      onEditingFieldChange(focusTarget === 'baseURL' ? 'baseURL' : 'apiKey');
      return;
    }
  });

  const focusColor = (target: FocusTarget): string =>
    editingField
      ? editingField === target
        ? t.primary
        : t.muted
      : focusTarget === target
        ? t.primary
        : t.muted;

  const focusMarker = (target: FocusTarget): string =>
    editingField
      ? editingField === target
        ? '\u203A'
        : ' '
      : focusTarget === target
        ? '\u203A'
        : ' ';

  return (
    <FirstRunShell
      title="Connect to a custom endpoint"
      step="Setup 2 of 2"
      footer="↑↓ Navigate   Enter Edit/Confirm   Esc Back"
    >
      {error ? (
        <Box>
          <Text color={t.error}>{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={focusColor('baseURL')}>{focusMarker('baseURL')} Base URL</Text>
        </Box>
        <Box paddingLeft={2}>
          {editingField === 'baseURL' ? (
            <Text color={t.muted}>
              {form.baseURL || provider.defaultBaseURL}
              <Text color={t.primary}>█</Text>
            </Text>
          ) : (
            <Text color={t.dim}>{form.baseURL || provider.defaultBaseURL}</Text>
          )}
        </Box>

        <Box marginTop={1}>
          <Text color={focusColor('apiKey')}>{focusMarker('apiKey')} API key</Text>
          <Text color={t.dim}> Optional</Text>
        </Box>
        <Box paddingLeft={2}>
          {editingField === 'apiKey' ? (
            <Text color={t.muted}>
              {form.apiKey ? '*'.repeat(form.apiKey.length) : ''}
              <Text color={t.primary}>█</Text>
            </Text>
          ) : (
            <Text color={t.dim}>{form.apiKey ? '••••••••••••••••••••••' : 'Not set'}</Text>
          )}
        </Box>
      </Box>
    </FirstRunShell>
  );
}
