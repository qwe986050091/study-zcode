import fs from 'node:fs';
const src = 'd:/code/_annot_baseline/spec-b3b-2.json';
const s = JSON.parse(fs.readFileSync(src, 'utf8'));
const keep = ['topicResource.ts', 'topicContinuation.ts', 'topicHistory.ts', 'commandParser.ts', 'workspaceHelpers.ts'];
const out = { files: s.files.filter((f) => keep.some((k) => f.path.endsWith('/' + k))) };
const t = out.files.find((f) => f.path.endsWith('/topicResource.ts'));
const e = t.edits.find((x) => x.anchor === 'async readMessage(');
e.anchor = 'readMessage(';
fs.writeFileSync('d:/code/_annot_baseline/spec-b3b-2b.json', JSON.stringify(out, null, 2));
console.log('2b files=' + out.files.length);

const bots = {
  files: [
    {
      path: 'packages/services/src/bots/bots.ts',
      edits: [
        { anchor: 'getStatus(): Promise<BotServiceStatus>;', before: true, lines: ['  // 汇总各渠道连接与启用状态；不触发网络探测。'] },
        { anchor: 'getConfig(): Promise<BotsConfigFile>;', before: true, lines: ['  // 返回归一化后的配置副本。'] },
        { anchor: 'listWorkspaceRefs(params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;', before: true, lines: ['  // 列表只包含当前 Host 可达的工作区。'] },
        { anchor: 'saveConfig(config: BotsConfigFile): Promise<BotsConfigFile>;', before: true, lines: ['  // 整包保存；返回归一化后的结果。'] },
        { anchor: 'listBots(): Promise<BotConfig[]>;', before: true, lines: ['  // 列表不含凭据明文。'] },
        { anchor: 'deleteBot(botId: string): Promise<void>;', before: true, lines: ['  // 删除配置与运行态；凭据由实现方一并清理。'] },
        { anchor: 'getBotStates(): Promise<BotContextState[]>;', before: true, lines: ['  // 运行态快照用于 UI 展示与诊断。'] }
      ]
    }
  ]
};
fs.writeFileSync('d:/code/_annot_baseline/spec-b3b-2c.json', JSON.stringify(bots, null, 2));
console.log('2c ready');
