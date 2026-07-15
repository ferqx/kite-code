import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { McpServerConfigInput, McpWritableScope } from '@/core/config';
import { validateMcpServerName } from '@/core/config';
import { useTheme } from '../theme';
import type { McpController } from './types';

type WizardStep =
  | 'name'
  | 'transport'
  | 'endpoint'
  | 'args'
  | 'cwd'
  | 'auth'
  | 'environment'
  | 'scope'
  | 'timeout'
  | 'preview'
  | 'saving';

interface WizardDraft {
  name: string;
  transport: 'stdio' | 'http';
  endpoint: string;
  args: string[];
  cwd?: string;
  environment: Record<string, string>;
  scope: McpWritableScope;
  timeout?: number;
  authMode: 'none' | 'environment';
}

const INITIAL_DRAFT: WizardDraft = {
  name: '',
  transport: 'stdio',
  endpoint: '',
  args: [],
  environment: {},
  scope: 'local',
  authMode: 'none',
};

export default function McpAddWizard({
  controller,
  onDone,
  onCancel,
}: {
  controller: McpController;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [step, setStep] = useState<WizardStep>('name');
  const [draft, setDraft] = useState<WizardDraft>(INITIAL_DRAFT);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();

  useInput((value, key) => {
    if (step === 'saving') return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (step === 'preview') {
      if (key.return || value.toLowerCase() === 'y') void save();
      return;
    }
    if (key.return) {
      advance();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && value) setInput((current) => current + value);
  });

  function advance(): void {
    try {
      setError(undefined);
      switch (step) {
        case 'name':
          validateMcpServerName(input);
          setDraft((current) => ({ ...current, name: input }));
          move('transport');
          return;
        case 'transport': {
          const transport = /^h(?:ttp)?$/i.test(input) ? 'http' : 'stdio';
          setDraft((current) => ({ ...current, transport }));
          move('endpoint');
          return;
        }
        case 'endpoint':
          if (!input.trim()) throw new Error('A command or URL is required.');
          if (draft.transport === 'http') {
            const endpoint = new URL(input.trim());
            if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
              throw new Error('HTTP transport requires an http:// or https:// URL.');
            }
          }
          setDraft((current) => ({ ...current, endpoint: input.trim() }));
          move(draft.transport === 'stdio' ? 'args' : 'auth');
          return;
        case 'args':
          setDraft((current) => ({ ...current, args: parseArguments(input) }));
          move('cwd');
          return;
        case 'cwd':
          setDraft((current) => ({ ...current, cwd: input.trim() || undefined }));
          move('environment');
          return;
        case 'auth': {
          const authMode = /^e(?:nvironment)?$/i.test(input) ? 'environment' : 'none';
          setDraft((current) => ({ ...current, authMode }));
          move(authMode === 'environment' ? 'environment' : 'scope');
          return;
        }
        case 'environment':
          setDraft((current) => ({
            ...current,
            environment: parseEnvironment(input, current.transport === 'http'),
          }));
          move('scope');
          return;
        case 'scope': {
          const scope = parseScope(input);
          setDraft((current) => ({ ...current, scope }));
          move('timeout');
          return;
        }
        case 'timeout': {
          const timeout = input.trim() ? Number(input) : undefined;
          if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
            throw new Error('Timeout must be a positive number of milliseconds.');
          }
          setDraft((current) => ({ ...current, timeout }));
          move('preview');
          return;
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid value.');
    }
  }

  function move(next: WizardStep): void {
    setInput('');
    setStep(next);
  }

  async function save(): Promise<void> {
    setStep('saving');
    const config = buildConfig(draft);
    if (await controller.add(draft.scope, draft.name, config)) onDone(draft.name);
    else setStep('preview');
  }

  return (
    <Box flexDirection="column">
      <Text bold>Add non-OAuth MCP server</Text>
      <Text color={t.dim}>Step: {step}</Text>
      {step === 'preview' || step === 'saving' ? (
        <Preview draft={draft} saving={step === 'saving'} />
      ) : (
        <>
          <Text>{promptFor(step, draft.transport)}</Text>
          <Text color={t.primary}>› {input || ' '}</Text>
        </>
      )}
      {error && <Text color={t.error}>{error}</Text>}
      <Text color={t.dim}>Esc cancel{step === 'preview' ? '  Enter/y save' : '  Enter next'}</Text>
    </Box>
  );
}

function Preview({ draft, saving }: { draft: WizardDraft; saving: boolean }) {
  return (
    <Box flexDirection="column">
      <Text>Name: {draft.name}</Text>
      <Text>Transport: {draft.transport}</Text>
      <Text>
        {draft.transport === 'http' ? 'URL' : 'Command'}: {safeEndpoint(draft)}
      </Text>
      {draft.transport === 'stdio' && <Text>Arguments: {draft.args.length}</Text>}
      {draft.cwd && <Text>Cwd: {draft.cwd}</Text>}
      <Text>Scope: {draft.scope}</Text>
      <Text>Environment/header keys: {Object.keys(draft.environment).join(', ') || 'none'}</Text>
      <Text>Timeout: {draft.timeout ?? 'default'}</Text>
      <Text>
        {draft.scope === 'project'
          ? 'Project save will require separate approval.'
          : 'Ready to save.'}
      </Text>
      {saving && <Text>Saving…</Text>}
    </Box>
  );
}

function promptFor(step: WizardStep, transport: 'stdio' | 'http'): string {
  switch (step) {
    case 'name':
      return 'Server name';
    case 'transport':
      return 'Transport: stdio or http (default stdio)';
    case 'endpoint':
      return transport === 'http' ? 'HTTP URL' : 'Command';
    case 'args':
      return 'Arguments: JSON array or whitespace-separated (optional)';
    case 'cwd':
      return 'Working directory (optional; Windows paths supported)';
    case 'auth':
      return 'Auth: none or environment reference (n/e)';
    case 'environment':
      return transport === 'http'
        ? 'Header environment references: Header=$' + '{VAR},… (optional)'
        : 'Environment: KEY=value or KEY=$' + '{VAR},… (optional)';
    case 'scope':
      return 'Scope: local, project, or user (l/p/u; default local)';
    case 'timeout':
      return 'Timeout milliseconds (optional)';
    default:
      return '';
  }
}

function parseArguments(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('Arguments JSON must be an array of strings.');
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

function parseEnvironment(value: string, referencesOnly: boolean): Record<string, string> {
  const output: Record<string, string> = {};
  if (!value.trim()) return output;
  for (const item of value.split(',')) {
    const separator = item.indexOf('=');
    if (separator <= 0) throw new Error('Environment entries must use KEY=value.');
    const key = item.slice(0, separator).trim();
    const entryValue = item.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) || !entryValue) {
      throw new Error('Environment/header keys and values must be non-empty.');
    }
    if (referencesOnly && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(entryValue)) {
      throw new Error('HTTP header values must contain an environment reference.');
    }
    output[key] = entryValue;
  }
  return output;
}

function parseScope(value: string): McpWritableScope {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'p' || normalized === 'project') return 'project';
  if (normalized === 'u' || normalized === 'user') return 'user';
  return 'local';
}

function buildConfig(draft: WizardDraft): McpServerConfigInput {
  const common = {
    type: draft.transport,
    ...(draft.timeout ? { timeout: draft.timeout } : {}),
  } as const;
  if (draft.transport === 'http') {
    return {
      ...common,
      url: draft.endpoint,
      ...(Object.keys(draft.environment).length > 0 ? { headers: draft.environment } : {}),
    };
  }
  return {
    ...common,
    command: draft.endpoint,
    ...(draft.args.length > 0 ? { args: draft.args } : {}),
    ...(draft.cwd ? { cwd: draft.cwd } : {}),
    ...(Object.keys(draft.environment).length > 0 ? { env: draft.environment } : {}),
  };
}

function safeEndpoint(draft: WizardDraft): string {
  if (draft.transport === 'stdio') return draft.endpoint;
  try {
    return new URL(draft.endpoint).origin;
  } catch {
    return '(invalid URL)';
  }
}
