// INV-01 只读提取：本模块不执行命令、不读文件，只对命令文本做静态解析；守住 collectBashReadFileSources 与 selectReadContent 的纯函数位置；改错故障＝引入真实 I/O 后解析结果依赖运行时状态，无法复现也无法单测。
// INV-02 禁止乐观回填：任何拿不准的写法都返回空数组，绝不猜测“读过”；守住每个提前返回的空数组分支；改错故障＝Edit/Write 的 read-before-write 被伪造绕过，模型可能覆盖从未读过的内容。
// INV-03 单命令边界：出现管道或重定向即整体放弃；守住 collectBashReadFileSources 入口的字符预检；改错故障＝模型只看到被截断或改写后的输出，却被记为已读全文。
// INV-04 权限闸门：来源必须来自权限安全且不含重定向的命令；守住 isBashCommandPermissionSafe 与 hasRedirects 的联合判断；改错故障＝被审批拒绝的危险命令仍能改变已读状态。
// INV-05 命令数非零：analysis.commands 为空时提前返回；守住 commands.length 的判空位置；改错故障＝空命令被当作解析成功，上层拿到空来源却认为流程正常。
// INV-06 顺序短路：sed、cat、head、tail、grep 依次尝试，命中即 continue；守住循环内的空值合并顺序；改错故障＝同一命令被多个解析器重复认领，产生重复或错位的行范围。
// INV-07 grep 单命令限制：仅当 commands.length 等于 1 才解析 grep；守住三元条件的位置；改错故障＝多命令场景下的 grep 命中行被当成整文件已读。
// INV-08 白名单忽略：多命令时只有 echo/printf/true/: 可作为标签行跳过；守住 SIMPLE_IGNORED_COMMAND_RE 分支；改错故障＝未知命令被静默忽略，读范围被高估。
// INV-09 未知即放弃：既不产生来源也不在白名单内的命令立即返回空数组；守住循环末尾的失败返回；改错故障＝部分解析成功后继续累积，返回残缺来源集合。
// INV-10 tail 语义：tailLines 存在时按文件尾部倒推 offset；守住 selectReadContent 中该分支的判定优先级；改错故障＝tail 与行区间同时存在时行号错位。
// INV-11 尾空行去除：split 产生的末尾空元素必须弹出；守住 selectReadContent 的弹栈逻辑；改错故障＝以换行结尾的文件整体偏移一行，offset 与 limit 全部算错。
// INV-12 越界即未读：起始行超过文件行数时返回 undefined；守住 start 与总行数的比较；改错故障＝空切片被当作已读，后续 Edit 跳过真实读取。
// INV-13 cat 严格形态：只接受 -n/--number 与唯一文件路径；守住 parseCatSource 的参数循环；改错故障＝多文件 cat 只回填其中一个，其余文件被误判已读。
// INV-14 head/tail 计数白名单：只认 -n/-N/--lines= 这几种写法，其它 flag 放弃；守住 parseHeadTailCount 的分支顺序；改错故障＝按字节读取的命令被当成按行读取，行范围算错。
// INV-15 sed 安全：-i/--in-place 与 -e/--expression 一律拒绝；守住 parseSedPrintSource 的 flag 判断；改错故障＝就地改写的文件被记为读过，写入前检查被绕过。
// INV-16 sed 脚本白名单：仅 Np 与 N,Mp 视为纯打印；守住两条正则的匹配顺序；改错故障＝含写命令或跳转的脚本被当作整段读取。
// INV-17 grep 退出码：命中才算读过，requiresExitZero 必须为真；守住 parseGrepSource 的返回对象；改错故障＝零命中命令被回填为已读，掩盖真实未读状态。
// INV-18 通配符拒绝：文件路径含 * ? [ { 时不回填；守住解析器末尾的正则校验；改错故障＝glob 命中多文件时只记录一个路径，其余文件被伪造已读。
//
// 模块职责：把 Bash 命令文本静态映射为“读过哪些文件、读到哪些行”，供 readFileState 回填。
// 状态所有权：本模块不持有任何状态，输入命令字符串、输出只读来源数组，落库写入由 bash-read-file-state.ts 负责。
// 阅读顺序：collectBashReadFileSources → selectReadContent → cat/head/tail/sed/grep 各解析器 → isConcreteFilePath 等校验。
/**
 * 从一条 Bash 命令中提取"模型实际读过的文件"（cat/head/tail/sed -n p/grep），
 * 供 bash-read-file-state.ts 回填 readFileState，满足 Edit/Write 的 read-before-write 语义。
 * 只有无管道/重定向的单命令形态、且参数可完全静态解析时才提取；
 * 任何拿不准的写法都返回空数组——宁可少回填，也不伪造"已读"。
 */

import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
  type BashCommandInvocation,
} from "./bash-command-parser.js";

const DEFAULT_HEAD_LINES = 10;
const DEFAULT_TAIL_LINES = 10;
const SED_RANGE_PRINT_RE = /^(\d+),(\d+)p$/;
const SED_SINGLE_PRINT_RE = /^(\d+)p$/;
const SIMPLE_IGNORED_COMMAND_RE = /^\s*(echo|printf|true|:)\b/;
const GREP_SHORT_FLAGS_RE = /^-[niwxEFGPHh]+$/;
const GREP_CONTEXT_SHORT_RE = /^-[ABC]\d+$/;
const GREP_CONTEXT_LONG_RE = /^--(?:after-context|before-context|context)=\d+$/;
const GREP_ALLOWED_LONG_FLAGS = new Set([
  "--line-number",
  "--ignore-case",
  "--word-regexp",
  "--line-regexp",
  "--extended-regexp",
  "--fixed-strings",
  "--basic-regexp",
  "--perl-regexp",
  "--with-filename",
  "--no-filename",
  "--color=never",
  "--color=auto",
]);

// 对外契约：每个来源至少带一个具体文件路径，其余字段描述“读到了哪一段”。
// tailLines 优先于行区间，selectReadContent 会先判它；两者同时赋值时行区间被忽略。
// requiresExitZero 只对 grep 生效，零命中说明模型没看到内容，不能算已读。
export interface BashReadFileSource {
  filePath: string;
  startLine?: number;
  endLine?: number;
  tailLines?: number;
  requiresExitZero?: boolean;
}

// 返回值携带标准化后的 offset 与 limit，回填方据此记录“读到第几行”。
// 不返回原始命令行也不返回绝对路径，路径归一化由调用方负责。
// offset 与 limit 都是 1-based 行号语义，与 read 工具的展示口径保持一致。
export interface SelectedReadContent {
  content: string;
  offset?: number;
  limit?: number;
}

// 对外主入口：输入原始命令字符串，输出可信的已读来源；空数组即拒绝回填。
// 纯函数、无副作用、无并发共享状态，可以被反复调用或缓存。
// 不做去重与合并：同一文件多次读取会产生多条来源，归并交给下游。
export function collectBashReadFileSources(command: string): BashReadFileSource[] {
  // 出现管道或重定向时模型看到的不是完整文件内容，无法据此声明"已读"。
  // 管道与重定向会让模型只看到被截断或改写后的内容，无法等价于读文件。
  // 先做字符级预检再做完整解析，命中即整体放弃，不尝试识别管道前的那一段。
  // 该预检与后面的 hasRedirects 互为兜底，解析器只认识它建模过的重定向语法。
  if (/[|<>]/.test(command)) return [];
  const analysis = analyzeBashCommand(command);
  // 命令整体必须权限安全且不含重定向；解析失败或复合命令直接放弃。
  // 权限不安全或含重定向的命令整体放弃，来源回填必须建立在“命令被允许执行”之上。
  // hasRedirects 覆盖解析器已建模的重定向语法，与入口字符预检形成两层防线。
  // 该判断位于解析之后、循环之前，保证后续每个命令分片都来自同一条安全命令。
  // 放宽这里会让被审批拒绝的命令仍能改变已读状态，属于安全语义破坏。
  if (!isBashCommandPermissionSafe(analysis) || analysis.hasRedirects) return [];
  if (analysis.commands.length === 0) return [];

  const sources: BashReadFileSource[] = [];
  // 逐命令分片解析，任一非白名单命令无法归类就整体返回空，避免“部分可信”。
  // 解析顺序固定，各解析器靠首个参数自证身份，互不覆盖对方的命令。
  // 命中即跳过本次循环，保证一条命令最多贡献一个来源，防止重复计入。
  for (const commandPart of analysis.commands) {
    // 单命令才解析 grep（管道里的 grep 可能只看到部分行）。
    const source =
      parseSedPrintSource(commandPart) ??
      parseCatSource(commandPart) ??
      parseHeadSource(commandPart) ??
      parseTailSource(commandPart) ??
      (analysis.commands.length === 1 ? parseGrepSource(commandPart) : undefined);
    if (source) {
      sources.push(source);
      continue;
    }
    // 多命令场景下 echo/printf/true 等只是标签行，不影响文件读取判定，可以忽略。
    // 多命令时 echo/printf/true/: 常见于“先打标签再读文件”的组合，可以安全跳过。
    // 该白名单只在命令数大于 1 时生效，单命令的 echo 依然算未知命令并导致放弃。
    // [权衡] SIMPLE_IGNORED_COMMAND_RE 用宽松前缀匹配注册名：宁可把带参数的标签行也认成可忽略，也不漏判一次真实读取。
    if (analysis.commands.length > 1 && SIMPLE_IGNORED_COMMAND_RE.test(commandPart.commandText)) {
      continue;
    }
    return [];
  }
  return sources;
}

// 第二个对外入口：把来源与文件内容合成“模型实际看到的那段文本”。
// 内容由调用方传入，本函数不读盘，保证同一输入必然得到同一结果。
// 返回 undefined 表示内容为空或行范围与内容不相交，调用方必须视为未读。
export function selectReadContent(
  content: string,
  source: BashReadFileSource,
): SelectedReadContent | undefined {
  if (source.tailLines !== undefined) {
    const lines = content.split("\n");
    if (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length === 0) return undefined;
    // tail 的行号从文件末尾倒推，因此 offset 由总行数计算，而不是固定从 1 开始。
    // limit 取请求行数与总行数的较小值，防止 tail 请求超过文件实际长度。
    // offset 由总行数减去 limit 再加一得到，必然落在文件范围内。
    // 把 offset 写成固定 1，会让 tail 被错误放大成“读了整个文件”。
    const limit = Math.min(source.tailLines, lines.length);
    const offset = lines.length - limit + 1;
    return {
      content: lines.slice(offset - 1).join("\n"),
      offset,
      limit,
    };
  }

  if (source.startLine === undefined) {
    return { content };
  }

  const lines = content.split("\n");
  // 起点至少为 1，0 或负值统一夹到首行，避免切片出现反向下标。
  // 终点至少等于起点，保证区间非空；缺省终点时退化为单行读取。
  // 边界夹取集中在切片之前，后续路径不再重复判断，减少遗漏分支。
  const start = Math.max(1, source.startLine);
  const end = Math.max(start, source.endLine ?? start);
  // sed 指定行区间时按 1-based 行号切片；起点超过文件长度说明没有读到任何内容。
  if (start > lines.length) return undefined;
  return {
    content: lines.slice(start - 1, end).join("\n"),
    offset: start,
    limit: end - start + 1,
  };
}

function parseCatSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const argv = commandPart.argv;
  // 只处理 cat，其它命令交给后续解析器，避免一个解析器吞掉多种命令。
  // 循环内只接受 -n/--number，其余 flag 会改变输出形态，必须放弃。
  // 出现第二个路径参数即放弃，多文件 cat 无法确定每个文件各自读到哪一段。
  if (argv[0] !== "cat") return undefined;
  // 只接受 -n/--number 与唯一文件路径；多个文件或其它 flag 无法确定模型实际看到什么。
  let filePath: string | undefined;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) {
      if (arg !== "-n" && arg !== "--number") return undefined;
      continue;
    }
    if (filePath !== undefined) return undefined;
    filePath = arg;
  }
  if (!isConcreteFilePath(filePath)) return undefined;
  return { filePath };
}

function parseHeadSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const parsed = parseHeadTailCount(commandPart.argv, DEFAULT_HEAD_LINES);
  if (!parsed || commandPart.argv[0] !== "head") return undefined;
  return {
    filePath: parsed.filePath,
    startLine: 1,
    endLine: parsed.count,
  };
}

function parseTailSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const parsed = parseHeadTailCount(commandPart.argv, DEFAULT_TAIL_LINES);
  if (!parsed || commandPart.argv[0] !== "tail") return undefined;
  return {
    filePath: parsed.filePath,
    tailLines: parsed.count,
  };
}

function parseHeadTailCount(
  argv: readonly string[],
  defaultCount: number,
): { count: number; filePath: string } | undefined {
  // 只识别 head/tail 的计数写法（-n/-N/--lines=）；其它 flag 一律放弃，避免误判读到的行范围。
  let count: number | undefined;
  let filePath: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-n" || arg === "--lines") {
      const value = argv[++index];
      if (!isPositiveIntegerString(value)) return undefined;
      count = Number(value);
      continue;
    }
    if (arg.startsWith("--lines=")) {
      const value = arg.slice("--lines=".length);
      if (!isPositiveIntegerString(value)) return undefined;
      count = Number(value);
      continue;
    }
    if (/^-n\d+$/.test(arg)) {
      count = Number(arg.slice(2));
      continue;
    }
    if (/^-\d+$/.test(arg)) {
      count = Number(arg.slice(1));
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    if (filePath !== undefined) return undefined;
    filePath = arg;
  }
  if (!isConcreteFilePath(filePath)) return undefined;
  return {
    count: count ?? defaultCount,
    filePath,
  };
}

function parseSedPrintSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const argv = commandPart.argv;
  if (argv[0] !== "sed") return undefined;
  let quiet = false;
  let expression: string | undefined;
  let filePath: string | undefined;

  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) {
      if (arg.startsWith("--")) {
        // -i/--in-place 会改文件，-e/--expression 让脚本来源不唯一，均放弃回填。
        // 就地改写不属于读取，-i 以及带等号的长选项变体必须最优先拒绝。
        // 表达式选项让脚本与位置参数混在一起、来源不唯一，同样直接放弃。
        // 长选项与短选项分开处理，短选项按字符包含判断，覆盖组合写法的情形。
        // 这些判断发生在收集脚本之前，保证后续只解析位置参数形式的表达式。
        if (arg === "--in-place" || arg.startsWith("--in-place=")) return undefined;
        if (arg === "--expression") return undefined;
        if (arg === "--quiet" || arg === "--silent") quiet = true;
      } else {
        if (arg.includes("i")) return undefined;
        if (arg === "-e") return undefined;
        if (arg.includes("n")) quiet = true;
      }
      continue;
    }
    if (expression === undefined) {
      expression = arg;
    } else if (filePath === undefined) {
      filePath = arg;
    } else {
      return undefined;
    }
  }

  if (!quiet || expression === undefined || !isConcreteFilePath(filePath)) return undefined;
  // 只有纯打印脚本（Np 或 N,Mp）才等价于"读了这些行"；其它 sed 脚本可能写文件或输出不完整。
  const rangeMatch = SED_RANGE_PRINT_RE.exec(expression);
  if (rangeMatch) {
    return {
      filePath,
      startLine: Number(rangeMatch[1]),
      endLine: Number(rangeMatch[2]),
    };
  }
  const singleMatch = SED_SINGLE_PRINT_RE.exec(expression);
  if (!singleMatch) return undefined;
  const line = Number(singleMatch[1]);
  return {
    filePath,
    startLine: line,
    endLine: line,
  };
}

function parseGrepSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const argv = commandPart.argv;
  if (argv[0] !== "grep" && argv[0] !== "egrep" && argv[0] !== "fgrep") return undefined;
  let pattern: string | undefined;
  let filePath: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("-") && arg !== "-") {
      if (arg === "-A" || arg === "-B" || arg === "-C") {
        const value = argv[++index];
        if (!isNonNegativeIntegerString(value)) return undefined;
        continue;
      }
      if (
        GREP_CONTEXT_SHORT_RE.test(arg) ||
        GREP_CONTEXT_LONG_RE.test(arg) ||
        GREP_SHORT_FLAGS_RE.test(arg) ||
        GREP_ALLOWED_LONG_FLAGS.has(arg)
      ) {
        continue;
      }
      return undefined;
    }
    if (pattern === undefined) {
      pattern = arg;
    } else if (filePath === undefined) {
      filePath = arg;
    } else {
      return undefined;
    }
  }

  if (pattern === undefined || !isConcreteFilePath(filePath)) return undefined;
  // 模式/路径含通配符时无法确定实际命中的文件，放弃；grep 命中才算读过，故要求 exit 0。
  // 通配符会让 grep 命中多个文件，而来源结构只能表达一个路径，故直接放弃。
  // 该检查放在最后，是因为路径要先通过具体路径校验才有判断意义。
  // grep 只有命中才算看到内容，所以来源带 requiresExitZero，由执行层核对退出码。
  if (/[*?[{]/.test(filePath)) return undefined;
  return {
    filePath,
    requiresExitZero: true,
  };
}

function isConcreteFilePath(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value !== "-";
}

function isPositiveIntegerString(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value) && Number(value) > 0;
}

function isNonNegativeIntegerString(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value);
}
