// 助手特化指令解析器：从模型输出里识别 ::name{...} 片段，输出带有绝对下标的指令记录
// 记录里的 start 指向首个冒号、end 指向右花括号后一位，参数为 null 表示参数段非法而非缺省
// 上层用它做两件事：整段替换或隐藏已完成的指令，以及在流式尾部暂存刚写了一半的协议开头
// 本文件是纯文本扫描，不建 Markdown AST，也不访问 DOM；同一输入必须得到同一输出
//
// INV-01 start 指向首个冒号、end 指向右花括号之后，区间左闭右开；守住位置：extractAssistantDirectives 的 push 分支；改错故障：上层切片多一位或少一位，正文被重复输出或被吞掉一个字符
// INV-02 每次提取都新建起始正则，绝不复用带 g 标志的实例；守住位置：createDirectiveStartPattern 与两个调用点；改错故障：lastIndex 残留会让同一轮里的后续指令被静默跳过
// INV-03 起始匹配带负向零宽断言，禁止从连续冒号中间起匹配；守住位置：createDirectiveStartPattern 的 prefix 常量；改错故障：三冒号写法会被切成两冒号，指令名与冒号数量错配
// INV-04 冒号数量由 options 收窄，默认恰好 2 个，只有显式放开的指令才接受 1 或 3 个；守住位置：minimumColonCount 与 maximumColonCount 的计算；改错故障：严格协议被意外兼容，模型笔误被当成合法指令
// INV-05 consumedUntil 单调右移，已消费区间内的匹配一律跳过；守住位置：extractAssistantDirectives 主循环的 continue 分支；改错故障：重叠或嵌套花括号产出交叠区间，替换时正文被删两次
// INV-06 找不到配对右花括号时返回 -1 并跳过整条候选，不抛异常；守住位置：findDirectiveClosingBrace 的尾部返回；改错故障：流式输出里的半截指令让整个渲染抛错，用户看到空白
// INV-07 引号内的右花括号不参与闭合判定，只有引号外才算闭合；守住位置：findDirectiveClosingBrace 的 quote 非空分支；改错故障：参数值里的花括号提前截断指令，后面的正文被当成参数
// INV-08 反斜杠转义只在引号内部生效，引号外一律按普通字符处理；守住位置：findDirectiveClosingBrace 与 parseQuotedValue；改错故障：反斜杠吞掉下一个引号，字符串边界整体错位
// INV-09 未知转义序列保留反斜杠原样输出；守住位置：parseQuotedValue 的 else 分支；改错故障：Windows 路径被改成无斜杠形式，文件引用直接失效
// INV-10 参数解析失败时整条指令的 parameters 置为 null，绝不返回部分结果；守住位置：parseDirectiveParameters 的所有 return null；改错故障：上层拿到缺字段的对象，误以为用户真的没写该参数
// INV-11 无引号参数值以空白或逗号结束，且长度至少一个字符；守住位置：parseDirectiveParameters 的无引号取值分支；改错故障：空值被当成合法参数，渲染出空引用
// INV-12 同名参数后写覆盖先写，不报错也不合并；守住位置：parameters[name] 的赋值处；改错故障：重复参数被静默拼接，最终取值与模型意图不一致
// INV-13 指令名按原始大小写严格比较，不做归一化；守住位置：escapeRegExp 之后的拼接；改错故障：大小写不同的名称被当成同一条，误伤正常文本
// INV-14 代码围栏必须同字符且闭合标记不短于开启标记才关闭；守住位置：marker 比较分支；改错故障：短反引号或波浪号误关围栏，代码块里的指令泄露到正文
// INV-15 未闭合围栏一直延长到文末；守住位置：fence 非空时的兜底 push；改错故障：流式中段的代码块被当成正文，指令在代码里被执行
// INV-16 行内代码反引号要求等长配对，长度不符时整体跳过；守住位置：markerLength 累加与 indexOf 查找；改错故障：双反引号被单个反引号提前闭合，行内范围错乱
// INV-17 mergeRanges 输出按起点升序且两两不相交；守住位置：mergeRanges 的合并分支；改错故障：受保护区间重复计算，偏移量被放大
// INV-18 前缀判定只看文末连续尾部，遇到普通正文立即放弃；守住位置：findAssistantDirectivePrefixStart 的 suffix 检查；改错故障：正文里时间写法的冒号被误判，后续整段被隐藏
// INV-19 前缀判定命中的最右冒号必须能接完整名称或名称已完整且其后仅剩空白；守住位置：末尾的 isPrefix 返回；改错故障：已完整但没有后续内容的指令漏隐藏，界面上闪现后消失
export interface ParsedAssistantDirective {
  end: number;
  name: string;
  parameters: Readonly<Record<string, string>> | null;
  raw: string;
  start: number;
}

// 受保护区间统一用左闭右开二元组表示，与字符串切片的坐标语义保持一致
// 用数组而非对象是为了排序比较时少一层属性访问，也便于直接解构
export type AssistantTextRange = readonly [start: number, end: number];

// 三个开关都按指令类型单独放开，默认值等于最严格的行为
// 放宽只作用于起始匹配与引号识别，不改变参数语法，避免一处放宽导致全链路失守
export interface AssistantDirectiveSyntaxOptions {
  allowSmartQuotes?: boolean;
  allowSingleColon?: boolean;
  allowTripleColon?: boolean;
}

// 前缀暂存只对白名单里的指令名和最小长度生效，防止把正文冒号当协议残片
// minimumSingleColonPrefixLength 默认 2，短于它的单冒号后缀仍按普通文本显示
export interface AssistantDirectivePrefixOptions {
  minimumSingleColonPrefixLength?: number;
  singleColonDirectiveNames?: readonly string[];
  tripleColonDirectiveNames?: readonly string[];
}

// 指令名来自调用方配置而非输入文本，但仍可能含括号或点号，必须转义后再拼进正则
// [权衡] 每次拼接都重新转义，而不是缓存一份，换来配置热更新时无需失效逻辑
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 起始匹配由负向断言、冒号区间、指令名、可选空白、左花括号拼成，抽出来供两处共用
// 负向断言必须紧贴冒号，否则三冒号的第二个字符起也能匹配，协议会被悄悄放宽
// g 标志让 matchAll 能一次遍历全文，但携带状态的实例不可跨调用复用
// [失败路径] 指令名为空时正则退化成只匹配冒号和花括号，由上层提前拦截，不在这里兜底
function createDirectiveStartPattern(
  directiveName: string,
  options: AssistantDirectiveSyntaxOptions = {},
): RegExp {
  // 模型偶尔把文件引用的双冒号输出成单/三冒号；不能全局放宽，否则
  // code-comment 等协议也会被意外兼容。opt-in 时同时拒绝从连续冒号中间起匹配。
  const minimumColonCount = options.allowSingleColon ? 1 : 2;
  const maximumColonCount = options.allowTripleColon ? 3 : 2;
  // 冒号数量用区间量词而不用枚举分支，避免三个开关组合写出八条分支
  // [权衡] 负向断言只排除前一个冒号，不排除后一个，因为后一个属于本次匹配的冒号串
  const prefix = `(?<!:):{${minimumColonCount},${maximumColonCount}}`;
  return new RegExp(`${prefix}${escapeRegExp(directiveName)}\\s*\\{`, "g");
}

interface DirectiveQuoteState {
  close: string;
  open: string;
}

// 直引号始终接受，成对中文引号仅在 allowSmartQuotes 打开时接受，两者共用开闭表
// [失败路径] 未识别字符返回 null，让调用方按普通字符继续扫描，而不是当作引号开启
function getDirectiveQuoteState(
  character: string | undefined,
  options: AssistantDirectiveSyntaxOptions,
): DirectiveQuoteState | null {
  if (character === '"' || character === "'") {
    return { open: character, close: character };
  }
  // 中文模型输出可能使用成对智能引号；未识别时会退化为未加引号值，
  // 使空格截断路径或把引号字符带入后续文件解析。仅由 citation opt-in，保持其它 directive 严格。
  if (!options.allowSmartQuotes) return null;
  if (character === "“") return { open: character, close: "”" };
  if (character === "‘") return { open: character, close: "’" };
  return null;
}

// 从花括号后一位开始线性扫描，用 quote 与 escaped 两个状态量维持是否处于字符串内
// 只有 quote 为 null 时遇到的右花括号才算闭合，这与参数值可含花括号的语法前提绑定
// 引号内遇到反斜杠只切换下一字符的转义状态，不改变 quote，保证转义引号不结束字符串
// [失败路径] 扫到文末仍未闭合返回 -1，调用方据此区分还没写完与写错了两种情况
function findDirectiveClosingBrace(
  content: string,
  openBraceIndex: number,
  options: AssistantDirectiveSyntaxOptions,
): number {
  let quote: DirectiveQuoteState | null = null;
  let escaped = false;

  for (let index = openBraceIndex + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote.close) {
        quote = null;
      }
      continue;
    }

    const quoteState = getDirectiveQuoteState(character, options);
    if (quoteState) {
      quote = quoteState;
    } else if (character === "}") {
      return index;
    }
  }

  return -1;
}

// 引号内按字符累积，只有配对的开引号、闭引号和反斜杠三种转义被真正消费
// 反斜杠落在末尾时视为普通字符，因为此时没有下一个字符可供转义
// [失败路径] 找不到闭引号返回 null，让整条指令的参数解析一起失败，而不是接收半截取值
function parseQuotedValue(
  source: string,
  start: number,
  quote: DirectiveQuoteState,
): { nextIndex: number; value: string } | null {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === quote.close) return { nextIndex: index + 1, value };
    if (character !== "\\" || index + 1 >= source.length) {
      value += character;
      continue;
    }

    const escapedCharacter = source[index + 1]!;
    if (
      escapedCharacter === quote.open ||
      escapedCharacter === quote.close ||
      escapedCharacter === "\\"
    ) {
      value += escapedCharacter;
    } else {
      // Directive 不是 JSON；未知转义必须保留反斜杠，避免把 Windows 路径改坏。
      value += `\\${escapedCharacter}`;
    }
    index += 1;
  }

  return null;
}

// 参数段用游标推进解析，每一步都重校验边界，任何一处不符合就整体返回 null
// 分隔符同时接受空白与逗号，允许模型在参数之间换行，但不允许两个值之间缺分隔
// 参数名必须先匹配标识符再找等号，顺序反了会把数字开头的前缀吃进名字
// [权衡] 不做回溯重试：解析失败即视为非指令文本，宁可漏识别也不产出错误参数
function parseDirectiveParameters(
  source: string,
  options: AssistantDirectiveSyntaxOptions,
): Record<string, string> | null {
  const parameters: Record<string, string> = {};
  let index = 0;

  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) return parameters;

    const nameMatch = /^[a-zA-Z_][a-zA-Z\d_-]*/.exec(source.slice(index));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    index += name.length;

    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    // 等号前后都允许任意空白，但等号本身不可省略
    // [失败路径] 缺等号说明这段不是参数而是正文，返回 null 交由上层保留原文
    if (source[index] !== "=") return null;
    index += 1;
    while (index < source.length && /\s/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) return null;

    let value: string;
    const quote = getDirectiveQuoteState(source[index], options);
    if (quote) {
      const parsedValue = parseQuotedValue(source, index, quote);
      if (!parsedValue) return null;
      value = parsedValue.value;
      index = parsedValue.nextIndex;
    } else {
      const valueStart = index;
      while (index < source.length && !/[\s,]/.test(source[index] ?? "")) index += 1;
      value = source.slice(valueStart, index);
      if (!value) return null;
    }

    if (index < source.length && !/[\s,]/.test(source[index] ?? "")) return null;
    // 同名参数直接覆盖，保留最后一次出现的值，与常见命令行解析器的直觉一致
    // [权衡] 不抛重复参数错误，因为流式重写时模型可能真的重复输出同一个字段
    parameters[name] = value;
  }

  return parameters;
}

// 对外主入口：单趟遍历产出全部完整指令，顺序与出现位置一致
// 空内容或空指令名直接短路，避免把全文跑一遍正则再丢弃结果
// 每个候选先过 consumedUntil 去重，再查找闭合花括号，这两步的顺序不可交换
// 参数段切片用左花括号加一与闭合下标做边界，右端不含闭合符号本身
// [权衡] 只做一次 matchAll 加若干局部扫描，不构造语法树，代价仅与匹配次数线性相关
export function extractAssistantDirectives(
  content: string,
  directiveName: string,
  options: AssistantDirectiveSyntaxOptions = {},
): ParsedAssistantDirective[] {
  if (!content.trim() || !directiveName.trim()) return [];

  const startPattern = createDirectiveStartPattern(directiveName, options);
  const directives: ParsedAssistantDirective[] = [];
  // 游标记录已消费到的绝对位置，数值等于已 push 的最后一条指令的 end
  // 游标只增不减，保证输出数组天然按位置升序且互不重叠
  let consumedUntil = 0;
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0;
    if (start < consumedUntil) continue;
    const openBraceIndex = start + (match[0]?.lastIndexOf("{") ?? -1);
    if (openBraceIndex < start) continue;

    // 闭合查找从当前候选的左花括号开始，而不是从头重扫，避免重复工作
    // [失败路径] 返回负数说明候选没有完整结构，直接看下一个，不污染已消费区间
    const closingBraceIndex = findDirectiveClosingBrace(content, openBraceIndex, options);
    if (closingBraceIndex < 0) continue;
    const end = closingBraceIndex + 1;
    consumedUntil = end;
    directives.push({
      start,
      end,
      name: directiveName,
      raw: content.slice(start, end),
      parameters: parseDirectiveParameters(
        content.slice(openBraceIndex + 1, closingBraceIndex),
        options,
      ),
    });
  }

  return directives;
}

// 合并前先按起点排序，保证单趟扫描即可吞并重叠或相邻区间
// 相邻区间一并合并，因为调用方只关心某个下标是否落在保护区内
function mergeRanges(ranges: AssistantTextRange[]): AssistantTextRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

// 收集三类不可解析区域：围栏代码块、HTML 的 code 与 pre 元素、行内反引号片段
// 整行扫描先识别围栏，再做行内反引号，顺序保证行内扫描能跳过围栏内部
// [权衡] 用正则近似 HTML 而不引入解析器，代价是嵌套标签可能误判，换来零依赖
export function findMarkdownCodeRanges(content: string): AssistantTextRange[] {
  const ranges: Array<[number, number]> = [];
  const fencedRanges: Array<[number, number]> = [];
  let fence: { character: "`" | "~"; length: number; start: number } | null = null;
  let lineStart = 0;

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf("\n", lineStart);
    const lineEnd = newlineIndex < 0 ? content.length : newlineIndex + 1;
    const line = content.slice(lineStart, newlineIndex < 0 ? content.length : newlineIndex);
    // 围栏标记最多允许三个前导空格，四空格缩进属于代码而非围栏
    // 反引号与波浪号分开记录，闭合时要求同字符，混用是常见的手写错误
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) {
        fence = {
          character: marker[0] as "`" | "~",
          length: marker.length,
          start: lineStart,
        };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fencedRanges.push([fence.start, lineEnd]);
        fence = null;
      }
    }
    lineStart = lineEnd;
  }
  // 流式输出常在围栏未闭合时截断，这里把它一路保护到文末
  // [失败路径] 不补虚拟闭合行，否则范围端点会与原文偏移对不上
  if (fence) fencedRanges.push([fence.start, content.length]);
  ranges.push(...fencedRanges);

  for (const match of content.matchAll(/<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi)) {
    const start = match.index ?? 0;
    ranges.push([start, start + (match[0]?.length ?? 0)]);
  }

  // 判定某下标是否落在围栏内，用线性 some 而非二分，因为围栏数量通常很小
  // [权衡] 该判定在每个字符上调用一次，围栏极多时会退化为平方级，但正常文档不会出现
  const isFenced = (index: number) =>
    fencedRanges.some(([start, end]) => index >= start && index < end);
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "`" || isFenced(index)) continue;
    let markerLength = 1;
    while (content[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const closingIndex = content.indexOf(marker, index + markerLength);
    if (closingIndex < 0 || isFenced(closingIndex)) {
      index += markerLength - 1;
      continue;
    }
    ranges.push([index, closingIndex + markerLength]);
    index = closingIndex + markerLength - 1;
  }

  // 三类区间可能互相重叠，例如围栏里的行内反引号，统一在出口合并成不相交集合
  return mergeRanges(ranges);
}

// 相交公式为起点小于对方终点且终点大于对方起点，端点相接不算重叠
// 端点相接必须视为不重叠，否则紧贴代码块的指令会被误判为受保护而漏识别
export function overlapsAssistantTextRanges(
  start: number,
  end: number,
  ranges: readonly AssistantTextRange[],
): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

// 与提取函数共用起始正则，但目标改为找出像指令开头却没闭合的最后一个位置
// 受保护区间必须提前排除，否则代码块里的协议残片会让整段正文被隐藏
// 候选按出现顺序遍历，后出现的未闭合起点覆盖先出现的，因为流式尾部只关心最后一个
// 四个附加判断共同决定是否隐藏，任何一条不成立都退回显示原文
// [权衡] 只回传单个下标而不是列表，把多段处理的复杂度留给调用方
export function findUnclosedAssistantDirectiveStart(
  content: string,
  directiveName: string,
  protectedRanges: readonly AssistantTextRange[] = [],
  options: AssistantDirectiveSyntaxOptions & {
    isParameterPrefix?: (source: string) => boolean;
  } = {},
): number | null {
  const startPattern = createDirectiveStartPattern(directiveName, options);
  let unclosedStart: number | null = null;
  for (const match of content.matchAll(startPattern)) {
    const start = match.index ?? 0;
    const openBraceIndex = start + (match[0]?.lastIndexOf("{") ?? -1);
    if (
      openBraceIndex < start ||
      overlapsAssistantTextRanges(start, openBraceIndex + 1, protectedRanges)
    ) {
      continue;
    }
    if (findDirectiveClosingBrace(content, openBraceIndex, options) < 0) {
      // 只有仍然符合“参数前缀”的半截 directive 才隐藏。闭合引号后又出现
      // 普通正文时，参数解析会失败，于是保留原文，避免缺失 `}` 把后文吞掉。
      const parameterPrefix = content.slice(openBraceIndex + 1);
      let quote: DirectiveQuoteState | null = null;
      let escaped = false;
      for (const character of parameterPrefix) {
        if (quote !== null) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === quote.close) quote = null;
        } else {
          quote = getDirectiveQuoteState(character, options);
        }
      }
      // 三类证据都算参数前缀：调用方自定义判定、参数解析成功、仍停在引号内
      // 最后一条正则兜住刚敲了一半的参数名或等号这一瞬时态
      // [失败路径] 三者都不成立说明闭合引号后已回到正文，此时保留原文，避免吞掉后文
      const isParameterPrefix =
        options.isParameterPrefix?.(parameterPrefix) === true ||
        parseDirectiveParameters(parameterPrefix, options) !== null ||
        quote !== null ||
        /(?:^|[\s,])[a-zA-Z_][a-zA-Z\d_-]*\s*(?:=\s*)?$/.test(parameterPrefix);
      if (isParameterPrefix) unclosedStart = start;
    }
  }
  return unclosedStart;
}

// 流式渲染专用：只在文末连续尾部寻找可能是指令开头的冒号位置
// [权衡] 从后往前扫并立即返回，省掉收集全部候选的分配，代价是只看到一个起点
/**
 * 流式尾部可能刚开始输出特化 directive 时，先把仍然匹配协议名称前缀的内容暂存。
 * 只检查文末连续尾部，且跳过 Markdown 代码范围；一旦前缀分叉，返回 null 让正文照常显示。
 */
export function findAssistantDirectivePrefixStart(
  content: string,
  directiveNames: readonly string[],
  protectedRanges: readonly AssistantTextRange[] = [],
  options: AssistantDirectivePrefixOptions = {},
): number | null {
  const singleColonNames = new Set(options.singleColonDirectiveNames ?? []);
  const tripleColonNames = new Set(options.tripleColonDirectiveNames ?? []);
  const minimumSingleColonPrefixLength = options.minimumSingleColonPrefixLength ?? 2;

  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index] !== ":") continue;
    if (content[index - 1] === ":") continue;
    if (overlapsAssistantTextRanges(index, index + 1, protectedRanges)) continue;

    const suffix = content.slice(index);
    const isPrefix = directiveNames.some((directiveName) => {
      const canonicalName = `::${directiveName}`;
      const tripleColonName = `:::${directiveName}`;
      if (
        tripleColonNames.has(directiveName) &&
        suffix.startsWith(":::") &&
        (tripleColonName.startsWith(suffix) ||
          (suffix.startsWith(tripleColonName) &&
            /^\s*$/.test(suffix.slice(tripleColonName.length))))
      ) {
        return true;
      }
      if (
        suffix.startsWith("::") &&
        (canonicalName.startsWith(suffix) ||
          (suffix.startsWith(canonicalName) && /^\s*$/.test(suffix.slice(canonicalName.length))))
      ) {
        return true;
      }

      if (!singleColonNames.has(directiveName) || suffix.length < minimumSingleColonPrefixLength) {
        return false;
      }
      const compatibilityName = `:${directiveName}`;
      if (compatibilityName.startsWith(suffix)) return true;
      return (
        suffix.startsWith(compatibilityName) && /^\s*$/.test(suffix.slice(compatibilityName.length))
      );
    });
    // 命中即返回，返回值是该段尾部指令起始冒号的绝对下标
    // 返回位置左侧的文本必须原样输出，因此这里不做任何裁剪
    if (isPrefix) return index;
  }
  return null;
}
