export type AppServerPairingMode = 'same_build' | 'exact_protocol';

const PAIRED_APP_SERVER_MISMATCH =
  'TUI 与配套 App Server 不兼容，当前 Kite Code 安装可能不完整。请更新或重新安装 Kite Code。';
const DAEMON_APP_SERVER_MISMATCH =
  '当前客户端与指定的 App Server 协议不兼容。请更新 Kite Code，或改用与该 App Server 匹配的客户端；升级后仍出现此问题时，请关闭旧 App Server 并重新启动。';

export function formatAppServerMismatch(pairing: AppServerPairingMode): string {
  return pairing === 'exact_protocol' ? DAEMON_APP_SERVER_MISMATCH : PAIRED_APP_SERVER_MISMATCH;
}
