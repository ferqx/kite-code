import { createRoot } from 'react-dom/client';
import { NativeGlobalDialog } from './native-global-dialog';
import { installNativeInputModality } from './native-input-modality';
import './native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';
import './native-global-dialog.css';

installNativeInputModality(document);
createRoot(document.getElementById('root')!).render(
  <NativeGlobalDialog bridge={window.kiteGlobalDialog} />,
);
