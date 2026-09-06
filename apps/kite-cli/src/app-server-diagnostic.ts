export type AppServerPairingMode = 'same_build' | 'exact_protocol';

const PAIRED_APP_SERVER_MISMATCH =
  'TUI 与配套 App Server 不兼容，当前 Kite Code 安装可能不完整。请更新或重新安装 Kite Code。';
const DAEMON_APP_SERVER_MISMATCH =
  '当前客户端与指定的 App Server 协议不兼容。请对同一服务运行 server status 和 server restart；忙碌时等待任务结束，或明确使用 restart --cancel。旧开发实例若不支持生命周期接口，请使用匹配客户端停止。';

export function formatAppServerMismatch(pairing: AppServerPairingMode): string {
  return pairing === 'exact_protocol' ? DAEMON_APP_SERVER_MISMATCH : PAIRED_APP_SERVER_MISMATCH;
}
