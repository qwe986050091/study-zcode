import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

function add(rel, anchors) {
  const file = REPO + rel;
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const used = new Set();
  const items = anchors.map(a => {
    const idx = lines.findIndex((l, i) => !used.has(i) && l.includes(a.expect));
    if (idx < 0) {
      console.error(`MISS ${rel} :: ${a.expect}`);
      process.exit(1);
    }
    used.add(idx);
    return { idx, text: a.text };
  });
  items.sort((x, y) => y.idx - x.idx);
  let n = 0;
  for (const it of items) {
    lines.splice(it.idx, 0, ...it.text);
    n += it.text.length;
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  console.log(`ADDED ${rel} +${n}`);
}

function remove(rel, subs) {
  const file = REPO + rel;
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  let n = 0;
  for (const s of subs) {
    const idx = lines.findIndex(l => l.trim().startsWith('//') && l.includes(s));
    if (idx < 0) {
      console.error(`REMOVE MISS ${rel} :: ${s}`);
      process.exit(1);
    }
    lines.splice(idx, 1);
    n++;
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  console.log(`REMOVED ${rel} -${n}`);
}

remove('packages/ai/src/generate-text/output.ts', [
  '[权衡] 这里不做 schema 的本地校验',
  '真正的校验在 parseCompleteOutput 里完成',
  '策略避免 UI 在候选之间来回跳动',
]);

add('packages/ai/src/generate-text/validate-tool-approvals.ts', [
  {
    expect: 'denied.push({',
    text: [
      '// 拒绝时把 approved 改成 false 并保留（或补上）原因：',
      '// 这条响应会回灌给模型，让它知道用户拒绝了这个操作。',
    ],
  },
]);

add('packages/ai/src/generate-text/tool-caller-configuration.ts', [
  {
    expect: 'export type ResolvedToolCallers',
    text: [
      '// 归一后的形状去掉泛型与可选性：后续逻辑只需按名字查调用方列表。',
      '// 键集合比原始配置小（只保留真实存在的工具），值保证非 null。',
      '// 单独定义类型是为了让"已校验"这件事在类型层面可见。',
    ],
  },
  {
    expect: 'const resolved: ResolvedToolCallers = {};',
    text: [
      '// 不复制 callers 数组：配置是只读契约，分配新数组只会增加分配开销。',
    ],
  },
  {
    expect: 'if (callers != null) {',
    text: [
      '// 空数组也算有效配置：它表示"该工具不允许任何调用方"，与未配置不同。',
    ],
  },
  {
    expect: 'const modelTools: ToolSet = { ...tools };',
    text: [
      '// modelTools 初始包含全部工具，稍后按可用路径逐个删除被独占的项。',
    ],
  },
  {
    expect: 'executionTools[toolName] = preparedTool;',
    text: [
      '// 即使没有任何 caller 命中，也把 preparedTool 写回：它可能与原始工具相同。',
      '// 这样 executionTools 始终是"执行时应使用的版本"，调用方无需再判断。',
      '// 注意此时 modelTools 可能已被删除该键，两份产物在这里正式分叉。',
    ],
  },
]);

add('packages/ai/src/generate-text/tool-approval-signature.ts', [
  {
    expect: 'return convertBase64ToUint8Array(str);',
    text: [
      '// 单独包一层是为了集中处理 base64url 的字符集差异，',
      '// 并让调用点读起来是"取签名字节"而不是一次通用转换。',
    ],
  },
  {
    expect: 'const key = await importKey(secret);',
    text: [
      '// 每次签名都重新导入密钥：Web Crypto 的 CryptoKey 不能缓存到全局，',
      '// 否则密钥轮换后旧 key 会继续生效。',
    ],
  },
  {
    expect: 'if (secret == null) return undefined;',
    text: [
      '// 用 == null 同时覆盖 undefined 与 null：调用方可能显式传 null 表示未配置。',
    ],
  },
]);

add('packages/ai/src/generate-text/tool-call-concurrency.ts', [
  {
    expect: 'const results = new Array<OUTPUT>(items.length);',
    text: [
      '// 预分配定长数组：工作协程按下标写入，避免 push 导致的顺序不确定。',
    ],
  },
]);
