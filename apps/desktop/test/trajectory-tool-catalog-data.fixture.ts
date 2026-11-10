/** Controlled public request data for directory layout; these are not current registry bindings. */
export function trajectoryToolCatalogData() {
  const entries: readonly [string, string?][] = [
    ['files.read', '读取文件的指定窗口，保留原路径和行范围。'],
    ['files.write', 'Create a file with the exact supplied content.'],
    ['files.edit', '按上下文修改已有文件；未匹配时保留失败原因。'],
    ['shell.execute', '运行工作区命令，并保存真实的退出码及输出。'],
    ['shell.read', 'Read the retained stdout and stderr of the original command.'],
    ['shell.wait', '等待原命令结束；等待超时不会终止命令。'],
    ['shell.stop', '请求停止准确的后台命令。'],
    ['task.spawn', '委派子 Agent 独立检查一个明确目标。'],
    ['task.events', '读取准确子任务已保存的观察和结果。'],
    ['task.message', '向已经存在的协作者发送补充信息。'],
    ['browser', 'Operate the already authorized browser page and inspect its saved result.'],
    ['web.fetch', '读取网页公开内容并说明截断范围。'],
    ['plan.update', '保存当前任务的步骤和完成状态。'],
    ['skill.load', '读取当次已选择技能的完整公开说明。'],
    ['worktree.create', '创建一个独立工作目录，保留原仓库信息。'],
    ['question.ask', '向用户提出需要回答的问题，并保存审批反馈。'],
    [
      'mcp__observability__inspect_saved_agent_execution_and_related_child_operation_records_without_reopening_the_original_runtime_session',
      '定位父子调用：查询该次已保存执行的原始关联信息。Long public tool names remain exact; presentation must not rename or invent a category.',
    ],
    [
      'plugin__documentation_search',
      'Search the original public documentation.\n\n' +
        '返回准确来源和匹配段落，不读取今天的配置重建旧记录。 '.repeat(24),
    ],
    ['资源_读取说明', '读取原公开资源说明。中文名称也应保持可读。'],
    ['tools.no_description'],
    [
      'terminal.await_output',
      'Wait for the selected original output checkpoint; return its saved completeness and gaps.',
    ],
  ];
  const tools = entries.map(([id, description]) => ({
    id,
    definitionVersion: '1',
    ...(description ? { description } : {}),
    inputSchema:
      id === 'files.read'
        ? {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对于原工作目录的文件路径。' },
              window: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      startLine: { type: 'integer', minimum: 1 },
                      endLine: { type: 'integer', minimum: 1 },
                    },
                    required: ['startLine', 'endLine'],
                    additionalProperties: false,
                  },
                  { type: 'string', enum: ['entire_file'] },
                ],
              },
              encoding: { type: 'string', enum: ['utf-8', 'auto'], default: 'utf-8' },
              scope: { $ref: '#/$defs/readScope' },
            },
            required: ['path'],
            additionalProperties: false,
            $defs: {
              readScope: {
                type: 'object',
                properties: {
                  workingDirectory: { type: 'string' },
                  symlinkPolicy: { type: 'string', enum: ['preserve', 'resolve'] },
                },
                required: ['workingDirectory'],
              },
            },
          }
        : {
            type: 'object',
            properties: {
              target: { type: 'string', description: '当次选择的准确目标。' },
              options: { type: 'object', additionalProperties: true },
            },
            required: ['target'],
            additionalProperties: false,
          },
  }));
  return { tools, contentVersion: `public_model_input_${'0123456789abcdef'.repeat(4)}` };
}
