import { BrowserAnnotationIcon, Button } from '@kite-ai/ui/desktop';
import type { NativeBrowserLoadFailure } from './native-browser-bridge';

const advice: Record<NativeBrowserLoadFailure['kind'], readonly string[]> = {
  dns: ['检查网址拼写是否正确', '检查网络连接和 DNS 配置'],
  connection: ['检查网络连接', '检查代理、防火墙配置，或稍后再试'],
  timeout: ['检查网络连接', '网站响应较慢，请稍后再试'],
  offline: ['确认设备已连接到网络', '恢复连接后重新加载'],
  certificate: ['检查设备的日期和时间', '联系网站管理员确认证书是否有效'],
  secure_connection: ['检查代理或网络配置', '联系网站管理员确认 HTTPS 配置'],
  other: ['检查网络连接', '检查代理、防火墙和 DNS 配置'],
};

export function NativeBrowserError({
  url,
  failure,
  canReload,
  onReload,
}: {
  url: string;
  failure?: NativeBrowserLoadFailure;
  canReload: boolean;
  onReload(): void;
}) {
  let target = url;
  try {
    target = new URL(url).host;
  } catch {}
  const kind = failure?.kind ?? 'other';
  return (
    <section className="native-browser-error" role="alert" aria-label="网页加载失败">
      <div className="native-browser-error-body">
        <span className="native-browser-error-icon" aria-hidden="true">
          <BrowserAnnotationIcon returnToPage />
        </span>
        <h2>无法访问此站点</h2>
        <p>
          {kind === 'certificate'
            ? '无法验证此站点的安全证书：'
            : kind === 'secure_connection'
              ? '无法建立安全连接：'
              : '无法加载 '}
          <span className="native-browser-error-target">{target}</span>
        </p>
        <div className="native-browser-error-advice">
          <p>尝试：</p>
          <ul>
            {advice[kind].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        {failure?.code && <p className="native-browser-error-code">{failure.code}</p>}
        <div className="native-browser-error-actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onReload}
            disabled={!canReload}
          >
            重新加载
          </Button>
          {!canReload && <p>请先接管页面，再重新加载。</p>}
        </div>
      </div>
    </section>
  );
}
