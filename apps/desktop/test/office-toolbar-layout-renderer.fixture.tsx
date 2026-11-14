/** Production toolbar components; synthetic document state only, no Service or model requests. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeExcelReadonlyBar, NativeOfficeToolbar } from '../src/native-office-toolbar';
import '../../../packages/ui/src/desktop/style.css';

const kind = new URLSearchParams(location.search).get('kind') ?? 'docx';
function Fixture() {
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [presentation, setPresentation] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const record = (event: string) => setEvents((old) => [...old, event]);
  return (
    <div className="kite-client">
      <section className="native-file-preview" style={{ width: '100%', minHeight: 400 }}>
        <NativeOfficeToolbar
          name={`非常长的办公文件名称用于确保工具条不会因标题而挤出窗口.${kind}`}
          source="来源：布局测试"
          powerpoint={kind === 'pptx'}
          ready
          zoom={zoom}
          presentation={presentation}
          onZoom={(value) => {
            setZoom(value);
            record(`zoom:${value}`);
          }}
          onPresentation={() => {
            setPresentation(!presentation);
            record('presentation');
          }}
          onEdit={() => record('edit')}
          onSave={() => record('save')}
        />
        {kind === 'xlsx' && (
          <NativeExcelReadonlyBar
            ready
            selection={{
              kind: 'excel',
              sheet: '预算',
              range: 'AA10000:AZ10099',
              cells: [
                {
                  path: '/预算/AA10000',
                  address: 'AA10000',
                  value: '长内容 '.repeat(30),
                  formula: 'SUM(A1:A10)',
                },
              ],
            }}
            view={{ selectionSerial: 1, activeAddress: 'AA10000' }}
            onLocate={() => record('locate')}
          />
        )}
        {kind === 'pptx' && (
          <details className="native-office-notes">
            <summary>演讲者备注</summary>
            <p>只读备注内容</p>
          </details>
        )}
        <div
          data-fixture-document
          style={{ padding: 16, minHeight: 240, color: 'var(--muted-foreground)' }}
        >
          工具栏布局回归 · {kind.toUpperCase()}
        </div>
      </section>
      <output hidden id="events">
        {JSON.stringify(events)}
      </output>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
