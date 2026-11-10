import { createRoot } from 'react-dom/client';
import { OfflineTrajectoryViewer } from './native-trajectory-offline';
import './native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const root = document.getElementById('root');
if (!root) throw Error('trajectory_viewer_root_missing');
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light';
const files = window.kiteNative?.trajectoryFiles;
createRoot(root).render(
  files ? (
    <OfflineTrajectoryViewer files={files} />
  ) : (
    <main className="kite-client trajectory-offline-window">
      <h1>离线执行轨迹</h1>
      <p role="alert">本地轨迹文件读取不可用，请核对客户端资源。</p>
    </main>
  ),
);
