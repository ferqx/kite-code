export {
  createWebGatewayAuth,
  WEB_MAX_SESSIONS,
  WEB_SESSION_TTL_MS,
  type WebGatewayAuthOptions,
  type WebGatewaySessionRecord,
  type WebGatewaySessionRegistry,
} from './auth';
export {
  createWebGatewayCarrier,
  KITE_WEB_LOOPBACK_HOST,
  type WebGatewayAssetReader,
  type WebGatewayCarrier,
  type WebGatewayCarrierOptions,
  type WebGatewayDiagnosticCode,
  type WebGatewayLimits,
} from './carrier';
export * from './static-assets';
