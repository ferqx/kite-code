/** Isolated real Service test. Programmatic contract mode is not CUA/keyboard acceptance. */
import type { OutputFileSummary, OutputFileTarget } from '@kite-ai/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeDraft, NativeState } from '../src/native-bridge';
import { submitOfficeRequest } from '../src/native-office-request-submit';
import { useNativeOutputFiles } from '../src/native-output-files';
import type { OfficeEditContext, OfficeRequestOutcome } from '../src/output-files-bridge';

const bridge = (window as unknown as { kiteNative: NativeBridge }).kiteNative;
const info = (globalThis as typeof globalThis & { officeFixtureInfo: unknown })
  .officeFixtureInfo as {
  target: OutputFileTarget;
  sessionId: string;
  sourceSha: string;
  keyboardOnly: boolean;
};
const testGlobal = globalThis as typeof globalThis & {
  fixtureOfficeContract?: () => Promise<unknown>;
  fixtureOfficeEvidence?: () => unknown;
};
const ordinary = '普通聊天草稿保留：这不是办公修改请求。';
async function until(read: () => Promise<NativeState>, ready: (s: NativeState) => boolean) {
  const end = Date.now() + 30000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > end) throw Error('fixture_state_timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}
function Fixture() {
  const [state, setState] = useState<NativeState>(),
    current = useRef<NativeState | undefined>(undefined);
  const [status, setStatus] = useState('连接隔离真实 Service…'),
    [draft, setDraft] = useState(''),
    [sent, setSent] = useState(0);
  const usedContract = useRef(false);
  const evidence = useRef<unknown[]>([]);
  const send = useCallback(async function send(
    file: OutputFileSummary,
    context: OfficeEditContext,
    prompt: string,
  ): Promise<OfficeRequestOutcome> {
    const frozen = current.current;
    if (!frozen?.selection) return { status: 'failed', message: '会话不可用' };
    const before = (await bridge.request({
      method: 'draft.read',
      generation: frozen.generation,
      sessionId: info.sessionId,
    })) as NativeDraft;
    evidence.current.push({
      phase: 'onRequestEdit',
      time: new Date().toISOString(),
      prompt,
      context,
      file,
      draftBefore: before,
    });
    setStatus('正在通过生产 Main IPC 向真实 Service 提交…');
    setSent((n) => n + 1);
    const outcome = await submitOfficeRequest({
      bridge,
      generation: frozen.generation,
      selection: frozen.selection,
      file,
      context,
      prompt,
      modelReady: true,
      modelChoice: { modelId: 'local' },
      isCurrent: () =>
        current.current?.generation === frozen.generation &&
        current.current.selection?.session.id === frozen.selection?.session.id,
    });
    const saved = (await bridge.request({
      method: 'draft.read',
      generation: frozen.generation,
      sessionId: info.sessionId,
    })) as NativeDraft;
    evidence.current.push({
      phase: 'outcome',
      time: new Date().toISOString(),
      outcome,
      draftAfter: saved,
      draftPreserved: JSON.stringify(before) === JSON.stringify(saved),
    });
    setDraft(saved.content);
    setStatus(`真实 Service 提交结果：${outcome.status}`);
    return outcome;
  }, []);
  const outputFiles = useNativeOutputFiles({
    bridge,
    generation: state?.generation ?? 0,
    storeId: state?.selection?.storeId,
    sessionId: state?.selection?.session.id,
    revision: state?.outputFilesRevision ?? state?.historyEpoch ?? 0,
    onEdit: async () => {
      setStatus('只读引用路径被触发，未发送。');
    },
    onRequestEdit: send,
    turnLabel: (runId) => `执行 ${runId.slice(0, 8)}`,
  });
  useEffect(() => {
    if (outputFiles.request)
      evidence.current.push({
        phase: 'production-card-open',
        time: new Date().toISOString(),
        request: outputFiles.request,
      });
  }, [outputFiles.request]);
  useEffect(() => {
    let disposed = false,
      stop: undefined | (() => void);
    void (async () => {
      const attached = (await bridge.request({ method: 'attach' })) as NativeState;
      const read = () =>
        bridge.request({
          method: 'state',
          generation: attached.generation,
        }) as Promise<NativeState>;
      await until(read, (s) => (s.environmentRevision ?? 0) > 0);
      await bridge.request({
        method: 'select',
        generation: attached.generation,
        sessionId: info.sessionId,
      });
      const ready = await until(
        read,
        (s) => s.selection?.session.id === info.sessionId && s.selection.viewLoading === false,
      );
      const readDraft = () =>
        bridge.request({
          method: 'draft.read',
          generation: ready.generation,
          sessionId: info.sessionId,
        }) as Promise<NativeDraft>;
      const existing = await readDraft();
      if (!existing.content)
        await bridge.request({
          method: 'draft.write',
          generation: ready.generation,
          sessionId: info.sessionId,
          revision: Number(existing.revision),
          content: ordinary,
        });
      setDraft((await readDraft()).content);
      current.current = ready;
      setState(ready);
      setStatus('真实 Service 已连接；仅本机受控 Provider');
      stop = bridge.watch(() => {
        void read().then((s) => {
          if (!disposed) {
            current.current = s;
            setState(s);
          }
        });
      });
      testGlobal.fixtureOfficeEvidence = () => structuredClone(evidence.current);
      // Keyboard-only builds expose evidence reads, never a programmatic dispatch API.
      if (!info.keyboardOnly)
        testGlobal.fixtureOfficeContract = async () => {
          if (usedContract.current) throw Error('contract_already_dispatched');
          usedContract.current = true;
          const fileReply = await bridge.request({
            method: 'outputs.info',
            generation: ready.generation,
            target: info.target,
          });
          if (
            !fileReply ||
            !('kind' in fileReply) ||
            fileReply.kind !== 'outputs.info' ||
            !('file' in fileReply)
          )
            throw Error('fixture_file_unavailable');
          const before = await readDraft();
          const context: OfficeEditContext = {
            sourceHash: info.sourceSha,
            selection: {
              kind: 'powerpoint',
              slide: 1,
              objectPath: '/slide[1]/shape[@id=100000]',
              text: 'Windows 办公文件预览\n',
            },
          };
          const prompt = '请将选中标题精简为 Windows 预览，并保留原件。';
          const result = await send(fileReply.file, context, prompt);
          const after = await readDraft();
          return {
            evidenceKind: 'programmatic-contract-not-keyboard',
            prompt,
            context,
            result,
            draftBefore: before,
            draftAfter: after,
            draftPreserved: JSON.stringify(before) === JSON.stringify(after),
          };
        };
    })().catch((e) => setStatus(String(e)));
    return () => {
      disposed = true;
      stop?.();
      delete testGlobal.fixtureOfficeContract;
      delete testGlobal.fixtureOfficeEvidence;
    };
  }, [send]);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '10px 16px',
          background: '#e9eef7',
          color: '#17263d',
          borderBottom: '1px solid #cbd4e2',
        }}
      >
        <strong>{info.keyboardOnly ? 'Windows 实际交互验证' : 'Windows 程序集成验证'}</strong> ·
        隔离 Service / 本机固定 Provider（非远端模型、非安装版
        {info.keyboardOnly ? '' : '、非键盘验收'}）
        <div role="status">
          {status} · 已调用发送 {sent} 次
        </div>
        <div>普通聊天草稿：{draft}</div>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside
          aria-label="真实会话产物"
          style={{
            width: 270,
            flexShrink: 0,
            overflow: 'auto',
            padding: 12,
            borderRight: '1px solid var(--border)',
          }}
        >
          <strong>会话产物</strong>
          {state?.selection?.runs.map((run) => (
            <section key={run.id} data-run-id={run.id} style={{ marginBlock: 12 }}>
              <small>{run.status}</small>
              {outputFiles.renderTurnOutputs({
                turnId: JSON.stringify([
                  'native-run',
                  state.selection!.storeId,
                  state.selection!.session.id,
                  run.id,
                ]),
              })}
            </section>
          ))}
        </aside>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}>
          {state?.selection &&
            outputFiles.renderFile({ target: outputFiles.request?.target ?? info.target })}
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
