import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

function patch(rel, adds) {
  const file = REPO + rel;
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const used = new Set();
  const items = adds.map(a => {
    const idx = lines.findIndex(
      (l, i) => !used.has(i) && l.includes(a.expect),
    );
    if (idx < 0) {
      console.error(`MISS ${rel} :: ${a.expect}`);
      process.exit(1);
    }
    used.add(idx);
    return { idx, text: a.text };
  });
  items.sort((x, y) => y.idx - x.idx);
  let added = 0;
  for (const it of items) {
    lines.splice(it.idx, 0, ...it.text);
    added += it.text.length;
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  console.log(`ADDED ${rel} +${added}`);
}

patch('packages/ai/src/ui-message-stream/ui-message-chunks.ts', [
  {
    expect: 'citations: z.array(citationSchema).optional(),',
    text: [
      '// 引用数组可省略：不是所有 provider 都返回引用，缺省时客户端不渲染引用区。',
      '// Citation 与文本绑定而不是消息绑定：同一条消息的不同段落可有不同来源。',
      '// 引用校验在运行时执行，避免客户端因单个畸形引用而整条消息解析失败。',
    ],
  },
  {
    expect: "inputEncoding: z.enum(['json', 'text']).optional(),",
    text: [
      '// 编码只在"增量是可解析文本"时有意义，因此限制为两种值。',
      '// 缺省按 JSON：这是 tool-call 参数的默认表达。',
      '// 客户端据此决定是直接拼接字符串还是先解析再合并对象。',
    ],
  },
  {
    expect: 'preliminary: z.boolean().optional(),',
    text: [
      '// preliminary 只对外发到浏览器，不进入模型历史：',
      '// 中间结果回灌会让模型误以为工具已经执行完成。',
      '// 客户端应把它当作"替换上一帧"而不是新的一条结果。',
    ],
  },
  {
    expect: 'approvalDescriptor: z.unknown().optional(),',
    text: [
      '// descriptor 描述"要审批什么"（命令、目标资源等），结构由工具自定义。',
      '// 协议层不约束其形状，只保证可序列化；UI 负责按 descriptor.kind 渲染。',
      '// 它与 inputSchemaInput 的区别：前者面向人，后者是即将执行的精确参数。',
    ],
  },
  {
    expect: 'transient: z.boolean().optional(),',
    text: [
      '// transient 数据块不进消息历史，只用于即时反馈（进度、状态提示）。',
      '// 服务端与客户端都必须遵守这个约定，否则刷新后会出现幽灵内容。',
      '// 该字段是协议中唯一影响"是否持久化"的开关，需谨慎使用。',
    ],
  },
  {
    expect: "type: z.literal('reset-step'),",
    text: [
      '// 重试时服务端先发 reset-step，再重放本 step 的 parts。',
    ],
  },
  {
    expect: 'messageMetadata: z.unknown(),',
    text: [
      '// 独立的元数据块：可以在不重发整条消息的情况下更新用量、状态等字段。',
      '// 元数据用 unknown：具体结构由业务的 UIMessage metadata 类型决定。',
      '// 客户端按到达顺序覆盖，最后一条生效，因此服务端应发"全量快照"而非增量。',
    ],
  },
  {
    expect: 'export function isDataUIMessageChunk(',
    text: [
      '// 注意该守卫对所有 UIMessageChunk 都成立，包括未知的数据块，',
      '// 因此可以在解析完成的联合上安全调用，不需要先做 exhaustive 检查。',
    ],
  },
  {
    expect: "type: 'tool-input-delta';",
    text: [
      '// 该类型只存在于协议中，没有对应的内部 part 名字差异。',
    ],
  },
  {
    expect: "type: 'source-document';",
    text: [
      '// 文档来源必须带 mediaType：客户端据此选择 PDF/文本预览组件。',
    ],
  },
  {
    expect: "type: 'message-metadata';",
    text: [
      '// 与 start/finish 的 messageMetadata 不同，这里不携带消息身份，只更新元数据。',
    ],
  },
  {
    expect: 'transient?: boolean;',
    text: [
      '// 业务数据块的两个可选控制字段：id 用于更新同一条瞬时数据，',
      '// transient 决定是否写入消息历史。两者都省略时视为一次性持久数据。',
      '// 这里的类型与运行时校验必须保持一致，否则会出现"类型允许但校验拒绝"。',
    ],
  },
]);

patch('packages/ai/src/ui-message-stream/read-ui-message-stream.ts', [
  {
    expect: 'const state = createStreamingUIMessageState<UI_MESSAGE>({',
    text: [
      '// lastMessage 直接使用调用方传入的对象：状态机会在 clone 后再修改，',
      '// 因此这里不需要预先复制，避免多一次深拷贝。',
      '// messageId 缺失时用空串：第一个 start chunk 会带着真实 id 覆盖它。',
    ],
  },
]);
