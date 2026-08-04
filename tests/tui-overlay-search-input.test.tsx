import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import OverlaySearchInput from '../src/app/tui/components/OverlaySearchInput';

function SearchInputHarness({ active }: { active: boolean }) {
  const [value, setValue] = useState('');
  return <OverlaySearchInput value={value} onChange={setValue} active={active} />;
}

describe('OverlaySearchInput', () => {
  test('renders a compact placeholder while inactive', () => {
    const { lastFrame } = render(<SearchInputHarness active={false} />);

    expect(lastFrame()).toContain('搜索: —');
    expect(lastFrame()).not.toContain('❯ 搜索:');
  });

  test('mounts the shared text input only while active', async () => {
    const { lastFrame, stdin } = render(<SearchInputHarness active />);

    expect(lastFrame()).toContain('❯ 搜索:');
    stdin.write('kite');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(lastFrame()).toContain('搜索: kite');
  });
});
