// 工具调用 diff 预览的文本层：把任意形态的 before/after 载荷收敛成 unified diff 字符串。
// 职责包含载荷识别、按行切分、公共前后缀收敛、LCS 或锚点分段、hunk 头生成与上下文裁剪。
// 输出必须同时满足 Git 补丁文法与 @pierre/diffs 的解析假设，任一处违约都会让预览整块崩溃。
// 本文件是纯字符串计算，没有 IO、缓存与 React 依赖，会被消息摘要和 Git 面板在高频渲染中调用。
// 因此所有复杂度上限都在这里显式兜底，不把平方级开销留给主线程。
//
// INV-01 首行恒为 diff --git 且两侧同路径；守住位置：buildUnifiedDiff 的 patchLines 初始化；改错故障：正文以 -- 开头的 SQL 注释被当成第二个文件，FileDiff 解析崩溃。
// INV-02 新建文件时旧侧必须写 /dev/null，不能写 a 路径加 @@ -0,0；守住位置：isCreatedFile 三元分支；改错故障：大文件新增被当作普通修改，右侧行映射卡死。
// INV-03 删除文件时新侧必须写 /dev/null；守住位置：isDeletedFile 三元分支；改错故障：预览器按修改语义渲染，删除内容消失且行号整体错位。
// INV-04 前后都为空时仍返回仅含文件头与空 hunk 的 patch，不返回 null；守住位置：buildUnifiedDiff 末尾返回值；改错故障：调用方走降级分支，丢失统一渲染。
// INV-05 按 LF 切分且末行无换行也保留为一行；守住位置：splitLines；改错故障：文件末尾缺换行时最后一行在 diff 中静默消失。
// INV-06 不在本文件剥离 CRLF，行内回车会参与相等比较；守住位置：splitLines 与 countSharedPrefix；改错故障：混用换行符的文件被判成整段全删全加。
// INV-07 公共前缀与公共后缀不得重叠；守住位置：countSharedSuffix 的上界减去前缀计数；改错故障：中间区间切片长度为负，改动内容被整段吞掉。
// INV-08 上下文模式下行数上限恒为归一化后的上下文值，前后缀各自截断；守住位置：limitedPrefixCount 与 limitedSuffixCount；改错故障：大文件只改一行却铺满整页。
// INV-09 hunk 头声明的行数必须等于实际输出的行数；守住位置：beforeRangeLineCount 与 afterRangeLineCount；改错故障：解析器按声明长度吞行，后续 hunk 全部错位。
// INV-10 只有矩阵规模不超过 MAX_DIFF_LCS_CELLS 才允许建表；守住位置：appendDiffBodyWithLcs 的乘积判断；改错故障：千行级文件分配数亿单元，主线程内存暴涨卡死。
// INV-11 超限时退化为锚点分段，输出仍是合法 unified diff；守住位置：appendDiffBodyWithLargeSegmentFallback；改错故障：大区间整段染红染绿，用户误判改动范围。
// INV-12 锚点只取前后各出现一次的行；守住位置：collectUniqueLineMatches 的出现次数判定；改错故障：重复行被错配成锚点，生成自相矛盾的 hunk。
// INV-13 锚点必须旧侧下标与新侧下标同时递增；守住位置：findIncreasingAnchorMatches 的耐心排序；改错故障：区间反向导致切片为空，真实改动被丢弃。
// INV-14 锚点区间必须无重叠地覆盖全部行，最后一段收尾到数组末尾；守住位置：两次 appendDiffBody 调用；改错故障：尾部内容静默丢失，diff 看起来没改干净。
// INV-15 每条正文行带且仅带一个前导标记；守住位置：appendLinesWithPrefix 与各拼接点；改错故障：解析器把无标记行当上下文，行数与 hunk 头不符。
// INV-16 空字符串必须映射为空数组而不是一个空元素；守住位置：splitLines 的长度判断；改错故障：空文件新增多出一个空上下文行，hunk 行数错一位。
// INV-17 结构化 diff 只下探一层 content 数组；守住位置：extractStructuredDiff；改错故障：自引用载荷触发无限递归导致爆栈。
// INV-18 字段提取失败返回 null 而不抛错；守住位置：extractBeforeAfter 与 findStringField；改错故障：异常冒泡到消息渲染，整条消息白屏。
// INV-19 不修改任何入参字符串，所有拼接都落在新的 patchLines 数组上；守住位置：全文件的只读形参与 push；改错故障：上游工具结果被就地改写，重渲染出现脏数据。
//
import { trimPatchContext } from "@pierre/diffs";

// [资源] 该上限约束 LCS 表规模，表大小等于前段行数乘后段行数，是本文件唯一的平方级内存点
// [权衡] 上调阈值能多保留真实 hunk，但展开预览在主线程同步计算，千行级文件会明显掉帧
const MAX_DIFF_LCS_CELLS = 60_000;

// 唯一行锚点的配对：同一行文本在前后各自只出现一次时的两个下标
// [失败路径] 重复行不进入该结构，重复文本没有唯一位置，配错会让 hunk 区间互相穿插
interface LineMatch {
  beforeIndex: number;
  afterIndex: number;
}

// 工具入参来自 unknown 的 JSON 载荷，判型必须先挡掉 null，否则属性访问直接抛 TypeError
// 数组同样满足 typeof object，这里不排除，由各调用点按字段形态自行区分
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 同一语义在不同工具里字段名不同，按候选顺序取第一个非空字符串，空串等同缺失
// 只对候选做 trim 判空而不改写返回值，保留原始缩进供 diff 逐行比较
function findStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

// 编辑类工具的载荷形态不统一，新旧文本可能叫 before/after，也可能叫 old_string/new_string
// [失败路径] 只有一侧存在时返回 null 而不是用空串补齐，否则缺字段会被误渲染成整文件新增
export function extractBeforeAfter(value: unknown): { before: string; after: string } | null {
  if (!isRecord(value)) {
    return null;
  }

  const before = findStringField(value, ["before", "old_string", "oldText", "oldContent"]);
  const after = findStringField(value, ["after", "new_string", "newText", "newContent"]);
  if (before !== undefined && after !== undefined) {
    return { before, after };
  }

  return null;
}

// 结构化 diff 是另一类载荷：type 为 diff 且自带新旧文本，路径可有可无
// [失败路径] 新侧缺失直接判为非 diff，旧侧缺省补空串，非字符串旧值强制转成字符串再参与比较
function extractStructuredDiffBlock(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  if (!isRecord(value) || value.type !== "diff" || typeof value.newText !== "string") {
    return null;
  }

  return {
    path: typeof value.path === "string" && value.path.trim() ? value.path : undefined,
    oldText:
      typeof value.oldText === "string"
        ? value.oldText
        : value.oldText == null
          ? ""
          : String(value.oldText),
    newText: value.newText,
  };
}

// 先按单对象匹配，再下探一层 content 数组，适配消息把 diff 包在内容块里的形态
// 只下探一层是刻意的，载荷结构由本地协议固定，深层递归只会放大异常输入的攻击面
export function extractStructuredDiff(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  const directDiff = extractStructuredDiffBlock(value);
  if (directDiff) {
    return directDiff;
  }

  if (!isRecord(value) || !Array.isArray(value.content)) {
    return null;
  }

  for (const item of value.content) {
    const diff = extractStructuredDiffBlock(item);
    if (diff) {
      return diff;
    }
  }

  return null;
}

// 统一按 LF 切分并保留行内回车，让前后文本共享同一把尺子，比较结果才可解释
// [权衡] 在此剥离 CRLF 会改变行内容，用户看到的 diff 与实际文件字节不一致
function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

// 无上下文模式使用整文件范围，完整侧从 1 起算，空侧写作 0,0 表示不占行
// [失败路径] 空侧若写成 1,0 会被解析器当成非法范围并丢弃整个 hunk
function formatDiffRange(lineCount: number): string {
  return lineCount === 0 ? "0,0" : `1,${lineCount}`;
}

// 上下文模式下范围起点来自切片偏移，需要加 1 转成 unified diff 的 1 基行号
// 行数为 0 时只给起点与 0，表示该侧在窗口内不占行，而不是省略范围
function formatDiffRangeFromSliceStart(startIndex: number, lineCount: number): string {
  if (lineCount === 0) {
    return `${startIndex},0`;
  }

  return `${startIndex + 1},${lineCount}`;
}

// 先吃掉公共前缀能把绝大多数未改动区域排除在 LCS 之外，是正方形复杂度的第一道降维
// 逐行严格相等比较，不做任何归一化，空白差异必须如实体现在 diff 里
function countSharedPrefix(beforeLines: readonly string[], afterLines: readonly string[]): number {
  const maxLength = Math.min(beforeLines.length, afterLines.length);
  let index = 0;
  while (index < maxLength && beforeLines[index] === afterLines[index]) {
    index += 1;
  }
  return index;
}

// 后缀扫描上界要减去已匹配前缀，防止前后缀在中间重叠导致负长度切片
// 从两端向中间推进，一旦不相等立刻停止，保证得到最长公共后缀
function countSharedSuffix(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  sharedPrefixCount: number,
): number {
  const maxLength = Math.min(beforeLines.length, afterLines.length) - sharedPrefixCount;
  let offset = 0;
  while (
    offset < maxLength &&
    beforeLines[beforeLines.length - 1 - offset] === afterLines[afterLines.length - 1 - offset]
  ) {
    offset += 1;
  }
  return offset;
}

// 每一行必须带显式前导标记，空格代表上下文，加减号分别代表新旧两侧
// 空行也会变成单个标记字符，diff 文法里空行不能直接写成空字符串
// 用展开传参而不是逐个 push，长列表在引擎里通常更快，也少一次下标维护
function appendLinesWithPrefix(
  patchLines: string[],
  prefix: " " | "+" | "-",
  lines: readonly string[],
): void {
  patchLines.push(...lines.map((line) => `${prefix}${line}`));
}

// 为每行建出现次数与首次下标，出现超过一次的行没有唯一位置，不能当锚点
// [权衡] 用两张表换线性统计，比排序后逐个比对更省比较，但会多占一份行文本引用
function collectUniqueLineMatches(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): LineMatch[] {
  const beforeOccurrences = new Map<string, { count: number; firstIndex: number }>();
  const afterOccurrences = new Map<string, { count: number; firstIndex: number }>();

  for (let index = 0; index < beforeLines.length; index += 1) {
    const line = beforeLines[index]!;
    const existing = beforeOccurrences.get(line);
    if (existing) {
      existing.count += 1;
      continue;
    }
    beforeOccurrences.set(line, { count: 1, firstIndex: index });
  }

  for (let index = 0; index < afterLines.length; index += 1) {
    const line = afterLines[index]!;
    const existing = afterOccurrences.get(line);
    if (existing) {
      existing.count += 1;
      continue;
    }
    afterOccurrences.set(line, { count: 1, firstIndex: index });
  }

  const matches: LineMatch[] = [];
  for (const [line, beforeOccurrence] of beforeOccurrences) {
    const afterOccurrence = afterOccurrences.get(line);
    if (beforeOccurrence.count !== 1 || afterOccurrence?.count !== 1) {
      continue;
    }
    matches.push({
      beforeIndex: beforeOccurrence.firstIndex,
      afterIndex: afterOccurrence.firstIndex,
    });
  }

  matches.sort((left, right) => left.beforeIndex - right.beforeIndex);
  return matches;
}

// 在旧侧下标递增的前提下求新侧下标的最长递增子序列，得到两边顺序一致的锚点链
// 耐心排序维护每堆的最小尾元素，二分查找插入位置，整体是 n log n 而非动态规划的平方
// predecessors 记录每个锚点的前驱，回溯后反转即得从前往后的锚点序列
// [失败路径] 无锚点时返回空数组，调用方据此退回整段全删全加，不会拿到半截结果
function findIncreasingAnchorMatches(matches: readonly LineMatch[]): LineMatch[] {
  if (matches.length === 0) {
    return [];
  }

  const predecessors = Array<number>(matches.length).fill(-1);
  const pileTops: number[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    let low = 0;
    let high = pileTops.length;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const currentTop = pileTops[middle]!;
      if (matches[currentTop]!.afterIndex < match.afterIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    if (low > 0) {
      predecessors[index] = pileTops[low - 1]!;
    }
    pileTops[low] = index;
  }

  const anchors: LineMatch[] = [];
  let currentIndex = pileTops[pileTops.length - 1]!;
  while (currentIndex >= 0) {
    anchors.push(matches[currentIndex]!);
    currentIndex = predecessors[currentIndex] ?? -1;
  }

  return anchors.reverse();
}

function appendDiffBodyWithLargeSegmentFallback(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  // [资源] 超限区间不再建表，改用唯一行锚点把大段切成若干小段分别递归
  // [权衡] 锚点必须唯一，重复行多的大文件会退化成全删全加，这是为避免错误配对而接受的精度损失
  const anchors = findIncreasingAnchorMatches(collectUniqueLineMatches(beforeLines, afterLines));

  if (anchors.length === 0) {
    // 之前大区间直接整块退化成“全删再全加”，
    // 像 cli.ts 这种前后各插几行、但跨度很远的场景，会把整段未改内容误渲染成红绿大块。
    // 这里优先用唯一行锚点把大区间拆成多个小段，再递归回到正常 diff，尽量保留真实 hunk 边界。
    appendLinesWithPrefix(patchLines, "-", beforeLines);
    appendLinesWithPrefix(patchLines, "+", afterLines);
    return;
  }

  let previousBeforeIndex = 0;
  let previousAfterIndex = 0;

  // 逐段输出锚点之间的差异，锚点行单独按上下文写出，不参与比较
  // 游标只在上一次锚点下标上加一，保证每段切片左闭右开且互不重叠
  for (const anchor of anchors) {
    appendDiffBody(
      patchLines,
      beforeLines.slice(previousBeforeIndex, anchor.beforeIndex),
      afterLines.slice(previousAfterIndex, anchor.afterIndex),
    );
    patchLines.push(` ${beforeLines[anchor.beforeIndex]!}`);
    previousBeforeIndex = anchor.beforeIndex + 1;
    previousAfterIndex = anchor.afterIndex + 1;
  }

  appendDiffBody(
    patchLines,
    beforeLines.slice(previousBeforeIndex),
    afterLines.slice(previousAfterIndex),
  );
}

function appendDiffBodyWithLcs(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  // 纯新增与纯删除必须在建表之前短路，否则空矩阵会让回溯逐行退化，白付建表代价
  // [失败路径] 两个方向都要显式返回，漏掉一侧会把空数组当成待比较行，输出空 hunk
  if (beforeLines.length === 0) {
    appendLinesWithPrefix(patchLines, "+", afterLines);
    return;
  }

  if (afterLines.length === 0) {
    appendLinesWithPrefix(patchLines, "-", beforeLines);
    return;
  }

  // [资源] 先算规模再分配，超出上限直接走锚点退化，避免超限输入把内存打满
  // 退化结果仍是合法 unified diff，只是粒度变粗，调用方无需感知
  if (beforeLines.length * afterLines.length > MAX_DIFF_LCS_CELLS) {
    appendDiffBodyWithLargeSegmentFallback(patchLines, beforeLines, afterLines);
    return;
  }

  // 矩阵多一行一列作为哨兵边界，状态转移在末行末列可直接取 0 而不必判越界
  // 从右下角倒推填表，格子值表示旧侧某位置起与新侧某位置起的最长公共子序列长度
  // [权衡] 用二维数组换常数时间访问，若要省内存可只留两行，但回溯就失去还原配对的能力
  const lcs = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0),
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex]![afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? (lcs[beforeIndex + 1]![afterIndex + 1] ?? 0) + 1
          : Math.max(
              lcs[beforeIndex + 1]![afterIndex] ?? 0,
              lcs[beforeIndex]![afterIndex + 1] ?? 0,
            );
    }
  }

  // 正向回溯：相等就输出上下文，任一侧耗尽就输出另一侧剩余，直到两侧同时走完
  // 不相等时比较跳过新侧与跳过旧侧的得分，分数高的一侧先让行，保证输出顺序稳定
  // [权衡] 平局时优先输出新侧，让新增行排在删除行之前，与 Git 默认观感一致
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    const beforeLine = beforeLines[beforeIndex];
    const afterLine = afterLines[afterIndex];

    if (beforeLine !== undefined && afterLine !== undefined && beforeLine === afterLine) {
      patchLines.push(` ${beforeLine}`);
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (beforeLine === undefined && afterLine !== undefined) {
      patchLines.push(`+${afterLine}`);
      afterIndex += 1;
      continue;
    }

    if (afterLine === undefined && beforeLine !== undefined) {
      patchLines.push(`-${beforeLine}`);
      beforeIndex += 1;
      continue;
    }

    const skipAfterScore = lcs[beforeIndex]![afterIndex + 1] ?? -1;
    const skipBeforeScore = lcs[beforeIndex + 1]![afterIndex] ?? -1;

    if (afterLine !== undefined && skipAfterScore >= skipBeforeScore) {
      patchLines.push(`+${afterLine}`);
      afterIndex += 1;
      continue;
    }

    if (beforeLine !== undefined) {
      patchLines.push(`-${beforeLine}`);
      beforeIndex += 1;
    }
  }
}

// 保留这层薄封装，让上层只依赖一个策略入口，日后替换算法不必改调用点
// 当前策略固定为 LCS 加锚点退化，封装层不做缓存也不持有状态
function appendDiffBody(
  patchLines: string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): void {
  appendDiffBodyWithLcs(patchLines, beforeLines, afterLines);
}

export function buildUnifiedDiff(
  before: string,
  after: string,
  fileLabel: string,
  options?: {
    contextLines?: number;
  },
): string | null {
  // 上下文行数只接受有限非负数，其余值一律视为未开启上下文模式
  // [失败路径] 传 NaN 或负数会让范围计算出现小数与非正长度，这里向下取整并夹到 0
  const contextLines = options?.contextLines;
  const hasContextLimit =
    typeof contextLines === "number" && Number.isFinite(contextLines) && contextLines >= 0;
  const normalizedContextLines = hasContextLimit ? Math.max(0, Math.floor(contextLines)) : 0;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const sharedPrefixCount = countSharedPrefix(beforeLines, afterLines);
  const sharedSuffixCount = countSharedSuffix(beforeLines, afterLines, sharedPrefixCount);
  // 中间区间是唯一需要跑比较的部分，两端公共区在输出时按上下文行数截取
  // 前后缀计数保证不重叠，因此中间区间长度恒为非负，切片不会静默丢内容
  const beforeMiddle = beforeLines.slice(sharedPrefixCount, beforeLines.length - sharedSuffixCount);
  const afterMiddle = afterLines.slice(sharedPrefixCount, afterLines.length - sharedSuffixCount);
  // 空旧侧与空新侧是语义完全不同的两种极端，必须显式区分才能写对文件头
  // 两侧都空则既非新建也非删除，输出空 hunk，是否展示由上层决定
  const isCreatedFile = beforeLines.length === 0 && afterLines.length > 0;
  const isDeletedFile = beforeLines.length > 0 && afterLines.length === 0;

  const limitedPrefixCount = hasContextLimit
    ? Math.min(sharedPrefixCount, normalizedContextLines)
    : sharedPrefixCount;
  const limitedSuffixCount = hasContextLimit
    ? Math.min(sharedSuffixCount, normalizedContextLines)
    : sharedSuffixCount;

  const beforeSliceStart = sharedPrefixCount - limitedPrefixCount;
  const afterSliceStart = sharedPrefixCount - limitedPrefixCount;
  const beforeRangeLineCount = limitedPrefixCount + beforeMiddle.length + limitedSuffixCount;
  const afterRangeLineCount = limitedPrefixCount + afterMiddle.length + limitedSuffixCount;

  // 文件头四行是解析器的切分依据，顺序固定为 diff 行、旧侧、新侧、hunk 头
  // hunk 头在上下文模式下按截断后的范围书写，否则按整文件范围书写
  // 拼接顺序与切片来源严格对应，前后缀都取自旧侧文本，避免新旧侧混用的隐性错位
  const patchLines = [
    // 仅有 `---/+++` 文件头时，删除一行 SQL 注释（`-- ...`）会生成 `--- ...` 正文。
    // @pierre/diffs 按该前缀切分 unified diff，会把正文误判为第二个文件并让 FileDiff 崩溃。
    // 补上 Git 文件边界后，解析器只按 `diff --git` 切分，正文不再参与文件数量判断。
    `diff --git a/${fileLabel} b/${fileLabel}`,
    // 新建文件之前会被输出成 --- a/file + @@ -0,0，PatchDiff 会把它当成
    // 普通 rename/change diff 处理；大文件新增时右侧面板可能在行映射和高亮里卡死。
    // 标准 unified diff 应该用 /dev/null 表示不存在的一侧，让解析器走新增/删除语义。
    isCreatedFile ? "--- /dev/null" : `--- a/${fileLabel}`,
    isDeletedFile ? "+++ /dev/null" : `+++ b/${fileLabel}`,
    hasContextLimit
      ? `@@ -${formatDiffRangeFromSliceStart(beforeSliceStart, beforeRangeLineCount)} +${formatDiffRangeFromSliceStart(afterSliceStart, afterRangeLineCount)} @@`
      : `@@ -${formatDiffRange(beforeLines.length)} +${formatDiffRange(afterLines.length)} @@`,
  ];

  // 消息摘要/Git pane 在 context 模式下只需要“改动附近”窗口。
  // 之前即使只看 3 行上下文，也会先把整份 shared prefix/suffix 塞进 patch 再 trim，
  // 大文件（如 1500+ 行 Dockerfile）点展开时会在主线程做大量无效字符串拼接，导致界面卡死。
  // 这里先按 context 截断前后公共区，再交给 trimPatchContext 做最终 hunk 规整。
  patchLines.push(
    ...beforeLines
      // 公共前缀只回放限定行数，越靠近改动点越重要，远端上下文对定位没有帮助
      // [资源] 先截断再拼接，避免把上千行前缀先压进 patch 再交给裁剪
      .slice(sharedPrefixCount - limitedPrefixCount, sharedPrefixCount)
      .map((line) => ` ${line}`),
  );
  appendDiffBody(patchLines, beforeMiddle, afterMiddle);
  if (limitedSuffixCount > 0) {
    // 后缀窗口同样受上下文上限约束，取公共后缀的最前若干行而不是最后若干行
    // [权衡] 为空时跳过拼接，省掉一次数组展开，代价是多一个条件分支
    patchLines.push(
      ...beforeLines
        .slice(
          beforeLines.length - sharedSuffixCount,
          beforeLines.length - sharedSuffixCount + limitedSuffixCount,
        )
        .map((line) => ` ${line}`),
    );
  }

  // 先整体拼接再交给裁剪库，因为 @pierre/diffs 的上下文裁剪以完整 patch 文本为输入
  // [权衡] 已手工截断前后缀，这里再裁剪一次会有重复遍历，但能保证 hunk 头与行数始终一致
  const patch = patchLines.join("\n");
  if (hasContextLimit) {
    // 关键业务逻辑：上一轮更改使用整份 before/after 快照构造 patch。
    // 如果直接把整份 patch 交给预览器，像“大文件只改 1~2 行”这种场景会整页铺满，
    // 用户很难第一眼定位修改点。这里统一裁成“变更附近 + 固定上下文行数”的 diff，
    // 让消息摘要和 Git 面板都优先服务定位问题，而不是回放整份文件。
    return trimPatchContext(patch, normalizedContextLines);
  }

  return patch;
}
