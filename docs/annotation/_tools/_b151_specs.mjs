import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/turn.ts',
    target: 55,
    firstNth: 1,
    header: [
      '// INV-01 输入先入可取消队列：守住位置 入队调用；改错故障 并发 turn 污染历史。',
      '// INV-02 本轮模型选择在接纳时冻结：守住位置 选择三选一；改错故障 执行中切模影响已开始的轮次。',
      '// INV-03 加速卡回退快照随接纳冻结：守住位置 结构化克隆；改错故障 回退时读到新会话选择。',
      '// INV-04 输出风格本轮冻结：守住位置 配置赋值；改错故障 中途改配置影响当前轮。',
      '// INV-05 特殊命令先解析后分派：守住位置 两个解析函数；改错故障 压缩输入进入普通循环。',
      '// INV-06 turnId 与 queryId 分层：守住位置 预留与新建；改错故障 同一任务链被拆成多次 query。',
      '// INV-07 每轮独立子 trace：守住位置 子 trace 构造；改错故障 事件无法归到具体 turn。',
      '// INV-08 事件缓冲区本轮独占：守住位置 events；改错故障 事件串轮。',
      '// INV-09 预留 turn 开始位置：守住位置 预留调用；改错故障 两个并发输入同时开跑。',
      '// INV-10 取消源合并为单一 signal：守住位置 取消作用域；改错故障 取消条件分散检查。',
      '// INV-11 阶段观测成对：守住位置 开始与结束函数；改错故障 TTFT 缺段。',
      '// INV-12 模型创建失败保留已接纳输入：守住位置 creationFailure；改错故障 重启后文本丢失。',
      '// INV-13 创建期退回按候选逐个尝试：守住位置 候选循环；改错故障 直接暴露隐藏 provider 错误。',
      '// INV-14 创建失败轮不跑 context 与 hooks：守住位置 条件分支；改错故障 一次性 SessionStart 被消费。',
      '// INV-15 活跃 turn 同时只有一个：守住位置 beginActiveTurn；改错故障 两个 turn 同时写历史。',
      '// INV-16 终态事件唯一出口：守住位置 appendTurnOutcomeEvent；改错故障 turn 无终态或双终态。',
      '// INV-17 finally 必须释放全部资源：守住位置 清理块；改错故障 心跳与预留泄漏到下一轮。',
      '// INV-18 摘要与清理失败不覆盖主结果：守住位置 各自捕获；改错故障 成功结果被清理异常覆盖。',
      '//',
      '// 模块职责：Agent 单轮输入的接纳、执行与成功或失败收尾。',
      '// 状态所有权：会话级状态归 runtime；本轮事实在入口处冻结。',
      '// 阅读顺序：先看公共入口，再看执行闭包的创建与分支，最后看收尾与资源释放。',
    ],
    blocks: [
      {
        anchor: 'const offPeakTurn = prepareOffPeakTurn(this, options);',
        lines: [
          '闲时输入可能带临时执行参数。',
          '改写后的选项供后续统一使用。',
          '释放句柄在 finally 归还。',
          '票据结局按取消与失败区分。',
        ],
      },
      {
        anchor: 'const admittedModelSelection =',
        lines: [
          '提交内显式选择优先。',
          '其次执行作用域选择。',
          '最后会话默认兜底。',
          '只冻结选择不创建实例。',
        ],
      },
      {
        anchor: 'const events: SessionEvent[] = [];',
        lines: [
          '本轮事件只进这个数组。',
          '终态事件先落库再入组。',
          '用量统计从事件汇总。',
          '界面流式消费同一序列。',
        ],
      },
      {
        anchor: 'const startTurnPhase = (phase: string): number => {',
        lines: [
          '进入阶段先关闭上一段观测。',
          '只有准备类阶段计入 TTFT。',
          '阶段名进入结构化日志。',
          '返回起始时间供耗时计算。',
        ],
      },
      {
        anchor: 'const execute = () =>',
        lines: [
          '绑定 trace 后整体执行。',
          '内部异步调用继承同一 trace。',
          '成功与失败都在此收口。',
          '遥测包裹在最外层。',
        ],
      },
      {
        anchor: 'let admittedModel: Model | undefined;',
        lines: [
          '创建结果可能被退回替换。',
          '同时记录实际执行选择。',
          '退回事实用于发事件。',
          '创建失败交给主链处理。',
        ],
      },
      {
        anchor: 'const creationFallbackMatch = matchExecutionSelectionCreationFallback({',
        lines: [
          '命中后才尝试候选。',
          '候选顺序为声明目标与会话兜底。',
          '全部失败标记无处可退。',
        ],
      },
      {
        anchor: 'activeTurn = this.beginActiveTurn(',
        lines: [
          '注册后同一 runtime 只此一个。',
          '创建失败轮标记不可引导。',
          '结束后释放标记。',
        ],
      },
      {
        anchor: 'loopState = {',
        lines: [
          '主循环只读写该对象。',
          '历史借用只读快照。',
          '后续由显式提交推进。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b151-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
