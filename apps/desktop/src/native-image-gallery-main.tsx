import { createRoot } from 'react-dom/client';
import { NativeImageGalleryViewer } from './native-image-gallery-viewer';
import { installNativeInputModality } from './native-input-modality';
import './native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';
import './native-global-dialog.css';

installNativeInputModality(document);
createRoot(document.getElementById('root')!).render(
  <NativeImageGalleryViewer bridge={window.kiteImageGalleryViewer} />,
);
