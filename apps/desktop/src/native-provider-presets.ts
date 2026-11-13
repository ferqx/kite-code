/** Add-form templates for the existing compatible family. IDs never leave the renderer. */
export type CompatibleProviderPreset = {
  id: string;
  label: string;
  baseURL: string;
  protocol?: 'responses';
  keyHelp: string;
  manualModel?: boolean;
};

export const compatibleProviderPresets: readonly CompatibleProviderPreset[] = [
  {
    id: 'mimo-api',
    label: '小米 MiMo · 按量 API',
    baseURL: 'https://api.xiaomimimo.com/v1',
    protocol: 'responses',
    keyHelp: '使用小米 MiMo 开放平台创建的按量 API key（sk-）。',
    manualModel: true,
  },
  {
    id: 'mimo-token-plan',
    label: '小米 MiMo · Token Plan',
    baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
    protocol: 'responses',
    keyHelp: '使用 Token Plan 控制台的个人（tp-）或团队（ttp-）套餐 key。地址以控制台为准。',
    manualModel: true,
  },
  {
    id: 'kimi-api',
    label: 'Kimi 开放平台 · API',
    baseURL: 'https://api.moonshot.cn/v1',
    keyHelp: '使用 Kimi 开放平台的 API key（中国站，按量计费）。',
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code · 会员套餐',
    baseURL: 'https://api.kimi.com/coding/v1',
    protocol: 'responses',
    keyHelp: '使用 Kimi Code 控制台的套餐 API key（中国站），与 Kimi 开放平台不通用。',
    manualModel: true,
  },
  {
    id: 'glm-api',
    label: '智谱 GLM · API',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    keyHelp: '使用智谱开放平台的标准 API key，不填 GLM Coding Plan 的个人或团队套餐 key。',
    manualModel: true,
  },
  {
    id: 'grok-api',
    label: 'Grok (xAI) · API',
    baseURL: 'https://api.x.ai/v1',
    protocol: 'responses',
    keyHelp: '使用 xAI API Console 签发的 API key。',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go · 套餐',
    baseURL: 'https://opencode.ai/inference/go/openai/v1',
    keyHelp: '使用 OpenCode Console 已订阅 Go 的工作区 API key。',
    manualModel: true,
  },
  {
    id: 'bailian-api',
    label: '阿里云百炼（千问） · API',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyHelp: '使用百炼北京地域的通用 API key。通用资源包由百炼结算时抵扣。',
    manualModel: true,
  },
  {
    id: 'bailian-token-plan',
    label: '阿里云百炼 · Token Plan',
    baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    keyHelp: '使用 Token Plan 专属 API key，仅用于交互式开发；请勿用于后台定时任务。',
    manualModel: true,
  },
  {
    id: 'bailian-coding-plan',
    label: '阿里云百炼 · Coding Plan',
    baseURL: 'https://coding.dashscope.aliyuncs.com/v1',
    keyHelp: '使用已有 Coding Plan 的专属 API key；与 Token Plan 和通用 API 不通用。',
    manualModel: true,
  },
  {
    id: 'minimax-api',
    label: 'MiniMax · API',
    baseURL: 'https://api.minimax.cn/v1',
    keyHelp: '使用 MiniMax 中国站的按量 API key。',
  },
  {
    id: 'minimax-m-plan',
    label: 'MiniMax · M Plan',
    baseURL: 'https://api.minimax.cn/v1',
    keyHelp: '使用 MiniMax 中国站的订阅 key。地址与按量 API 相同，计费方式取决于使用的 key。',
    manualModel: true,
  },
  {
    id: 'ark-api',
    label: '火山方舟（豆包） · API',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    keyHelp: '使用方舟北京地域的标准 API key，并填写已开通的模型 ID 或接入点 ID。',
    manualModel: true,
  },
];
