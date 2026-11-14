// INV-01 双语文案：守住位置 英文表与中文表；改错故障：只改一侧导致另一语言缺键或残留旧文案。
// INV-02 类型真源：守住位置 字符串类型的推导；改错故障：中文表多键也通过编译，运行期出现死文案。
// INV-03 格式派生：守住位置 格式名单与空态标题；改错故障：插件未开放的格式仍出现在提示里。
// INV-04 回落策略：守住位置 选表判断；改错故障：未知 language tag 得到空表或直接抛错。
// INV-05 前缀识别：守住位置 语言前缀判断；改错故障：中文繁体落到英文。
// INV-06 标题空格：守住位置 标题末尾补空的正则；改错故障：中文句子里标题与后文粘连。
// INV-07 定位模板：守住位置 定位模板的成对方法；改错故障：句中引用用了大写开头。
// INV-08 解析顺序：守住位置 定位解析的正则分支顺序；改错故障：区间定位被单值分支提前吃掉。
// INV-09 复合定位：守住位置 形状正则；改错故障：幻灯片形状被当成整页。
// INV-10 表格定位：守住位置 单元格的三段捕获；改错故障：单元格被显示成整表。
// INV-11 电子表格切分：守住位置 取最后一个感叹号；改错故障：工作表名内含感叹号时切错位置。
// INV-12 引号还原：守住位置 成对单引号的替换；改错故障：工作表名残留引号。
// INV-13 未知语法：守住位置 末尾原样返回；改错故障：新定位符让渲染抛错。
// INV-14 规模文案：守住位置 文件过大提示的换算；改错故障：单位或上限与契约常量脱节。
// INV-15 错误两段式：守住位置 错误表的元组；改错故障：说明缺失时出现空白行。
// INV-16 插值同构：守住位置 函数型文案的参数表；改错故障：中文插值少参导致占位符残留。
// INV-17 纯函数：守住位置 定位符描述函数；改错故障：依赖外部状态导致同输入不同输出。
// INV-18 文案唯一来源：守住位置 本文件的导出；改错故障：面板各处硬编码文案，本地化失效。
//
// 模块职责：集中定义 office 面板的全部可见文案，并把内部定位符转成人类可读描述。
// 状态所有权：无运行期状态；两份文案表与派生字符串在模块加载时固定。
// 阅读顺序：派生字符串 → 英文真源 → 中文同构 → 类型与选表 → 定位符描述。
/**
 * office 面板的双语文案表与定位符描述。
 *
 * 职责：集中定义面板全部可见文案（英文为真源、中文同构），并把内部 locator 串转成人类可读描述。
 * 口径：格式相关文案由 PROFILE.kinds 派生，插件只开放部分格式时不会出现多余格式名；
 * 中文标题 zhTitle 复用 PROFILE 的 zh-CN 名称，保证与插件自述一致。
 * 失败语义：未知或缺失 locale 一律回落到英文，不抛错、不返回空对象。
 * 不变量：Strings 由 typeof en 推导，zh 必须与之逐键同构；新增文案需同时补两种语言。
 */

import { MAX_FILE_BYTES, DOC_KINDS, extensionList, joinList } from "#office/contract.ts";
import { PROFILE } from "#office/profile.ts";

// 格式显示名：只用于拼给用户看的句子，不参与协议或文件类型判断。
// 能力查询的语法糖表示某格式是否开放，可选中文本段落的格式才允许段落文案。
// 中文标题在末尾补一个字符宽度的空格，让句子里标题与正文之间留白。
//
const FORMAT_NAMES = { docx: "Word", xlsx: "Excel", pptx: "PowerPoint", pdf: "PDF" } as const;
const formats = DOC_KINDS.map((kind) => FORMAT_NAMES[kind]);
const has = (kind: (typeof DOC_KINDS)[number]) => DOC_KINDS.includes(kind);
const passage = has("docx") || has("pdf");
/** What the user can select, e.g. "any passage, cell or slide". */
const selectable = {
  en: `any ${joinList(
    [
      ...(passage ? ["passage"] : []),
      ...(has("xlsx") ? ["cell"] : []),
      ...(has("pptx") ? ["slide"] : []),
    ],
    "en",
    "or",
  )}`,
  zh: joinList(
    [
      ...(passage ? ["段落"] : []),
      ...(has("xlsx") ? ["单元格"] : []),
      ...(has("pptx") ? ["幻灯片"] : []),
    ],
    "zh-CN",
    "or",
  ),
};
/** The panel title as the start of a Chinese sentence: "Office 文档", or "PDF " before Chinese text. */
const zhTitle = PROFILE.title["zh-CN"].replace(/[\x20-\x7e]$/, "$& ");

// 英文真源：键集与类型由此推导，新增文案必须先加到这里。
// 错误表每项是标题与说明两段，空串表示只有标题。
// where 里的定位模板成对出现：pageLower 用于句中，page 用于句首。
//
const en = {
  title: PROFILE.title.en,
  openTitle: "Open a document",
  openFile: "Open file",
  emptyTitle: `Open your ${joinList(formats)} file`,
  emptyDescription: `Read alongside your conversation and discuss ${selectable.en}.`,
  emptyCaption: `Choose a local file · ${extensionList("en", "or")}`,
  importing: "Importing…",
  importTooLarge: `Choose a file no larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB.`,

  recent: "Recent",
  switchDocument: "Switch document",
  pagesAndOutline: "Pages and outline",
  outlineOnly: "Outline",
  pages: "Pages",
  slides: "Slides",
  outline: "Outline",
  find: "Find",
  findPlaceholder: "Find in document",
  findCount: (index: number, total: number) => `${index} of ${total}`,
  noResults: "No results",
  previousMatch: "Previous match (⇧Enter)",
  nextMatch: "Next match (Enter)",
  closeFind: "Close (Esc)",
  more: "More",
  fitWidth: "Fit width",
  fitPage: "Fit page",
  actualSize: "Actual size",
  reload: "Reload from disk",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageNumber: "Page number",
  ofPages: (count: number) => `of ${count}`,
  zoomIn: "Zoom in (⌘+)",
  zoomOut: "Zoom out (⌘−)",
  fit: "Fit",
  addToChat: "Add to chat",
  addShort: "Add",
  addToChatHint: "Attach this to your next message (⌘/Ctrl+Enter)",
  added: "Added to chat",
  ask: "Ask",
  askPlaceholder: "Ask about this…",
  send: "Send",
  cancel: "Cancel",
  sendKey: "send",
  cancelKey: "cancel",
  copy: "Copy",
  copied: "Copied",
  agent: "Agent",
  agentOf: (index: number, total: number) => `Agent · ${index} of ${total}`,
  nextTarget: "Next",
  moreOn: (count: number, label: string) => (count === 1 ? `1 more on ${label}` : `${count} more`),
  close: "Close",
  changed: "This file changed on disk.",
  reloadShort: "Reload",
  dismiss: "Dismiss",
  openAnother: "Open another file",
  sidePanel: "Open in side panel",
  meta: {
    pdf: (n: number) => (n === 1 ? "1 page" : `${n} pages`),
    pptx: (n: number) => (n === 1 ? "1 slide" : `${n} slides`),
    xlsx: (n: number) => (n === 1 ? "1 sheet" : `${n} sheets`),
    docx: (_n: number) => "",
  },
  errors: {
    generic: ["Couldn’t open this document", ""],
    password: [
      "This PDF is password protected",
      `${PROFILE.title.en} can’t open encrypted files yet.`,
    ],
    not_found: ["This file no longer exists", "It may have been moved or deleted."],
    file_too_large: ["This file is too large to open", ""],
    corrupt_file: [
      "This file appears to be damaged",
      `${PROFILE.title.en} couldn’t read its contents.`,
    ],
    unsupported_type: [
      "This kind of file isn’t supported",
      `${PROFILE.title.en} opens ${extensionList()} files.`,
    ],
    path_outside_workspace: ["This file is outside the workspace", ""],
  // errors 用 Record 宽类型标注，错误码由服务端扩展时无需同步改类型。
  // 值固定为两元组，第一项是标题，第二项是说明，渲染层按位取用。
  // 标题单独成行，说明可省略为空串。
  //
  } as Record<string, [string, string]>,
  sendFailed: "The message was not sent.",
  contextFailed: "ZCode did not accept the reference.",
  where: {
    page: (n: string) => `Page ${n}`,
    pages: (a: string, b: string) => `Pages ${a}–${b}`,
    pageLower: (n: string) => `page ${n}`,
    slide: (n: string) => `Slide ${n}`,
    slides: (a: string, b: string) => `Slides ${a}–${b}`,
    slideLower: (n: string) => `slide ${n}`,
    shape: (n: string) => `Slide ${n} · Shape`,
    paragraph: (n: string) => `Paragraph ${n}`,
    paragraphs: (a: string, b: string) => `Paragraphs ${a}–${b}`,
    paragraphLower: (n: string) => `paragraph ${n}`,
    table: (n: string) => `Table ${n}`,
    cell: (n: string, row: string, col: string) => `Table ${n} · R${row}C${col}`,
  },
};

// 中文同构：类型直接标注为英文表的类型，缺键或多键都会编译失败。
// 插值函数保持与英文相同的参数个数，文案内容可以自由改写。
// zh-CN 文案自行处理全角标点与空格，避免复用 en 拼接时混入半角空格。
//
const zh: typeof en = {
  title: PROFILE.title["zh-CN"],
  openTitle: "打开文档",
  openFile: "打开文件",
  emptyTitle: `打开你的 ${joinList(formats, "zh-CN")} 文件`,
  emptyDescription: `边看边聊，选中${selectable.zh}即可带入对话。`,
  emptyCaption: `选择本地文件 · ${extensionList("zh-CN", "or")}`,
  importing: "正在导入…",
  importTooLarge: `请选择不超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB 的文件。`,

  recent: "最近",
  switchDocument: "切换文档",
  pagesAndOutline: "页面与目录",
  outlineOnly: "目录",
  pages: "页面",
  slides: "幻灯片",
  outline: "目录",
  find: "查找",
  findPlaceholder: "在文档中查找",
  findCount: (index, total) => `${index} / ${total}`,
  noResults: "无结果",
  previousMatch: "上一个（⇧Enter）",
  nextMatch: "下一个（Enter）",
  closeFind: "关闭（Esc）",
  more: "更多",
  fitWidth: "适应宽度",
  fitPage: "适应页面",
  actualSize: "实际大小",
  reload: "从磁盘重新加载",
  previousPage: "上一页",
  nextPage: "下一页",
  pageNumber: "页码",
  ofPages: (count) => `/ ${count}`,
  zoomIn: "放大（⌘+）",
  zoomOut: "缩小（⌘−）",
  fit: "适应",
  addToChat: "添加到对话",
  addShort: "添加",
  addToChatHint: "附加到下一条消息（⌘/Ctrl+Enter）",
  added: "已添加到对话",
  ask: "提问",
  askPlaceholder: "就这里提问…",
  send: "发送",
  cancel: "取消",
  sendKey: "发送",
  cancelKey: "取消",
  copy: "复制",
  copied: "已复制",
  agent: "Agent",
  agentOf: (index, total) => `Agent · 第 ${index} 处，共 ${total} 处`,
  nextTarget: "下一处",
  moreOn: (count, label) => (count === 1 ? `${label}还有 1 处` : `还有 ${count} 处`),
  close: "关闭",
  changed: "文件已在磁盘上更改。",
  reloadShort: "重新加载",
  dismiss: "忽略",
  openAnother: "打开其他文件",
  sidePanel: "在侧栏打开",
  meta: {
    pdf: (n) => `${n} 页`,
    pptx: (n) => `${n} 张幻灯片`,
    xlsx: (n) => `${n} 个工作表`,
    docx: () => "",
  },
  errors: {
    generic: ["无法打开该文档", ""],
    password: ["该 PDF 受密码保护", `${zhTitle}暂不支持打开加密文件。`],
    not_found: ["该文件已不存在", "它可能已被移动或删除。"],
    file_too_large: ["文件太大，无法打开", ""],
    corrupt_file: ["该文件似乎已损坏", `${zhTitle}无法读取其内容。`],
    unsupported_type: ["不支持这种文件", `${zhTitle}可以打开 ${extensionList("zh-CN")} 文件。`],
    path_outside_workspace: ["该文件不在工作区内", ""],
  },
  sendFailed: "消息未发送。",
  contextFailed: "ZCode 未接受该引用。",
  where: {
    page: (n) => `第 ${n} 页`,
    pages: (a, b) => `第 ${a}–${b} 页`,
    pageLower: (n) => `第 ${n} 页`,
    slide: (n) => `第 ${n} 张幻灯片`,
    slides: (a, b) => `第 ${a}–${b} 张幻灯片`,
    slideLower: (n) => `第 ${n} 张幻灯片`,
    shape: (n) => `第 ${n} 张幻灯片 · 形状`,
    paragraph: (n) => `第 ${n} 段`,
    paragraphs: (a, b) => `第 ${a}–${b} 段`,
    paragraphLower: (n) => `第 ${n} 段`,
    table: (n) => `表格 ${n}`,
    cell: (n, row, col) => `表格 ${n} · R${row}C${col}`,
  },
};

/** 面板文案的类型契约：直接由英文真源推导，新增键必须先加到 en 才会被编译器要求同步到 zh。 */
// 类型契约：由英文表推导，是外部引用文案表的唯一类型入口。
// strings 只看 locale 前缀，zh / zh-CN / zh-TW 会归入中文，其余则回落 en。
// 不做缺键合并：两份表结构由类型系统保证一致，运行期无需兜底。
//
export type Strings = typeof en;
/**
 * 按 locale 选文案表。
 * 规则：仅以 "zh" 前缀识别中文（zh、zh-CN、zh-TW 都归入中文），其余（含 undefined）回落英文。
 * 失败语义：不抛错、不做缺键合并——两份表结构由类型系统保证一致，运行期无需兜底。
 */
export const strings = (locale: string | undefined): Strings =>
  locale?.toLowerCase().startsWith("zh") ? zh : en;

// 把定位符转成人类可读文本：page/slide/p/shape 与 xlsx 的 Sheet!Range 各有对应模板。
// lower=true 用于句中引用（"on page 3"），否则用大写开头（"Page 3"）；无法识别的定位符原样返回。
// 纯函数，只读入参；不抛错，未知语法不会中断渲染。
/** A locator as people say it: `page:3` → "Page 3", `Plan!C2:D2` → "Plan · C2:D2". */
// 定位符描述：把内部定位串翻译成人类可读文本，纯函数只读入参。
// 匹配顺序从具体到宽泛，先试区间与复合形式，再试单值，最后退回原串。
// 小写开关只影响单值模板，未知语法原样返回而不抛错。
// 定位串由面板自身定义，新语法要先在 describeAt 登记模板再对外使用。
//
export function describeAt(at: string, t: Strings, lower = false): string {
  const w = t.where;
  let match: RegExpExecArray | null;
  // 页码与页区间：有第二捕获组时走区间模板，否则按大小写取单页模板。
  // 幻灯片与段落采用同一套区间判定，形状定位在区间判定之前先被截获。
  // 表格定位分 w.cell 与 w.table 两支，先试三段正则捕获再退回单值。
  // 页区间用连字符连接，单页不带连字符。
  //
  if ((match = /^page:(\d+)(?:-(\d+))?$/.exec(at)))
    return match[2]
      ? w.pages(match[1], match[2])
      : lower
        ? w.pageLower(match[1])
        : w.page(match[1]);
  if ((match = /^slide:(\d+)\/shape:/.exec(at))) return w.shape(match[1]);
  if ((match = /^slide:(\d+)(?:-(\d+))?$/.exec(at)))
    return match[2]
      ? w.slides(match[1], match[2])
      : lower
        ? w.slideLower(match[1])
        : w.slide(match[1]);
  if ((match = /^p:(\d+)(?:-(\d+))?$/.exec(at)))
    return match[2]
      ? w.paragraphs(match[1], match[2])
      : lower
        ? w.paragraphLower(match[1])
        : w.paragraph(match[1]);
  if ((match = /^t:(\d+)\/r(\d+)c(\d+)$/.exec(at))) return w.cell(match[1], match[2], match[3]);
  if ((match = /^t:(\d+)$/.exec(at))) return w.table(match[1]);
  // Spreadsheet: Sheet!A1[:B2], with an optionally quoted sheet name.
  // 电子表格定位：取最后一个感叹号切分工作表名与区域，避免名字含感叹号时切错。
  // 工作表名两侧的单引号成对剥离，内部两个单引号还原为一个。
  // 区域部分如 Sheet!A1:B2 的右半保持原样，不做大小写归一。
  //
  const bang = at.lastIndexOf("!");
  if (bang > 0)
    return `${at
      .slice(0, bang)
      .replace(/^'(.*)'$/, "$1")
      .replace(/''/g, "'")} · ${at.slice(bang + 1)}`;
  return at.replace(/^'(.*)'$/, "$1");
}
