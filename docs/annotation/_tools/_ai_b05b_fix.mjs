// AI-deep-b05 修正：上文件降密度，下两个文件补密度。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

function read(rel) {
  return fs.readFileSync(REPO + rel, 'utf8').split('\r\n');
}
function write(rel, lines) {
  fs.writeFileSync(REPO + rel, lines.join('\r\n'), 'utf8');
}

// 1) to-ui-message-stream.ts：删除 7 行冗余注释（仍远高于 30%）。
{
  const rel = 'packages/ai/src/ui-message-stream/to-ui-message-stream.ts';
  const remove = new Set([
    '// 本文件只做三件事：转移流的所有权、逐 part 转换、维护 outcome 状态。',
    '// 下游 handleUIMessageStreamFinish 负责收尾（持久化回调与 outcome）。',
    '// [权衡] 这套规则宁可保留"成功"，也不让一个迟到的小错误把整条流判死。',
    '// 未提供时保持 undefined，转换器不会给 start chunk 塞 messageId。',
    '// finally 里 releaseLock 是必须的：cancel 抛错也不能让 reader 泄漏。',
    '// 其余 part 的转换结果为 undefined 时（如 sendReasoning=false）直接跳过。',
    '// onStepEnd / onEnd 优先：旧名只在新名缺失时生效。',
  ]);
  const lines = read(rel);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (remove.has(line.trim())) {
      removed++;
      continue;
    }
    kept.push(line);
  }
  if (removed !== remove.size) {
    console.error(`REMOVE MISMATCH ${removed}/${remove.size}`);
    process.exit(1);
  }
  write(rel, kept);
  console.log(`REMOVED ${rel} -${removed}`);
}

// 2) to-ui-message-chunk.ts：补 28 行。
{
  const rel = 'packages/ai/src/ui-message-stream/to-ui-message-chunk.ts';
  const edits = [
    {
      at: 39,
      expect: '// 单个 part 的协议映射表',
      text: [
        '// 设计原则：转换器不认识"流"，只认识单个 part。',
        '// 因此它不判断顺序、不缓存状态，所有状态机都在 toUIMessageStream 里。',
        '// 这也意味着同一 part 在任意位置调用都必须得到相同结果，便于回放与测试。',
        '// 副作用仅有 onError 调用：它应是纯格式化函数，不应有可观察的副作用。',
      ],
    },
    {
      at: 175,
      expect: "if (partType === 'reasoning-file' && !sendReasoning) {",
      text: [
        '// reasoning-file 属于推理产物：关闭 reasoning 时必须一起关闭，',
        '// 否则客户端会收到一段没有上下文的推理文件。',
      ],
    },
    {
      at: 197,
      expect: "if (part.sourceType === 'url') {",
      text: [
        '// URL 来源与文档来源的客户端渲染组件不同，因此拆成两种 chunk。',
        '// sourceId 与内部 part.id 对齐，供客户端去重或按引用跳转。',
        '// 未知 sourceType 返回 undefined：宁可少发，也不发客户端无法识别的形状。',
      ],
    },
    {
      at: 279,
      expect: 'if (part.invalid) {',
      text: [
        '// 无效调用的 input 仍要下发：UI 需要展示模型原始给出的参数以便用户修正。',
        '// 与有效调用的唯一区别是 type 与 errorText，其余字段保持一致，',
        '// 这样客户端可以用同一个组件渲染两种状态，只切换样式。',
      ],
    },
    {
      at: 340,
      expect: "case 'tool-approval-response': {",
      text: [
        '// 响应不带工具名：客户端按 approvalId 关联到先前的请求即可。',
        '// approved=false 时 reason 往往是用户输入的拒绝理由，原样回传。',
        '// providerExecuted 仅供 provider 侧审批链路使用，本地审批不设置。',
      ],
    },
    {
      at: 411,
      expect: "case 'tool-output-denied': {",
      text: [
        '// 拒绝是终态：客户端收到后不应再等待该 toolCallId 的结果或错误。',
      ],
    },
    {
      at: 419,
      expect: "case 'error': {",
      text: [
        '// 只发 errorText，不发原始 error：协议层不承诺错误对象的可序列化形状。',
      ],
    },
    {
      at: 428,
      expect: "case 'steering-message': {",
      text: [
        '// id 沿用 steering 消息自身的 id：客户端据此把它与普通用户消息区分开。',
      ],
    },
    {
      at: 448,
      expect: "case 'start': {",
      text: [
        '// messageId 只在已知响应 id 时出现：续写场景由服务端决定，',
        '// 新会话场景交给客户端自己创建。',
        '// 元数据在 start 与 finish 都会带：客户端可在开始时先渲染摘要，结束时再校正。',
      ],
    },
    {
      at: 481,
      expect: "case 'abort': {",
      text: [
        '// 中止通常由客户端主动触发，原样回显可以让多标签页等场景同步状态。',
      ],
    },
    {
      at: 504,
      expect: 'function convertUserMessageToUIParts(',
      text: [
        '// 这里复用 provider 的文件转换工具，保证 steering 附件的编码与普通消息一致。',
        '// 注意 providerOptions 被映射成 providerMetadata：UI 协议使用后者命名。',
        '// 该函数不处理 tool 相关 part：steering 语义上只允许用户内容。',
      ],
    },
  ];
  const lines = read(rel);
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  let added = 0;
  for (const e of sorted) {
    const idx = e.at - 1;
    if (!lines[idx] || !lines[idx].includes(e.expect)) {
      console.error(`MISS ${rel} ${e.at} :: ${e.expect}`);
      console.error('  actual: ' + JSON.stringify(lines[idx]));
      process.exit(1);
    }
    lines.splice(idx, 0, ...e.text);
    added += e.text.length;
  }
  write(rel, lines);
  console.log(`ADDED ${rel} +${added}`);
}

// 3) create-sse-stream-with-keep-alive.ts：补 6 行。
{
  const rel = 'packages/ai/src/ui-message-stream/create-sse-stream-with-keep-alive.ts';
  const edits = [
    {
      at: 39,
      expect: 'const clearKeepAliveTimeout = () => {',
      text: [
        '// 清定时器必须把句柄置空：否则后续判断"是否已排程"会误判，',
        '// 也可能在 cancel 之后仍持有闭包，延迟进程退出。',
      ],
    },
    {
      at: 66,
      expect: 'start(controller) {',
      text: [
        '// 打开注释必须在任何真实数据之前：它的作用是让代理立刻转发响应头。',
        '// 若等到第一条数据才写，首字节时间会退化为模型首包时间。',
      ],
    },
    {
      at: 82,
      expect: 'if (result.done) {',
      text: [
        '// 上游结束时关闭外层流；保活定时器已在上面清掉，不会再有写入。',
        '// done 分支不重新调度：流结束后继续保活没有意义。',
      ],
    },
  ];
  const lines = read(rel);
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  let added = 0;
  for (const e of sorted) {
    const idx = e.at - 1;
    if (!lines[idx] || !lines[idx].includes(e.expect)) {
      console.error(`MISS ${rel} ${e.at} :: ${e.expect}`);
      console.error('  actual: ' + JSON.stringify(lines[idx]));
      process.exit(1);
    }
    lines.splice(idx, 0, ...e.text);
    added += e.text.length;
  }
  write(rel, lines);
  console.log(`ADDED ${rel} +${added}`);
}
