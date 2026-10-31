export interface BrowserDecoration {
  readonly agent: boolean;
  readonly visible: boolean;
  readonly navigation: number;
  readonly cursor: {
    readonly x: number;
    readonly y: number;
    readonly navigation: number;
    readonly phase: 'move' | 'press' | 'type';
  } | null;
}
/** Fixed trusted asset in a separate world of the actual page, never app CSS behind a native view. */
export function paintBrowserDecoration(id: string, value: BrowserDecoration) {
  const previous = document.getElementById(id);
  if (!value.agent || !value.visible) {
    previous?.remove();
    return;
  }
  const host = previous ?? document.createElement('div');
  if (!previous) {
    host.id = id;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
    host.attachShadow({ mode: 'open' });
    document.documentElement.append(host);
  }
  const shadow = host.shadowRoot;
  if (!shadow) return;
  shadow.replaceChildren();
  const glow = document.createElement('div');
  glow.style.cssText =
    'position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 2px #60a5fa88,inset 0 0 24px 3px #3b82f67a;';
  shadow.append(glow);
  const cursor = value.cursor;
  if (
    !cursor ||
    cursor.navigation !== value.navigation ||
    !Number.isFinite(cursor.x) ||
    !Number.isFinite(cursor.y) ||
    cursor.x < 0 ||
    cursor.y < 0 ||
    cursor.x > innerWidth ||
    cursor.y > innerHeight
  )
    return;
  const pointer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pointer.setAttribute('viewBox', '0 0 28 34');
  pointer.setAttribute('width', '28');
  pointer.setAttribute('height', '34');
  pointer.style.cssText = `position:fixed;left:${cursor.x}px;top:${cursor.y}px;pointer-events:none;filter:drop-shadow(0 2px 3px #0005);`;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    cursor.phase === 'type' ? 'M8 3h12M14 3v26M8 29h12' : 'M3 2v26l7-7 5 11 5-2-5-11h10Z',
  );
  path.setAttribute('fill', cursor.phase === 'type' ? 'none' : '#3b82f6');
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', '2');
  pointer.append(path);
  shadow.append(pointer);
}

/** Only closed, finite display data is serialized; no page-provided code enters this expression. */
export function browserDecorationScript(id: string, value: BrowserDecoration) {
  if (!/^kite-control-[a-f0-9-]{36}$/.test(id)) throw Error('invalid_browser_decoration_id');
  return `(${paintBrowserDecoration.toString()})(${JSON.stringify(id)},${JSON.stringify(value)})`;
}
