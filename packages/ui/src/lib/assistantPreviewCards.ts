// 职责：把助手消息正文里的 localhost/file HTML 链接、Markdown 链接与文件引用，投影成聊天气泡下方可预览的卡片列表，并完成去重、排序与候选截断。
// 定位：纯函数模块，输入为正文、workspace 路径、已抽取的文件引用与改动列表，输出可直接渲染的卡片数组。
// 边界：不发起网络请求、不读写文件、不判断文件是否存在，也不渲染 UI；存在性由渲染层经注入的批量 stat 服务确认。
// 边界：不承担 workspace 身份隔离与分享侧可信校验，远控与 Share Service 会在各自链路重新执行边界检查。
// 不负责：卡片点击后的打开行为（内置预览、系统浏览器、远控转发）由调用方按卡片形态自行分派。
// 不负责：文生 UI 产物的归属判定，只消费 contract 提供的 genUi 源路径做剔除。
//
// INV-01 断言：网站卡只接受 localhost/127.0.0.1 的 http(s) 或 file html —— 守住它的位置：isValidAssistantPreviewWebsiteUrl 的双层校验 —— 改错故障：正文里的公网外链变成可点击预览，远控端可借此探测内网。
// INV-02 断言：候选上限与可见上限都取自 shared 常量 —— 守住它的位置：顶部两个 export const 与截断循环 —— 改错故障：UI 与服务端截断口径分叉，卡片数量在不同端不一致。
// INV-03 断言：远控抑制发生在候选截断之前 —— 守住它的位置：链接循环里的 suppressWebRemoteCards 分支 —— 改错故障：被隐藏的卡片仍占上限名额，远控端可见卡片变少。
// INV-04 断言：远控下 html 文件引用同样被跳过 —— 守住它的位置：引用循环的首个 continue —— 改错故障：远控出现必然打开失败的 file 卡片。
// INV-05 断言：已有 localhost 链接卡时丢弃同源 html 文件引用 —— 守住它的位置：reference.kind 与 hasLocalHttpPreview 组合判断 —— 改错故障：同一产物出现两张网站卡。
// INV-06 断言：markdown 与 html 引用必须命中本轮改动列表 —— 守住它的位置：findMatchingChangedFilePath 调用处 —— 改错故障：未改动的历史文档被当作新产物展示。
// INV-07 断言：叶子名匹配要求引用是裸文件名且候选唯一 —— 守住它的位置：findMatchingChangedFilePath 的兜底分支 —— 改错故障：同名文件把改动归属到错误目录。
// INV-08 断言：路径比较统一 POSIX 分隔符并去掉尾斜杠 —— 守住它的位置：normalizePathForCompare —— 改错故障：Windows 反斜杠路径匹配失败，出现重复卡片。
// INV-09 断言：genUi 源路径在候选截断前被剔除 —— 守住它的位置：两个循环里的 matchesGenUiSourcePath —— 改错故障：可视化已渲染的产物再出现一张文件卡。
// INV-10 断言：卡片按位置倒序挑选 —— 守住它的位置：sort 比较器与后续 push 顺序 —— 改错故障：展示顺序反转，最早的引用排在最前。
// INV-11 断言：根路径且无 query/hash 的 URL 收敛为 origin 去重 —— 守住它的位置：getCardSeenKey —— 改错故障：带与不带尾斜杠的同一地址各出一张卡。
// INV-12 断言：file 卡的 subtitleId 来自文件类型定义表 —— 守住它的位置：buildFileCard 的非空断言与类型断言 —— 改错故障：新增类型未注册时抛错，整条消息卡片构建中断。
// INV-13 断言：html 卡用 file URL 作 id 与 url，同时保留 filePath —— 守住它的位置：buildFileCard 的 html 分支 —— 改错故障：预览读不到本地路径，点击后打不开。
// INV-14 断言：卡片 id 前缀按 kind 区分 —— 守住它的位置：buildFileCard 各分支的 id 拼接 —— 改错故障：同路径在三种形态间互相覆盖。
// INV-15 断言：website 卡的 filePath 只由改动列表反解得到 —— 守住它的位置：resolveLocalhostHtmlChangedPath —— 改错故障：未改动的本地 URL 被当成可预览文件。
// INV-16 断言：空正文直接返回空数组 —— 守住它的位置：两个构建函数的首行 —— 改错故障：空串走完整正则与引用抽取，白耗 CPU。
// INV-17 断言：候选构建固定关闭 workspace 边界校验 —— 守住它的位置：enforceWorkspaceBoundary 入参 —— 改错故障：home 相对路径产物在聊天里消失且无报错。
// INV-18 断言：浏览器打开只发生在本地且非远控紧凑模式 —— 守住它的位置：shouldOpenAssistantHtmlInBrowser —— 改错故障：远控点击 html 在服务端机器启动浏览器。
// INV-19 断言：Markdown 链接标签需通过清洗才可作标题 —— 守住它的位置：cleanMarkdownLinkTitle —— 改错故障：超长或含标记的标签撑破卡片布局。
// INV-20 断言：只有能定位本地文件的卡片才需要存在性检查 —— 守住它的位置：requiresAssistantPreviewCardFileStat —— 改错故障：每个远端网站卡都发起一次无意义的批量查询。
import {
  buildConversationPreviewArtifactCandidatesFromReferences,
  CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
} from "@zcode/shared";
import {
  cleanAssistantFilePathCandidate,
  extractAssistantFileReferences,
  getAssistantPreviewFileTypeDefinition,
  hasAssistantPreviewFileChangeCandidates,
  isAssistantPreviewHtmlPath,
  parseAssistantFileUrlPath,
  resolveAssistantRawFilePath,
  type AssistantFileReference,
  type AssistantFilePathResolveOptions,
  type AssistantPreviewFileKind,
  type AssistantPreviewFileSubtitleId,
} from "@/lib/assistantFileReferences.js";
import { decodeFilePathUriEscapes, getPathLeaf, toFileUrl } from "@/lib/path.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { collectGenUiSourcePaths, matchesGenUiSourcePath } from "@/gen-ui/contract.js";

export {
  extractAssistantFileReferences,
  hasAssistantPreviewFileChangeCandidates,
  isAssistantPreviewHtmlPath,
} from "@/lib/assistantFileReferences.js";
export type {
  AssistantFileReference,
  AssistantPreviewFileKind,
} from "@/lib/assistantFileReferences.js";

// [契约] 候选上限直接继承 shared 的会话预览常量，本文件不维护第二份数字
// 两个导出只是别名，渲染层应从这里取值，避免同一语义出现两个 import 入口
// 若在此写死数字，服务端与 UI 的截断口径会分叉，表现为不同端卡片数量不一致
// 改常量时必须回落测试：上限同时决定“最多选几张”和循环里的提前跳出条件
export const ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT = CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT;
export const ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT = CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT;

export interface AssistantPreviewCardsAutoOpenRequest {
  key: string;
  sources: CodeViewerSource[];
}

// [契约] 联合类型以 type 字段判别，website/markdown/file 三种形态互斥，渲染层按 type 分支
// markdown 与 html 被 Exclude 移出 file 分支，因为它们各有专用形态，不能复用 file 卡
// subtitleId 用 Exclude 收窄而不用 string，保证新增类型时编译器能指出未覆盖的文案键
// 若把 html 放回 file 分支，同一路径会生成 id 不同、去重键相同的两张卡，导致重复展示
export type AssistantPreviewCard =
  | {
      id: string;
      type: "website";
      title: string;
      subtitleId: "chat.previewCards.website" | "chat.previewCards.htmlWebsite";
      url: string;
      filePath?: string;
    }
  | {
      id: string;
      type: "markdown";
      kind: "markdown";
      title: string;
      subtitleId: "chat.previewCards.markdown";
      path: string;
    }
  | {
      id: string;
      type: "file";
      kind: Exclude<AssistantPreviewFileKind, "markdown" | "html">;
      title: string;
      subtitleId: Exclude<
        AssistantPreviewFileSubtitleId,
        "chat.previewCards.markdown" | "chat.previewCards.htmlWebsite"
      >;
      path: string;
    };

export interface AssistantPreviewCardFileStatService {
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
}

// [并发] 这是带 g 标志的模块级正则，matchAll 会自行克隆并维护游标，不能换成复用 lastIndex 的写法
// 若改成对同一实例连续调用 test 或 exec，lastIndex 会残留，第二次构建时首条链接被跳过
// 字符集刻意排除中文标点、反引号与引号，避免把句子里的说明文字吞进 URL
// 扫描范围含路径与查询串，最终是否成卡仍由严格校验函数决定
const LOCALHOST_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#][^\s<>()\]`"'*，。！？；：、]*)?/gi;
const STRICT_LOCALHOST_URL_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:[/?#][^\s<>()\]`"'*，。！？；：、]*)?$/i;
const STRICT_FILE_HTML_URL_RE =
  /^file:\/\/(?:localhost\/|\/|[^/\s<>()\]`"'*，。！？；：、]+\/)[^\s<>()\]`"'*，。！？；：、]+\.html?(?:[?#][^\s<>()\]`"'*，。！？；：、]*)?$/i;
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;

interface AssistantPreviewCardOptions {
  changedFilePaths?: readonly string[];
  homePath?: string;
  suppressWebRemoteCards?: boolean;
}

interface PositionedCard {
  card: AssistantPreviewCard;
  position: number;
}

function normalizeTrailingUrlText(url: string): string {
  return url.trim().replace(/(?:[*_`]+|[.,;:!?，。！？；：、]+)+$/g, "");
}

// [契约] 只放行 localhost/127.0.0.1 的 http(s) 与 file html，公网地址一律拒绝
// 这是安全闸门：放行任意 http 会让正文里的外链变成可点击预览，远控端可借此探测内网
// 先剥离行尾标点与 markdown 修饰符再校验，否则模型常写的“链接。”会被判非法
// 两层校验必须同时成立：严格正则卡整体形状，URL 解析复核协议、凭据与端口
// 只保留任一层都会漏掉 http://localhost@evil.com 这类外观合法、主机被替换的构造
export function isValidAssistantPreviewWebsiteUrl(url: string): boolean {
  const trimmedUrl = normalizeTrailingUrlText(url.trim());
  if (!trimmedUrl) return false;

  const isLocalHttpUrl = STRICT_LOCALHOST_URL_RE.test(trimmedUrl);
  const isFileHtmlUrl = STRICT_FILE_HTML_URL_RE.test(trimmedUrl);
  if (!isLocalHttpUrl && !isFileHtmlUrl) return false;

  try {
    const parsedUrl = new URL(trimmedUrl);
    if (parsedUrl.protocol === "file:") return isFileHtmlUrl;

    const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : null;
    return (
      (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      parsedUrl.username.length === 0 &&
      parsedUrl.password.length === 0 &&
      (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1") &&
      (port === null || (port > 0 && port <= 65_535))
    );
  } catch {
    return false;
  }
}

function normalizeMarkdownHref(href: string): string {
  return href.trim().replace(/^<|>$/g, "");
}

// 标题清洗是展示层防线：超过 80 字符、含 markdown 标记或以标点开头的标签直接判废
// 判废后回退到路径叶子名，避免超长标签撑破卡片高度或把反引号带进渲染
// 必须至少含一个字母、数字或汉字，防止纯符号标签占位出一个空白标题
// 不要把长度上限调大来“保留信息”，标题只承担识别作用，完整信息在预览里
function cleanMarkdownLinkTitle(title: string): string | null {
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  if (
    !normalizedTitle ||
    normalizedTitle.length > 80 ||
    /^https?:\/\//i.test(normalizedTitle) ||
    /[*_`[\]<>]/.test(normalizedTitle) ||
    /^[)"'`,.;:!?，。！？；：、）】》]+/.test(normalizedTitle) ||
    !/[a-zA-Z0-9\u4e00-\u9fff]/.test(normalizedTitle)
  ) {
    return null;
  }
  return normalizedTitle;
}

// [契约] 只有本地且非远控紧凑模式，才允许调用系统浏览器打开 html
// workspaceIdentity 判空用可选链加 trim，空串视为本地；改成判断字段是否存在会让默认本地会话永远打不开
// 有 remoteSessionId 时恒为 false 是刻意的：桌面端没有对应窗口，强开会在服务端机器弹浏览器
// compactForRemoteControl 用严格等于 true 判定，缺省 undefined 仍走本地分支
export function shouldOpenAssistantHtmlInBrowser(params: {
  compactForRemoteControl?: boolean;
  path: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): boolean {
  return (
    isAssistantPreviewHtmlPath(params.path) &&
    params.compactForRemoteControl !== true &&
    !params.workspaceIdentity?.trim() &&
    !params.workspaceRemoteSessionId
  );
}

// 比较键统一为 POSIX 分隔符、折叠重复斜杠、去掉尾斜杠，三段处理顺序不可省略
// 去重与改动列表匹配都依赖该口径，漏掉反斜杠替换会让 Windows 路径永远匹配不上
// 不要在这里做大小写归一，大小写敏感的文件系统上会把两个文件合并成一张卡
function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

// 以盘符、根斜杠或 UNC 双反斜杠开头视为绝对路径，清洗后直接使用
// 相对路径优先按 workspace 解析，解析失败回退原文，保证仍能参与叶子名匹配
// 绝对路径分支不再拼接 workspace，否则远程路径会被二次拼接成不存在的路径
function resolveChangedFilePath(workspacePath: string, path: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path)) {
    return cleanAssistantFilePathCandidate(path);
  }
  return resolveAssistantRawFilePath(workspacePath, path) ?? path;
}

// [权衡] 先做归一化后的全路径精确匹配，只有完全匹配落空才允许按文件名匹配，顺序不可交换
// 叶子名匹配只对裸文件名开放：引用里带斜杠或 file: 前缀时直接判不匹配
// 同名候选多于一个时返回 null，宁可不展示卡片，也不能把改动归属到错误目录的同名文件
// 返回值是改动列表条目解析后的路径而非引用路径，后续卡片以它为真实路径
// 改动列表每轮重新解析并归一化，不要缓存到模块作用域，否则跨会话会串味
function findMatchingChangedFilePath(
  reference: AssistantFileReference,
  changedFilePaths: readonly string[],
  workspacePath: string,
): string | null {
  const normalizedReferencePath = normalizePathForCompare(reference.path);
  const normalizedChangedPaths = changedFilePaths.map((path) => {
    const resolvedPath = resolveChangedFilePath(workspacePath, path);
    return { path: resolvedPath, normalized: normalizePathForCompare(resolvedPath) };
  });
  const exact = normalizedChangedPaths.find(
    (candidate) => candidate.normalized === normalizedReferencePath,
  );
  if (exact) return exact.path;

  const cleanedRaw = cleanAssistantFilePathCandidate(reference.raw);
  if (cleanedRaw.includes("/") || cleanedRaw.includes("\\") || /^file:/i.test(cleanedRaw)) {
    return null;
  }
  const leafMatches = normalizedChangedPaths.filter(
    (candidate) => getPathLeaf(candidate.normalized) === cleanedRaw,
  );
  return leafMatches.length === 1 ? leafMatches[0]!.path : null;
}

function getWebsiteTitleFromMarkdownLink(content: string, url: string): string | null {
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const label = match[1] ? cleanMarkdownLinkTitle(match[1]) : null;
    const href = match[2] ? normalizeTrailingUrlText(normalizeMarkdownHref(match[2])) : "";
    if (label && href === url && !/^https?:\/\//i.test(label)) return label;
  }
  return null;
}

function getWebsiteFallbackTitle(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const pathLeaf = getPathLeaf(decodeURI(parsedUrl.pathname));
    return pathLeaf && pathLeaf !== "/" ? pathLeaf : parsedUrl.host;
  } catch {
    return url;
  }
}

// 把 localhost URL 的 pathname 反解为 workspace 内文件，再确认它出现在本轮改动列表里
// 解码必须发生在扩展名判断之前，否则百分号编码可以绕过 html 检查
// 只接受 html 路径，其余扩展名返回 null，调用方据此只展示链接、不挂 filePath
// homePath 缺失或路径解析失败时返回 null，异常不向循环外抛
function resolveLocalhostHtmlChangedPath(
  url: string,
  workspacePath: string,
  changedFilePaths: readonly string[],
  options: AssistantFilePathResolveOptions = {},
): string | null {
  try {
    const parsedUrl = new URL(url);
    const pathname = decodeFilePathUriEscapes(parsedUrl.pathname).replace(/^\/+/, "");
    if (!isAssistantPreviewHtmlPath(pathname)) return null;
    const path = resolveAssistantRawFilePath(workspacePath, pathname, options);
    if (!path) return null;
    return findMatchingChangedFilePath(
      { start: 0, end: 0, kind: "html", path, raw: pathname },
      changedFilePaths,
      workspacePath,
    );
  } catch {
    return null;
  }
}

// 非空断言成立的前提是引用来自文件引用抽取，kind 与 path 已被类型定义表识别
// 上游新增文件类型而这里未同步时，断言会抛错，整条消息的卡片构建都会失败
// html 分支用 file URL 同时充当 id 与 url，并额外保留 filePath 供预览读取
// id 前缀按 kind 区分，否则同路径在 website/markdown/file 三种形态间会互相覆盖
function buildFileCard(reference: AssistantFileReference): AssistantPreviewCard {
  const definition = getAssistantPreviewFileTypeDefinition(reference.path)!;
  if (reference.kind === "markdown") {
    return {
      id: `markdown:${reference.path}`,
      type: "markdown",
      kind: "markdown",
      title: getPathLeaf(reference.path),
      subtitleId: "chat.previewCards.markdown",
      path: reference.path,
    };
  }
  if (reference.kind === "html") {
    return {
      id: `website:${toFileUrl(reference.path)}`,
      type: "website",
      title: getPathLeaf(reference.path),
      subtitleId: "chat.previewCards.htmlWebsite",
      url: toFileUrl(reference.path),
      filePath: reference.path,
    };
  }
  return {
    id: `file:${reference.kind}:${reference.path}`,
    type: "file",
    kind: reference.kind,
    title: getPathLeaf(reference.path),
    subtitleId: definition.subtitleId as Extract<
      AssistantPreviewCard,
      { type: "file" }
    >["subtitleId"],
    path: reference.path,
  };
}

// 有文件路径的卡片按归一化路径去重，同一文件的不同形态只保留先入的一张
// 仅根路径且无 query、hash 的 URL 收敛为 origin，使带不带尾斜杠的两个地址视为同一张
// URL 解析失败回退到卡片的 id，保证异常地址不会因为拿不到去重键而重复出现
// 去重键与 getAssistantPreviewCardFilePath 必须同口径，改一处就要同步另一处
function getCardSeenKey(card: AssistantPreviewCard): string {
  const filePath = getAssistantPreviewCardFilePath(card);
  if (filePath) return `file:${normalizePathForCompare(filePath)}`;
  try {
    const parsedUrl = new URL(card.type === "website" ? card.url : "");
    return parsedUrl.pathname === "/" && !parsedUrl.search && !parsedUrl.hash
      ? `url:${parsedUrl.origin}`
      : `url:${parsedUrl.href}`;
  } catch {
    return card.id;
  }
}

// 空正文在这里短路，避免对空串执行正则扫描与文件引用抽取
// 不要用 length 判断空，纯空白同样不应产生卡片
// 本函数只是抽取加委托，排序、去重、截断全部发生在 FromReferences 版本里
export function buildAssistantPreviewCards(
  content: string,
  workspacePath: string,
  options: AssistantPreviewCardOptions = {},
): AssistantPreviewCard[] {
  if (!content.trim()) return [];
  return buildAssistantPreviewCardsFromReferences(
    content,
    workspacePath,
    extractAssistantFileReferences(content, workspacePath, { homePath: options.homePath }),
    options,
  );
}

export function buildAssistantPreviewCardsFromReferences(
  content: string,
  workspacePath: string,
  references: readonly AssistantFileReference[],
  options: AssistantPreviewCardOptions = {},
): AssistantPreviewCard[] {
  if (!content.trim()) return [];

  // 改动列表只取一次，两个循环与候选构建共用同一份快照，中途重算会让口径漂移
  // genUi 源路径来自正文声明，用于剔除由文生 UI 自己渲染的产物，避免重复卡片
  // positionedCards 同时记录位置，最终按位置倒序挑选，等于优先保留消息末尾的最新产物
  // 这两个集合都是本轮的局部状态，不要提升为模块级缓存
  const changedFilePaths = options.changedFilePaths ?? [];
  const genUiSources = collectGenUiSourcePaths(content);
  const positionedCards: PositionedCard[] = [];
  let hasLocalHttpPreview = false;

  // 先扫描链接再处理文件引用：hasLocalHttpPreview 必须在引用循环之前确定
  // 标题优先级是改动文件叶子名、正文 markdown 链接标签、URL 兜底名
  // 循环内任一 continue 都不要顺手改 hasLocalHttpPreview，它只代表最终成卡的链接
  for (const match of content.matchAll(LOCALHOST_URL_RE)) {
    const url = normalizeTrailingUrlText(match[0] ?? "");
    if (!isValidAssistantPreviewWebsiteUrl(url)) continue;
    // Web 远控没有本地端口转发或 HTML 运行环境；在候选上限前过滤，避免隐藏卡片占位。
    // [失败路径] 远控抑制必须在候选截断之前生效，否则被隐藏的卡片仍占掉上限名额
    // 抑制位于严格校验之后：非法地址先出局，不会影响任何后续判断
    // 远控端没有本地端口转发与 file 协议，放行只会得到必然打不开的卡片
    // hasLocalHttpPreview 在本行之后才置位，因此被抑制的链接不会误杀 html 文件引用
    // 调整这两行的先后顺序会同时改变去重与截断结果，是测试里最难定位的一类回归
    if (options.suppressWebRemoteCards) continue;
    const filePath = resolveLocalhostHtmlChangedPath(url, workspacePath, changedFilePaths, {
      homePath: options.homePath,
    });
    if (filePath && matchesGenUiSourcePath(filePath, genUiSources)) continue;
    hasLocalHttpPreview = true;
    positionedCards.push({
      position: match.index ?? 0,
      card: {
        id: `website:${url}`,
        type: "website",
        title:
          filePath !== null
            ? getPathLeaf(filePath)
            : (getWebsiteTitleFromMarkdownLink(content, url) ?? getWebsiteFallbackTitle(url)),
        subtitleId: "chat.previewCards.website",
        url,
        ...(filePath ? { filePath } : {}),
      },
    });
  }

  const fileReferences: AssistantFileReference[] = [];
  for (const reference of references) {
    if (options.suppressWebRemoteCards && reference.kind === "html") continue;
    // 同一 HTML 产物可能既以 localhost 链接出现，又以文件引用出现，这里负责二选一
    // 已有链接卡时丢弃文件引用，反向不成立：没有链接卡就保留引用并生成 file URL 网站卡
    // 远控抑制对 html 引用单独生效，因为 file 协议在远控端同样不可用
    // 这两次 continue 都在候选构建之前，被丢弃的引用不会占用任何名额
    if (reference.kind === "html" && hasLocalHttpPreview) continue;

    let resolvedReference = reference;
    if (reference.kind === "markdown" || reference.kind === "html") {
      const changedPath = findMatchingChangedFilePath(reference, changedFilePaths, workspacePath);
      // [契约] markdown 与 html 只接受本轮改动过的文件，历史引用不生成卡片
      // 命中后用改动列表里的路径替换引用路径，保证预览读到的是真实 workspace 文件
      // 普通文件引用不走此校验，直接进入候选构建
      if (!changedPath) continue;
      resolvedReference = { ...reference, path: changedPath };
    }
    // 可视化已在正文展示；通用文件引用识别会再次命中其 HTML 路径，需在候选限额前去重。
    if (matchesGenUiSourcePath(resolvedReference.path, genUiSources)) continue;
    fileReferences.push(resolvedReference);
  }

  const previewCandidates = buildConversationPreviewArtifactCandidatesFromReferences({
    references: fileReferences,
    productTurnId: "",
    workspacePath,
    fileChanges: changedFilePaths.map((path) => ({ path, state: "active" as const })),
    // Renderer 仍需展示已解析的 Home-relative/file URL 卡片；Share Service 会在自己的
    // Host source 上再次执行 workspace 边界校验。
    // [契约] 这里显式关闭 workspace 边界校验，因为渲染层要展示已解析的 home 相对路径与 file URL 卡片
    // 关闭不等于放弃隔离：Share Service 会在自己托管的源上重新执行边界校验
    // 改成 true 之后，home 目录下的合法产物会在聊天里直接消失，且没有报错可查
    // fileChanges 把所有改动路径标为 active，候选构建据此判断文件是否属于本轮
    // 候选的 sourceRef 可能已被改写为绝对路径，所以下面回查引用必须按归一化路径建索引
    enforceWorkspaceBoundary: false,
  });
  const referencesByPath = new Map(
    fileReferences.map((reference) => [normalizePathForCompare(reference.path), reference]),
  );
  for (const candidate of previewCandidates) {
    const reference = referencesByPath.get(normalizePathForCompare(candidate.sourceRef));
    if (!reference) continue;
    positionedCards.push({
      position: reference.start,
      card: buildFileCard({ ...reference, path: candidate.sourceRef }),
    });
  }

  // 倒序排序后顺序取用，等价于位置越靠后越优先，与聊天气泡里最新的产物优先一致
  // 只比较 position，相等时保持插入顺序；不要追加第二个排序键，否则网站卡与文件卡的相对顺序会漂移
  // 去重发生在排序之后、截断之前，保证被去重淘汰的卡片不会挤掉有效卡片
  // seen 集合按卡片去重键写入，跨 website 与 file 形态共用，先到先得
  // 截断用等号比较而不是大于等于，因为每轮只 push 一张，等号即可精确收口
  positionedCards.sort((left, right) => right.position - left.position);
  const seen = new Set<string>();
  const cards: AssistantPreviewCard[] = [];
  for (const candidate of positionedCards) {
    const key = getCardSeenKey(candidate.card);
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(candidate.card);
    if (cards.length === ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT) break;
  }
  return cards;
}

export function getAssistantPreviewCardFilePath(card: AssistantPreviewCard): string | null {
  return card.type === "website"
    ? (card.filePath ?? parseAssistantFileUrlPath(card.url))
    : card.path;
}

export function requiresAssistantPreviewCardFileStat(card: AssistantPreviewCard): boolean {
  return getAssistantPreviewCardFilePath(card) !== null;
}
