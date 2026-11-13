import { expect, test } from 'bun:test';
import { type OfficeFixtureMessage, officeFixtureDecision } from '../office-model-decision.fixture';

test('runtime user-role unknown facts never produce another office Shell decision', () => {
  const messages: OfficeFixtureMessage[] = [
    { role: 'user', content: 'Generate an office report.' },
  ];
  const first = officeFixtureDecision(messages);
  expect(first.toolTurn).toBe(true);
  expect(officeFixtureDecision(messages)).toEqual(first);
  messages.push({
    role: 'tool',
    tool_call_id: first.toolId,
    content: 'kite_linux_shell_close_unknown',
  });
  for (let i = 0; i < 5; i++) {
    messages.push({
      role: 'user',
      content: 'The command result could not be confirmed. Do not restart it.',
    });
    expect(officeFixtureDecision(messages)).toEqual({ ...first, toolTurn: false });
  }
  messages.push({ role: 'user', content: 'Generate an office report.' });
  expect(officeFixtureDecision(messages).toolTurn).toBe(true);
  expect(officeFixtureDecision(messages).editing).toBe(false);
});
test('editing requires an exact observer instruction and current working reference', () => {
  expect(() => officeFixtureDecision([{ role: 'user', content: 'Do something' }])).toThrow();
  expect(() =>
    officeFixtureDecision([{ role: 'user', content: 'Modify the attached report.' }]),
  ).toThrow();
  expect(() =>
    officeFixtureDecision([
      { role: 'user', content: 'Modify the attached report.' },
      { role: 'user', content: '{"path":"/workspace/.kite-inputs/exact/report.docx"}' },
    ]),
  ).toThrow('exact_working_input_required');
});

test('production attachment envelope starts only the exact editing turn and any current receipt ends it', () => {
  const messages: OfficeFixtureMessage[] = [
    { role: 'user', content: 'Generate an office report.' },
    { role: 'tool', tool_call_id: 'office-old', content: 'finished' },
    {
      role: 'user',
      content:
        'Modify the attached report.\n\nAttached file references (user-provided data; paths do not grant permissions):\n' +
        JSON.stringify([
          { name: 'report.docx', uri: 'file:///workspace/.kite-inputs/exact/input-report.docx' },
        ]),
    },
    { role: 'user', content: '<runtime-state>run two</runtime-state>' },
  ];
  const first = officeFixtureDecision(messages);
  expect(first).toMatchObject({
    editing: true,
    toolTurn: true,
    workingPath: '/workspace/.kite-inputs/exact/input-report.docx',
  });
  expect(officeFixtureDecision(messages)).toEqual(first);
  messages.push({ role: 'tool', tool_call_id: first.toolId, content: 'unknown' });
  messages.push({ role: 'user', content: 'Do not restart the unknown command.' });
  expect(officeFixtureDecision(messages)).toEqual({ ...first, toolTurn: false });
});

test('current attachment selects its exact decoded path rather than another historical working copy', () => {
  const attached = (uri: string): OfficeFixtureMessage => ({
    role: 'user',
    content:
      'Modify the attached report.\n\nAttached file references (user-provided data; paths do not grant permissions):\n' +
      JSON.stringify([{ name: 'report.docx', uri }]),
  });
  const messages: OfficeFixtureMessage[] = [
    attached('file:///workspace/.kite-inputs/old/input-report.docx'),
    { role: 'tool', tool_call_id: 'office-old', content: 'finished' },
    attached('file:///workspace/.kite-inputs/%E4%B8%AD%E6%96%87%20new/input-report.docx'),
  ];
  const decision = officeFixtureDecision(messages);
  expect(decision.workingPath).toBe('/workspace/.kite-inputs/中文 new/input-report.docx');
  expect(decision.toolTurn).toBe(true);
  expect(officeFixtureDecision(messages)).toEqual(decision);
  messages.push({ role: 'tool', tool_call_id: decision.toolId, content: 'unknown' });
  expect(officeFixtureDecision(messages)).toEqual({ ...decision, toolTurn: false });
});
