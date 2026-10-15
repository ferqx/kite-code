import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { TuiFooter, TuiHeader, TuiOverlayFrame, truncateDisplayWidth } from '../../src/tui/chrome';
import { TuiText as Text } from '../../src/tui/presentation';

test('pure chrome retains observed facts, original interaction content and complete narrow graphemes', () => {
  const header = render(
    <TuiHeader
      modelName="actual-model"
      effort="high"
      workspacePath="/owned/workspace"
      columns={60}
    />,
  );
  expect(header.lastFrame()).toContain('Kite Code');
  expect(header.lastFrame()).toContain('actual-model high');
  expect(header.lastFrame()).toContain('/owned/workspace');
  header.unmount();
  const unknownWidth = render(
    <TuiHeader columns={0} modelName="actual-model" workspacePath="/owned/workspace" />,
  );
  expect(unknownWidth.lastFrame()).toContain('actual-model');
  expect(unknownWidth.lastFrame()).toContain('/owned/workspace');
  unknownWidth.unmount();
  const footer = render(
    <TuiFooter activity="Cancelling" permissionMode="auto">
      <Text>❯ original draft</Text>
    </TuiFooter>,
  );
  expect(footer.lastFrame()).toContain('Cancelling');
  expect(footer.lastFrame()).toContain('original draft');
  expect(footer.lastFrame()).toContain('[Automatic review]');
  expect(footer.lastFrame()).not.toContain('seconds');
  footer.unmount();
  const overlay = render(
    <TuiOverlayFrame title={<Text>Original approval</Text>}>
      <Text>unknown remains unknown</Text>
    </TuiOverlayFrame>,
  );
  expect(overlay.lastFrame()).toContain('Original approval');
  expect(overlay.lastFrame()).toContain('unknown remains unknown');
  overlay.unmount();
  const narrow = truncateDisplayWidth('中文👩‍💻é/path/终点', 10);
  expect(stringWidth(narrow)).toBeLessThanOrEqual(10);
  expect(narrow).not.toContain('\u200d…');
  expect(truncateDisplayWidth('abc', 0)).toBe('');
  expect(truncateDisplayWidth('abc', 1)).toBe('…');
  expect(truncateDisplayWidth('safe\u001b[2J', 30)).toBe('safe\\u001b[2J');
});

test('footer displays current Context estimate independently from cumulative recorded usage', () => {
  const context = {
    source: 'model_input' as const,
    storeId: 'store',
    sessionId: 'session',
    runId: 'run',
    executionId: 'model',
    modelId: 'actual',
    bodyHash: 'a'.repeat(64),
    estimate: {
      systemTokens: 10,
      transcriptTokens: 30,
      toolSchemaTokens: 10,
      framingTokens: 10,
      totalInputTokens: 60,
    },
    providerSafetyMarginTokens: 1024,
    usableInputTokens: 6000,
    utilization: 0.01,
  };
  const footer = render(
    <TuiFooter
      modelName="actual"
      context={context}
      usage={{ inputTokens: 99999, executionCount: 5 }}
    />,
  );
  try {
    expect(footer.lastFrame()).toContain('1% context');
    expect(footer.lastFrame()).not.toContain('100.0k');
  } finally {
    footer.unmount();
  }
  const unknown = render(
    <TuiFooter
      modelName="actual"
      context={{ ...context, utilization: undefined, usableInputTokens: undefined }}
    />,
  );
  try {
    expect(unknown.lastFrame()).toContain('60 context est.');
    expect(unknown.lastFrame()).not.toContain('% context');
  } finally {
    unknown.unmount();
  }
});
