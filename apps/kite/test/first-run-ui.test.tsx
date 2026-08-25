import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { ApiKeyForm } from '../src/tui/components/first-run/ApiKeyForm';
import { CustomEndpointForm } from '../src/tui/components/first-run/CustomEndpointForm';
import ErrorScreen from '../src/tui/components/first-run/ErrorScreen';
import ProviderScreen from '../src/tui/components/first-run/ProviderScreen';
import { type ConnectionFormState, PROVIDERS } from '../src/tui/components/first-run/types';

const customProvider = PROVIDERS.find((provider) => provider.type === 'openai-compatible')!;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function ProviderHarness({ onConfirm }: { onConfirm: (label: string) => void }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  return (
    <ProviderScreen
      selectedIndex={selectedIndex}
      onSelect={setSelectedIndex}
      onConfirm={(provider) => onConfirm(provider.label)}
    />
  );
}

function ApiKeyHarness({
  onSubmit,
  onBack,
}: {
  onSubmit: (value: string) => void;
  onBack: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  return (
    <ApiKeyForm
      providerLabel="DeepSeek"
      apiKey={apiKey}
      error="API key cannot be empty"
      onUpdate={setApiKey}
      onSubmit={onSubmit}
      onBack={onBack}
    />
  );
}

function CustomEndpointHarness() {
  const [form, setForm] = useState<ConnectionFormState>({
    baseURL: customProvider.defaultBaseURL,
    apiKey: '',
  });
  const [editingField, setEditingField] = useState<string | undefined>();
  const [submitted, setSubmitted] = useState(false);
  const [wentBack, setWentBack] = useState(false);
  return (
    <>
      <CustomEndpointForm
        provider={customProvider}
        form={form}
        editingField={editingField}
        onEditingFieldChange={setEditingField}
        onCancelEdit={(field: string, restoreValue: string) => {
          setForm((current) => ({ ...current, [field]: restoreValue }));
          setEditingField(undefined);
        }}
        onSubmit={() => setSubmitted(true)}
        onBack={() => setWentBack(true)}
        onUpdateField={(field: keyof ConnectionFormState, value: string) =>
          setForm((current) => ({ ...current, [field]: value }))
        }
      />
      {submitted ? 'Submitted' : null}
      {wentBack ? 'Went back' : null}
    </>
  );
}

function ErrorHarness({
  onConfirmAction,
  onBack,
}: {
  onConfirmAction: (index: number) => void;
  onBack: () => void;
}) {
  const [selectedAction, setSelectedAction] = useState(0);
  return (
    <ErrorScreen
      provider={customProvider}
      error={{ kind: 'incompatible', message: 'bad model list' }}
      selectedAction={selectedAction}
      onSelectAction={setSelectedAction}
      onConfirmAction={onConfirmAction}
      onBack={onBack}
    />
  );
}

describe('first-run UI components', () => {
  test('provider selection renders, navigates, and confirms without a PTY process', async () => {
    let confirmed = '';
    const { lastFrame, stdin } = render(
      <ProviderHarness onConfirm={(label) => (confirmed = label)} />,
    );
    expect(lastFrame()).toContain('Choose a model provider');
    expect(lastFrame()).toContain('› DeepSeek');
    expect(lastFrame()).toContain('OpenAI');
    expect(lastFrame()).toContain('Custom endpoint');

    stdin.write('\u001b[B');
    await settle();
    expect(lastFrame()).toContain('› OpenAI');

    stdin.write('\r');
    await settle();
    expect(confirmed).toBe('OpenAI');
  });

  test('API-key form masks input, submits the actual value, and handles Escape', async () => {
    let submitted = '';
    const { lastFrame, stdin } = render(
      <ApiKeyHarness onSubmit={(value) => (submitted = value)} onBack={() => {}} />,
    );
    expect(lastFrame()).toContain('Connect to DeepSeek');
    expect(lastFrame()).toContain('API key cannot be empty');

    stdin.write('sk-test');
    await settle();
    expect(lastFrame()).toContain('*******');
    expect(lastFrame()).not.toContain('sk-test');

    stdin.write('\r');
    await settle();
    expect(submitted).toBe('sk-test');

    let wentBack = false;
    const escapeView = render(
      <ApiKeyHarness onSubmit={() => {}} onBack={() => (wentBack = true)} />,
    );
    escapeView.stdin.write('\u001b');
    await settle();
    expect(wentBack).toBe(true);
  });

  test('custom-endpoint editing restores cancelled input and exposes the optional API key', async () => {
    const { lastFrame, stdin } = render(<CustomEndpointHarness />);
    expect(lastFrame()).toContain('Base URL');
    expect(lastFrame()).toContain('API key');
    expect(lastFrame()).toContain('Optional');
    expect(lastFrame()).toContain(customProvider.defaultBaseURL);

    stdin.write('\r');
    await settle();
    stdin.write('x');
    await settle();
    expect(lastFrame()).toContain(`${customProvider.defaultBaseURL}x`);

    stdin.write('\u001b');
    await settle();
    expect(lastFrame()).toContain(customProvider.defaultBaseURL);
    expect(lastFrame()).not.toContain(`${customProvider.defaultBaseURL}x`);

    stdin.write('\u001b[B');
    await settle();
    stdin.write('\r');
    await settle();
    stdin.write('k');
    await settle();
    expect(lastFrame()).toContain('*');
  });

  test('incompatible-endpoint error actions navigate, confirm, and return', async () => {
    let confirmedAction: number | undefined;
    const { lastFrame, stdin } = render(
      <ErrorHarness onConfirmAction={(index) => (confirmedAction = index)} onBack={() => {}} />,
    );
    expect(lastFrame()).toContain('The endpoint is reachable');
    expect(lastFrame()).toContain('Enter a model name');
    expect(lastFrame()).toContain('Choose another provider');

    stdin.write('\u001b[B');
    await settle();
    stdin.write('\u001b[B');
    await settle();
    expect(lastFrame()).toContain('› Choose another provider');

    stdin.write('\r');
    await settle();
    expect(confirmedAction).toBe(2);

    let wentBack = false;
    const escapeView = render(
      <ErrorHarness onConfirmAction={() => {}} onBack={() => (wentBack = true)} />,
    );
    escapeView.stdin.write('\u001b');
    await settle();
    expect(wentBack).toBe(true);
  });
});
