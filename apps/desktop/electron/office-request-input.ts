import type { OfficeRequestOutcome } from '../src/output-files-bridge';

/** Runs only in a separate trusted, script-free input view, never the Office document. */
function installOfficeRequest(label: string) {
  const input = document.querySelector('textarea')!;
  const status = document.querySelector('[role="status"]')!;
  const send = document.querySelector<HTMLButtonElement>('[data-send]')!;
  const cancel = document.querySelector<HTMLButtonElement>('[data-cancel]')!;
  document.querySelector('[data-location]')!.textContent = label;
  status.textContent = '';
  let composing = false;
  let serial = 0;
  let cancelled = false;
  let locked = false;
  let pending: { serial: number; prompt: string } | undefined;
  const submit = () => {
    if (locked || composing || !input.value.trim() || input.value.length > 16000) return;
    locked = true;
    pending = { serial: ++serial, prompt: input.value };
    input.readOnly = true;
    send.disabled = true;
    status.textContent = '正在发送…';
    cancel.setAttribute('aria-label', '关闭修改请求');
    cancel.title = '关闭输入，不撤销已发送请求';
  };
  input.addEventListener('compositionstart', (e) => {
    if (e.isTrusted) composing = true;
  });
  input.addEventListener('compositionend', (e) => {
    if (e.isTrusted) composing = false;
  });
  input.addEventListener('keyup', (e) => {
    // Some native IMEs expose compositionend as untrusted in an isolated world.
    // A trusted release outside composition closes that keyboard phase instead.
    // Never submit here: the candidate-confirming press has already been ignored.
    if (composing && e.isTrusted && e.target === input && e.isComposing === false)
      composing = false;
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      if (e.key === 'Escape' && !composing && !e.isComposing) {
        e.preventDefault();
        cancelled = true;
      } else if (
        e.target === input &&
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.isComposing &&
        !composing &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        if (!e.repeat) submit();
      }
    },
    true,
  );
  send.addEventListener('click', (e) => {
    if (e.isTrusted) submit();
  });
  cancel.addEventListener('click', (e) => {
    if (e.isTrusted) cancelled = true;
  });
  input.addEventListener('input', () => {
    if (!locked) status.textContent = input.value.length >= 16000 ? '最多 16000 字符' : '';
  });
  (globalThis as unknown as { kiteOfficeRequest: unknown }).kiteOfficeRequest = {
    read: () => ({ cancelled, ...(pending ? { pending } : {}) }),
    settle: (id: number, outcome: OfficeRequestOutcome) => {
      if (!pending || pending.serial !== id) return;
      if (outcome.status === 'accepted') {
        cancelled = true;
        return;
      }
      status.textContent =
        outcome.message ||
        (outcome.status === 'unknown'
          ? '发送结果待核实，请在会话中查看原请求。不会重复发送。'
          : '尚未发送，请检查会话状态后重试。');
      if (outcome.status === 'failed') {
        pending = undefined;
        locked = false;
        input.readOnly = false;
        send.disabled = false;
        cancel.setAttribute('aria-label', '取消修改请求');
        cancel.title = 'Esc 取消';
        input.focus();
      }
    },
  };
  input.focus();
}
export const officeRequestWorld = 1005;
export const officeRequestInstallScript = (label: string) =>
  `(${installOfficeRequest.toString()})(${JSON.stringify(label)})`;
export const officeRequestReadScript = 'globalThis.kiteOfficeRequest?.read()';
export const officeRequestSettleScript = (serial: number, outcome: OfficeRequestOutcome) =>
  `globalThis.kiteOfficeRequest?.settle(${JSON.stringify(serial)},${JSON.stringify(outcome)})`;
/** Small, static mirror of the desktop content tokens for sandboxed Office chrome.
 * NativeTheme.themeSource already drives prefers-color-scheme in every view.
 * Keep the values paired with native-content-theme.css and the shared UI tokens.
 */
export const officeChromeCss = `
.kite-office-chrome {
  color-scheme: light dark;
  --office-background: light-dark(#fafafa, #181818);
  --office-card: light-dark(#fff, #222);
  --office-composer: light-dark(#fff, #262626);
  --office-composer-border: light-dark(rgb(0 0 0 / 10%), #333);
  --office-foreground: light-dark(#222, #ededed);
  --office-muted: light-dark(#666, #c6c6c6);
  --office-border: light-dark(#e7e7e7, #282828);
  --office-primary: light-dark(#252525, #ededed);
  --office-primary-hover: light-dark(#414141, #ccc);
  --office-primary-foreground: light-dark(#fff, #1c1c1c);
  --office-hover: color-mix(in srgb, var(--office-foreground) 5%, transparent);
  --office-selected: color-mix(in srgb, var(--office-foreground) 7%, transparent);
  --office-pressed: color-mix(in srgb, var(--office-foreground) 9%, transparent);
  --office-font: ${
    process.platform === 'win32'
      ? '"Segoe WPC", "Segoe UI", "Microsoft YaHei", sans-serif'
      : process.platform === 'darwin'
        ? '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
        : 'system-ui, "Ubuntu", "Droid Sans", sans-serif'
  };
  font: 13px/1.4 var(--office-font);
  color: var(--office-foreground);
}
@media (prefers-color-scheme: dark) {
  .kite-office-chrome {
    --office-hover: color-mix(in srgb, var(--office-foreground) 7%, transparent);
    --office-selected: color-mix(in srgb, var(--office-foreground) 11%, transparent);
    --office-pressed: color-mix(in srgb, var(--office-foreground) 13%, transparent);
  }
}
`;
export const officeRequestHtml = `<!doctype html><html class="kite-office-chrome"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>
${officeChromeCss}
:root{background:transparent}*{box-sizing:border-box}body{margin:0;padding:5px;background:transparent}
.request{height:184px;padding:12px;border:1px solid var(--office-composer-border);border-radius:16px;background:var(--office-composer);box-shadow:0 1px 6px light-dark(rgb(0 0 0 / 6%),rgb(0 0 0 / 28%));display:flex;flex-direction:column;gap:8px}
.request:focus-within{border-color:color-mix(in srgb,var(--office-foreground) 65%,var(--office-composer));box-shadow:0 0 0 2px color-mix(in srgb,var(--office-foreground) 14%,transparent)}
header{display:flex;align-items:center;gap:8px;min-width:0;font-weight:600}header span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1}
button{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex-shrink:0;min-height:28px;border:0;border-radius:8px;cursor:pointer;color:inherit;background:transparent;padding:4px 8px;font:inherit;font-weight:500;transition:background-color 100ms,color 100ms}
button:hover:not(:disabled){background:var(--office-hover)}button:active:not(:disabled){background:var(--office-pressed)}button:focus-visible{outline:1px solid var(--office-foreground);outline-offset:2px}
[data-cancel]{min-height:24px;width:24px;padding:0;color:var(--office-muted)}[data-cancel]:hover{color:var(--office-foreground)}
textarea{width:100%;flex:1;min-height:50px;resize:none;background:transparent;color:inherit;border:0;outline:none;font:14px/1.5 var(--office-font);padding:0}textarea::placeholder{color:var(--office-muted);opacity:1}
footer{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px;color:var(--office-muted);font-size:11px;line-height:1.4}[role=status]{overflow-wrap:anywhere}footer>span{grid-column:1}[data-send]{grid-column:2;background:var(--office-primary);color:var(--office-primary-foreground);white-space:nowrap;font-size:13px}
[data-send]:hover:not(:disabled){background:var(--office-primary-hover)}[data-send]:active:not(:disabled){background:color-mix(in srgb,var(--office-primary) 80%,var(--office-composer))}button:disabled{opacity:.5;cursor:default}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body><section class="request" aria-label="请求 Agent 修改"><header><span data-location></span><button data-cancel aria-label="取消修改请求" title="Esc 取消"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button></header><textarea maxlength="16000" aria-label="修改要求" title="Enter 发送，Shift+Enter 换行，Esc 关闭" placeholder="输入修改要求…" spellcheck="false"></textarea><footer><span role="status"></span><button data-send>发送 ↵</button></footer></section></body></html>`;
