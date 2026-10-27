import { Box, type DOMElement, measureElement, useInput } from 'ink';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TuiText as Text, useTuiPresentation } from './presentation';

/** Keep a complete read-only panel in its terminal budget without losing its content. */
export function TuiPanelViewport({
  children,
  rows,
  identity,
}: {
  children: ReactNode;
  rows: number;
  identity: string;
}) {
  const { t } = useTuiPresentation();
  const content = useRef<DOMElement>(null);
  const [offset, setOffset] = useState(0);
  const [height, setHeight] = useState(0);
  const page = Math.max(1, rows - 1);
  const last = Math.max(0, height - page);
  useEffect(() => {
    void identity;
    setOffset(0);
  }, [identity]);
  useLayoutEffect(() => {
    if (content.current) {
      const measured = measureElement(content.current).height;
      setHeight((current) => (current === measured ? current : measured));
    }
  });
  useEffect(() => setOffset((current) => Math.min(current, last)), [last]);
  useInput((_input, key) => {
    if (key.pageDown) setOffset((current) => Math.min(last, current + page));
    else if (key.pageUp) setOffset((current) => Math.max(0, current - page));
  });
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        height={Math.min(page, height || page)}
        overflowY="hidden"
        flexDirection="column"
        flexShrink={0}
      >
        <Box ref={content} flexDirection="column" flexShrink={0} marginTop={-offset}>
          {children}
        </Box>
      </Box>
      {height > page && (
        <Text dimColor>
          {t('PgUp / PgDn: read complete panel')} · {Math.min(offset + 1, height)}–
          {Math.min(offset + page, height)}/{height}
        </Text>
      )}
    </Box>
  );
}
