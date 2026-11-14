// INV-01 非 plain 输入：守住位置 控制字符判断；改错故障：转义序列里的字符参与匹配，待补文本被误判已处理。
// INV-02 严格相等：守住位置 候选文本与数据的相等比较；改错故障：同拍无关输入被当作候选消费。
// INV-03 IME 路径：守住位置 提交键分支；改错故障：中文与回车同块时整块被丢弃，随后重复写入。
// INV-04 控制符剥离：守住位置 可打印字符提取；改错故障：转义序列被拼成可见文本。
// INV-05 时间窗：守住位置 最大时效过滤；改错故障：过期候选仍能匹配当前输入。
// INV-06 单次消费：守住位置 已消费标记；改错故障：同一段数据被两条输入路径重复消费。
// INV-07 时间戳单调：守住位置 输入事件与按键事件的先后判断；改错故障：先发生的输入匹配到后发生的按键。
// INV-08 类型区分：守住位置 最近数据与按键数据的时间容差；改错故障：无按键路径被过严容差挡住。
// INV-09 最小长度：守住位置 待补文本为空的跳过；改错故障：空串匹配到任意位置。
// INV-10 部分消费：守住位置 剩余数据切片；改错故障：多段待补文本只命中第一段。
// INV-11 不变式：守住位置 历史数组只追加不修改；改错故障：调用方持有的旧数组被原地改写。
// INV-12 返回值契约：守住位置 记录函数返回新数组；改错故障：引用不变导致界面不刷新。
// INV-13 动作决议：守住位置 已处理与有值的组合；改错故障：已处理仍写入，产生重复文本。
// INV-14 清空条件：守住位置 清空表达式的两个来源；改错故障：待补文本残留到下一次输入。
// INV-15 纯函数：守住位置 本文件全部导出；改错故障：共享可变状态让测试互相污染。
// INV-16 事件时间源：守住位置 时间戳字段来源；改错故障：混用不同时钟导致比较失真。
// INV-17 字段命名：守住位置 候选与历史的字段；改错故障：读取方拿错字段，去重失效。
// INV-18 边界说明：守住位置 输入法兜底注释；改错故障：后人误删分支，重复输入回归。
//
// 模块职责：为终端组合输入兜底提供纯函数，判断哪些按键与数据已由终端消费，避免重复写入。
// 状态所有权：所有函数无状态；待补对象与历史数组由调用方持有并回传。
// 阅读顺序：数据结构 → 可打印判断 → 候选生成 → 标记与记录 → 消费与动作决议。
export interface PendingTerminalInputFallback {
  handled: boolean;
  text: string;
}

// 按键候选：文本键记录单字符，输入法提交键只记录时间戳而不记录文本。
// 两类候选共用记录时间，用于后续按时间窗淘汰。
//
export interface TerminalInputFallbackKeydownCandidate {
  kind: "text" | "imeCommit";
  text: string | null;
  eventTimeStamp: number;
  recordedAt: number;
}

export interface TerminalInputFallbackHandledData {
  consumed: boolean;
  data: string;
  keydownEventTimeStamp: number;
  kind: "text" | "imeCommit" | "recentData";
  recordedAt: number;
}

// 待补对象：初始未处理，文本来自 textarea 的组合输入。
// 该对象由调用方持有，本模块通过标记字段回写处理结果。
//
export function createPendingTerminalInputFallback(text: string): PendingTerminalInputFallback {
  return {
    handled: false,
    text,
  };
}

// 纯文本判断：所有码点都必须是可打印字符，控制字符一律视为非纯文本。
// 方向键等控制输入会产生转义序列，序列里的普通字符若参与匹配会误判待补文本已处理。
// 逐码点判断而不是按字节，保证多字节字符不被拆坏。
//
function isPlainTerminalInputData(data: string): boolean {
  // 方向键等控制输入会产生 ESC 序列，例如 "\x1b[D"。
  // 这些序列里的普通字符不能参与 composed input 兜底匹配，否则可能把真实待补文本误判为已处理。
  return Array.from(data).every((char) => {
    const code = char.codePointAt(0);
    return code !== undefined && code >= 0x20 && code !== 0x7f;
  });
}

// 可打印提取：含转义起始符的数据整段放弃，否则只保留可打印字符。
// 提取结果为空时返回空值，调用方据此跳过记录。
//
function getPlainTerminalInputText(data: string): string | null {
  if (data.includes("\u001b")) {
    return null;
  }

  let text = "";
  for (const char of Array.from(data)) {
    const code = char.codePointAt(0);
    if (code !== undefined && code >= 0x20 && code !== 0x7f) {
      text += char;
    }
  }

  return text.length > 0 ? text : null;
}

// 命中数据计算：输入法提交键只提取可打印文本，文本键还要求与候选完全相等。
// `text` 相等才复用候选，防止同一拍里的无关输入被误消费。
//
function getHandledFallbackData(params: {
  candidate: TerminalInputFallbackKeydownCandidate;
  data: string;
}): string | null {
  if (params.candidate.kind === "imeCommit") {
    // 搜狗等三方输入法用 Enter 提交候选词时，xterm 的 onData 可能把中文和
    // Enter 控制符合并在同一个 chunk（例如 "中文\r"）。把整个 chunk 判为非 plain 会让
    // 后续 textarea input 兜底又写一次中文；这里只在 IME 提交键路径提取可打印文本。
    return getPlainTerminalInputText(params.data);
  }

  if (!isPlainTerminalInputData(params.data) || params.candidate.text !== params.data) {
    return null;
  }

  return params.data;
}

// 回车与输入法处理键（`keydown` 提交类）只记录时间戳。
// 其余单字符且可打印的按键归为文本类，同时记录字符。
// 被修饰键组合或不可打印的按键返回空值，不参与去重。
//
export function createTerminalInputFallbackKeydownCandidate(params: {
  eventTimeStamp: number;
  key: string;
  now: number;
}): TerminalInputFallbackKeydownCandidate | null {
  if (params.key === "Enter" || params.key === "Process") {
    // 搜狗等三方中文输入法在 Windows 上常用 Enter/Process 提交候选词。
    // 此时 xterm 可能已经通过 onData 发出中文，随后 textarea input 又残留同一段组合文本；
    // 这里保留提交键时间戳，让后续 plain onData 能和同一拍 input 去重，避免再次兜底写入。
    return {
      eventTimeStamp: params.eventTimeStamp,
      kind: "imeCommit",
      recordedAt: params.now,
      text: null,
    };
  }

  if (params.key.length !== 1 || !isPlainTerminalInputData(params.key)) {
    return null;
  }

  return {
    eventTimeStamp: params.eventTimeStamp,
    kind: "text",
    recordedAt: params.now,
    text: params.key,
  };
}

// 标记已处理：从数据里逐段查找待补文本，命中即打标并从剩余数据中切除。
// 切除保证多段相同文本不会重复命中同一处，已处理条目直接跳过。
//
export function markTerminalInputFallbackHandled(
  pending: readonly PendingTerminalInputFallback[],
  data: string,
): void {
  const handledText = isPlainTerminalInputData(data) ? data : getPlainTerminalInputText(data);
  if (!handledText) {
    return;
  }

  let remainingData = handledText;
  for (const item of pending) {
    if (item.handled || item.text.length === 0) {
      continue;
    }
    const index = remainingData.indexOf(item.text);
    if (index === -1) {
      continue;
    }
    item.handled = true;
    remainingData = remainingData.slice(0, index) + remainingData.slice(index + item.text.length);
  }
}

// 记录按键命中：先按最大时效 `MAX_AGE` 淘汰历史，再判断候选是否新鲜。
// 候选缺失或过期时只返回裁剪后的历史；命中时追加未消费记录并保留按键时间戳。
//
export function recordTerminalInputFallbackHandledData(params: {
  candidate: TerminalInputFallbackKeydownCandidate | null;
  data: string;
  history: readonly TerminalInputFallbackHandledData[];
  maxAgeMs: number;
  now: number;
}): {
  history: TerminalInputFallbackHandledData[];
  usedCandidate: boolean;
} {
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  );
  const candidate = params.candidate;
  if (!candidate || params.now - candidate.recordedAt > params.maxAgeMs) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    };
  }

  const data = getHandledFallbackData({ candidate, data: params.data });
  if (!data) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    };
  }

  return {
    history: [
      ...retainedHistory,
      {
        consumed: false,
        data,
        keydownEventTimeStamp: candidate.eventTimeStamp,
        kind: candidate.kind,
        recordedAt: params.now,
      },
    ],
    usedCandidate: true,
  };
}

// 记录最近数据：没有稳定按键路径时，用极短窗口的数据记录兜底去重。
// 同样先淘汰过期历史，再追加一条未消费记录。
//
export function recordTerminalInputFallbackRecentData(params: {
  data: string;
  history: readonly TerminalInputFallbackHandledData[];
  maxAgeMs: number;
  now: number;
}): TerminalInputFallbackHandledData[] {
  // 搜狗输入法提交候选词时，xterm 可能先通过 onData 写入中文，随后才派发
  // textarea composed input；这条路径没有稳定 keydown candidate，只能用极短窗口的 recentData 去重。
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  );
  const data = isPlainTerminalInputData(params.data)
    ? params.data
    : getPlainTerminalInputText(params.data);
  if (!data) {
    return retainedHistory;
  }

  return [
    ...retainedHistory,
    {
      consumed: false,
      data,
      keydownEventTimeStamp: params.now,
      kind: "recentData",
      recordedAt: params.now,
    },
  ];
}

// 消费命中：在历史里找未消费、未过期且文本完全一致的记录。
// 按键类记录还要求输入事件晚于按键且落在容差内，命中后同时标记记录与待补对象。
//
export function consumeTerminalInputFallbackHandledData(params: {
  history: readonly TerminalInputFallbackHandledData[];
  inputEventTimeStamp: number;
  maxAgeMs: number;
  maxInputDelayMs: number;
  now: number;
  pending: PendingTerminalInputFallback;
}): void {
  const matched = params.history.find(
    (item) =>
      !item.consumed &&
      params.now - item.recordedAt <= params.maxAgeMs &&
      params.pending.text === item.data &&
      (item.kind === "recentData"
        ? params.now - item.recordedAt <= params.maxInputDelayMs
        : params.inputEventTimeStamp >= item.keydownEventTimeStamp &&
          params.inputEventTimeStamp - item.keydownEventTimeStamp <=
            (item.kind === "imeCommit" ? params.maxAgeMs : params.maxInputDelayMs)),
  );
  if (!matched) {
    return;
  }

  matched.consumed = true;
  params.pending.handled = true;
}

export function resolveTerminalInputFallbackAction(params: {
  pending: PendingTerminalInputFallback;
  textareaValue: string;
}): {
  shouldClearTextarea: boolean;
  shouldWrite: boolean;
} {
  const hasTextareaValue = params.textareaValue.length > 0;
  const shouldWrite = !params.pending.handled && hasTextareaValue;
  return {
    shouldClearTextarea: hasTextareaValue && (params.pending.handled || shouldWrite),
    shouldWrite,
  };
}
