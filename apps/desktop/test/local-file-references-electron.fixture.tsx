// Standalone test artifact, never imported by a product entrypoint.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../packages/ui/src/desktop/Composer';
import { nativeInputFileIntent } from '../src/native-input-file-intent';
import { useNativeInputImages } from '../src/native-input-images';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

function Fixture() {
  const [generation, setGeneration] = useState(1);
  const [local, setLocal] = useState(true);
  const [draft, setDraft] = useState('');
  const files = useNativeInputImages(window.kiteNative, generation, 'isolated-fixture', local);
  return (
    <main className="kite-client" style={{ padding: 24 }}>
      <button type="button" onClick={() => setGeneration(generation + 1)}>
        Reconnect
      </button>
      <button type="button" onClick={() => setLocal(!local)}>
        Toggle local
      </button>
      <button
        type="button"
        onClick={async () =>
          files.addFiles(
            's',
            await files.fileReferences([
              new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' }),
            ]),
          )
        }
      >
        Synthetic
      </button>
      <Composer
        scopeKey="s"
        draft={draft}
        onChange={setDraft}
        disabled={false}
        active={false}
        stopping={false}
        files={files.files('s')}
        images={files.get('s')}
        onFileReferences={(selected, signal) => files.fileReferences(selected, signal)}
        onFilesSelected={(selected) => files.addFiles('s', selected)}
        onRemoveFile={(id) => files.removeIds([id])}
        onRemoveImage={(id) => files.removeIds([id])}
        onImageFiles={(selected) => files.add('s', selected)}
      />
      <pre id="result">
        {JSON.stringify({
          generation,
          local,
          files: files.files('s'),
          intent: nativeInputFileIntent(files.files('s')),
        })}
      </pre>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
