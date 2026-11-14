// AI-deep-b02 收尾：把 to-response-messages 与 default-generate-text-result 补到 32%。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';
const jobs = {
  'packages/ai/src/generate-text/to-response-messages.ts': [
    {
      find: '// 把一次生成的内容 part 还原成可回灌给模型的消息历史',
      text: [
        '// 阅读顺序：INV 表 → 第一遍 assistant 映射 → 第二遍 tool 结果收集 → 尾部排序。',
        '// 两遍遍历是有意的：tool 结果必须等 assistant 的 tool-call 顺序确定后才能排序。',
      ],
    },
    {
      find: '    // 逐类映射到 AssistantContent',
      text: [
        '    // case 之间没有 default：content 的联合类型已穷尽，新增 part 类型时',
        '    // TypeScript 会在编译期报错，这比运行时兜底更可靠。',
      ],
    },
    {
      find: '  // assistant 消息只在有内容时创建',
      text: [
        '  // 注意：assistant 内容为空但有 tool 结果时，仍然要产出 tool 消息；',
        '  // 这两条消息的创建条件彼此独立，不能合并成一个判断。',
      ],
    },
    {
      find: '  // tool 消息只在有内容时创建',
      text: [
        '  // 排序只发生在 tool 消息内部，assistant 内容的顺序保持原样；',
        '  // 两处顺序约定不同，改动时不要互相参照。',
      ],
    },
  ],
  'packages/ai/src/generate-text/default-generate-text-result.ts': [
    {
      find: '  // 跨 step 聚合：content 是所有步骤的内容拼接',
      text: ['  // 这些 getter 没有缓存：结果对象不可变，重复读取的开销远小于维护失效逻辑。'],
    },
    {
      find: '  // usage 返回累计值而不是最后一步',
      text: ['  // 注意 totalUsage 不是 steps 里 usage 的简单求和：它由构造方直接传入，可能含缓存读写等额外计数。'],
    },
  ],
};

let total = 0;
for (const [rel, edits] of Object.entries(jobs)) {
  const file = REPO + rel;
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  for (const e of edits) {
    const idx = lines.findIndex(l => l.includes(e.find));
    if (idx < 0) {
      console.error('MISS ' + rel + ' :: ' + e.find);
      process.exit(1);
    }
    lines.splice(idx, 0, ...e.text);
    total += e.text.length;
    console.log(`OK ${rel} +${e.text.length}`);
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
}
console.log('TOTAL ADDED ' + total);
