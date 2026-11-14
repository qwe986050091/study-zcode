// INV-01 链接解析唯一入口是 parseMarkdownFileLinkTarget，引号剥离与反斜杠统一都在首行完成；守住位置：normalizedHref 的赋值；改错故障：带引号或反斜杠的助手路径直接解析失败。
// INV-02 URI 解码只允许发生一次且必须在 normalizeMarkdownFilePath 内；守住位置：解析入口不调用 decode；改错故障：%2520 被二次解码成空格，字面转义文件名失效。
// INV-03 尾缀优先级固定为 hash 行、行加列、纯行号，三段按序短路；守住位置：parseMarkdownFileLinkTarget 的匹配顺序；改错故障：a.ts:1:2 被纯行号正则先吃成路径 a.ts:1。
// INV-04 全部尾缀都不匹配时必须降级为无行号结果，不能抛错也不能返回 null；守住位置：函数末尾的兜底返回；改错故障：普通路径链接整片失效。
// INV-05 file 协议只在 parseFileUrlPath 内处理，hostname 非 localhost 时保留双斜杠 UNC 前缀；守住位置：parseFileUrlPath 的分支；改错故障：file://server/share 丢失主机名被当成本地路径。
// INV-06 盘符形态的 /C:/ 是 harden 内部格式，剥前导斜杠前必须确认 workspace 是 Windows 绝对路径；守住位置：HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE 分支；改错故障：Unix 斜杠路径被误当盘符，或 UNC workspace 被整体拒绝。
// INV-07 家目录展开依赖 Host 注入的 homePath，且 homePath 本身必须是绝对路径；守住位置：resolveHomeRelativeFilePath 的前置校验；改错故障：Renderer 自行猜 Home，链接被拼到不存在的目录。
// INV-08 命名用户写法 ~name/ 一律拒绝，不查询系统用户库；守住位置：isUnsupportedNamedHomePath 及其在最前的位置；改错故障：~foo 被当成 ~ 的相对路径解析到错误位置。
// INV-09 ./ 前缀与裸相对路径都锚定 workspace，且必须经词法归一后再拼接；守住位置：resolveContainedWorkspaceRelativePath；改错故障：../../ 逃逸出 workspace，stat 落到项目之外。
// INV-10 上溢到根目录的 .. 立即返回 null，绝不静默截断到根；守住位置：normalizeWorkspaceRelativeFilePath 的空栈分支；改错故障：越界路径被夹成根内路径，打开错误文件。
// INV-11 归一化丢弃空段与点段，输出恒为正斜杠相对路径；守住位置：normalizeWorkspaceRelativeFilePath 的循环；改错故障：反斜杠残留，后续拼接出现混合分隔符。
// INV-12 已位于 workspace 根内的绝对风格路径原样返回，不再拼一次前缀；守住位置：isPathInsideWorkspaceRoot 判断分支；改错故障：/workspace 变成 /workspace/workspace。
// INV-13 非系统根的 /xxx 是 Markdown 根相对链接，锚定 workspace 根；守住位置：isLikelyUnixAbsoluteFilePath 为假时的分支；改错故障：误去 stat 系统根下的 /flappy.html。
// INV-14 系统根白名单 COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS 决定哪些斜杠开头路径按绝对处理；守住位置：isLikelyUnixAbsoluteFilePath 的集合查询；改错故障：/usr 路径被拼进 workspace，绝对路径失效。
// INV-15 最终兜底只接受绝对路径或双斜杠 UNC，其余裸文本一律返回 null；守住位置：isAbsoluteMarkdownFileHref 与函数末尾；改错故障：普通文字被当成文件路径生成链接。
// INV-16 无法解析的链接统一返回 null，调用方据此不打开也不 stat；守住位置：resolveMarkdownFileLink 的所有 null 返回点；改错故障：非法输入变成可点击链接并触发错误请求。
// INV-17 拼接分隔符由 workspacePath 或 homePath 自身风格决定，纯反斜杠才用反斜杠；守住位置：两处 separator 的计算；改错故障：Windows 路径出现混合分隔符，部分工具无法识别。
// INV-18 本模块是纯函数边界，不读文件、不发请求、不访问本机 Home；守住位置：全部导出函数；改错故障：解析层引入 IO，渲染期阻塞并与运行环境耦合。
//
// 模块职责：把 Markdown 里的本地文件链接解析成绝对路径与可选行列号，不做文件存在性校验。
// 状态所有权：本模块无状态、无副作用，homePath 与 workspacePath 全部由调用方注入。
// 阅读顺序：先看尾缀正则与文件头常量，再看路径归一，最后看 resolveMarkdownFileLink 的五段分支。
import { decodeFilePathUriEscapes, isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { stripBalancedAssistantPathQuotes } from "@/lib/assistantPathQuotes.js";

interface ParsedMarkdownFileLink {
  path: string;
  lineNumber: number | null;
  columnNumber: number | null;
}

export interface MarkdownFileLinkResolveOptions {
  /** 当前 workspace Host 报告的用户 Home；Renderer 不自行读取本机 Home。 */
  homePath?: string;
}

// 四条尾缀正则的书写顺序就是匹配优先级，列号形态必须排在纯行号之前
// hash 形态带 i 标志并接受 -L12 或 -12 的区间写法，只取区间起始行
// path 段用贪婪匹配，让 Windows 盘符中的冒号留给尾缀判定 [权衡]
// 这些常量是模块级不可变值，禁止放进函数重建，也不要加 g 标志 [资源]
// 新增尾缀必须先补用例，覆盖行列、hash 区间与纯行号三种输入
// 顺序一改，a.ts:1:2 会被纯行号正则先吃成 a.ts:1 [失败路径]
//
const LINE_AND_COLUMN_SUFFIX_RE = /^(?<path>.+):(?<line>\d+):(?<column>\d+)$/;
const LINE_SUFFIX_RE = /^(?<path>.+):(?<line>\d+)$/;
const HASH_LINE_SUFFIX_RE = /^(?<path>.+)#L(?<line>\d+)(?:-L?\d+)?$/i;
const FILE_URL_PROTOCOL_RE = /^file:\/\//i;
const HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE = /^\/[a-zA-Z]:\//;
const COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS = new Set([
  "Applications",
  "Library",
  "System",
  "Users",
  "Volumes",
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "media",
  "mnt",
  "opt",
  "private",
  "proc",
  "root",
  "run",
  "sbin",
  "srv",
  "sys",
  "tmp",
  "usr",
  "var",
]);

function isWorkspaceRelativeFileHref(href: string): boolean {
  return href.startsWith("./");
}

function normalizeHomeRelativePath(path: string): string | null {
  if (path.startsWith("./~/") || path.startsWith("./~\\")) {
    return path.slice(2);
  }
  return /^~[\\/]/.test(path) ? path : null;
}

function isHomeRelativeFilePath(path: string): boolean {
  return normalizeHomeRelativePath(path) !== null;
}

// ~name/ 是 shell 的命名用户家目录，本模块不查询系统用户库，直接拒绝
// 判定必须放在家目录归一之前，否则 ~foo 会被当成 ~ 的相对路径 [失败路径]
// 只匹配波浪号后紧跟非分隔符再跟分隔符的形态，~/x 不在其列
// 拒绝而非猜测，避免链接落到另一个用户目录 [权衡]
// homePath 缺失时单纯的 ~ 同样返回 null，两处语义保持一致
// 它只做字符串形状判断，不解析路径也不访问文件系统
//
function isUnsupportedNamedHomePath(path: string): boolean {
  return /^~[^\\/]+[\\/]/.test(path);
}

function resolveHomeRelativeFilePath(path: string, homePath: string | undefined): string | null {
  const homeRelativePath = normalizeHomeRelativePath(path);
  if (!homeRelativePath || !homePath || !isAbsoluteFilePath(homePath)) {
    return null;
  }

  const separator = homePath.includes("\\") && !homePath.includes("/") ? "\\" : "/";
  return joinFilePath(homePath, homeRelativePath.slice(2).replace(/[\\/]/g, separator));
}

// 裸相对链接必须含分隔符，纯单词如 README 不当作文件路径 [权衡]
// 斜杠开头、井号开头、上级目录开头与带协议前缀的输入全部排除
// 协议检测允许字母开头并接受加号点号连字符，与 URI scheme 规则一致
// 反斜杠也算分隔符，覆盖 Windows 手写的链接写法
// 这里只判断形状，不校验存在性，也不做任何路径归一 [权衡]
// 放宽会让普通文本变成链接，收紧会让 ./src/app.ts 之外的相对写法失效 [失败路径]
//
function isBareWorkspaceRelativeFileHref(href: string): boolean {
  if (
    !href ||
    href.startsWith("/") ||
    href.startsWith("#") ||
    href.startsWith("../") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)
  ) {
    return false;
  }

  return href.includes("/") || href.includes("\\");
}

function isAbsoluteMarkdownFileHref(rawHref: string, normalizedHref: string): boolean {
  return (
    isAbsoluteFilePath(rawHref) ||
    isAbsoluteFilePath(normalizedHref) ||
    normalizedHref.startsWith("//")
  );
}

function isLikelyUnixAbsoluteFilePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }

  const firstSegment = path.slice(1).split("/")[0];
  return Boolean(firstSegment && COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS.has(firstSegment));
}

function isPathInsideWorkspaceRoot(path: string, workspacePath: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedWorkspacePath = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  return (
    normalizedPath === normalizedWorkspacePath ||
    normalizedPath.startsWith(`${normalizedWorkspacePath}/`)
  );
}

function parseFileUrlPath(path: string): string | null {
  if (!FILE_URL_PROTOCOL_RE.test(path)) {
    return null;
  }

  try {
    const url = new URL(path);
    if (url.protocol !== "file:") {
      return null;
    }

    const decodedPathname = decodeFilePathUriEscapes(url.pathname);
    if (/^\/[a-zA-Z]:\//.test(decodedPathname)) {
      return decodedPathname.slice(1);
    }

    if (url.hostname && url.hostname !== "localhost") {
      return `//${url.hostname}${decodedPathname}`;
    }

    return decodedPathname;
  } catch {
    return null;
  }
}

function normalizeMarkdownFilePath(path: string): string {
  return parseFileUrlPath(path) ?? decodeFilePathUriEscapes(path);
}

// 词法归一只做字符串处理，不触碰文件系统，因此可以在渲染期直接调用
// .. 出栈遇到空栈立刻返回 null，绝不截断到根 [失败路径]
// 空段与点段直接跳过，输出恒为正斜杠形式的相对路径
// 返回的是相对路径而不是绝对路径，与 workspace 拼接由下一个函数负责
// 文件内原注释已说明只看 ../ 开头不够，嵌套回退同样能逃逸 workspace
// 所有 workspace 内拼接都经 resolveContainedWorkspaceRelativePath 走这里
// 根检查一旦被改坏就是目录穿越漏洞，属于安全边界而非普通容错
//
export function normalizeWorkspaceRelativeFilePath(relativePath: string): string | null {
  const segments: string[] = [];
  for (const segment of relativePath.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        // 只检查路径是否以 ../ 开头是不够的：嵌套回退会在拼接后逃逸 workspace。
        // 这里在 Renderer 发起 stat/checkFilesExist 前做跨平台词法归一，根目录下溢时直接拒绝。
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

function resolveContainedWorkspaceRelativePath(
  workspacePath: string,
  relativePath: string,
): string | null {
  const normalizedRelativePath = normalizeWorkspaceRelativeFilePath(relativePath);
  if (normalizedRelativePath === null) return null;

  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  return joinFilePath(workspacePath, normalizedRelativePath.replaceAll("/", separator));
}

// 唯一解析行号与列号的入口，各种链接形态在这里收敛成路径加行列号
// 三步匹配按固定优先级短路，命中即返回，顺序不可调换 [失败路径]
// 引号剥离与反斜杠统一只在这一层做，下游函数不再重复处理
// 解码只在路径归一里发生一次，此处绝不提前解码 [失败路径]
// 行号由正则先行约束为十进制数字，十进制解析不会得到 NaN
// 全部匹配失败时返回无行号结果而非 null，合法性交给上层判断 [权衡]
//
export function parseMarkdownFileLinkTarget(href: string): ParsedMarkdownFileLink {
  // 只在路径归一化阶段解码一次；入口提前 decode 会让 `%2520` 变成 `%20`，
  // 再由 normalizeMarkdownFilePath 解码成空格，破坏文件名中的字面 percent-escape。
  const normalizedHref = stripBalancedAssistantPathQuotes(href).replace(/\\/g, "/");
  const withHashLineMatch = normalizedHref.match(HASH_LINE_SUFFIX_RE);
  if (withHashLineMatch?.groups) {
    const { path, line } = withHashLineMatch.groups;
    if (path && line) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: null,
      };
    }
  }

  const withLineAndColumnMatch = normalizedHref.match(LINE_AND_COLUMN_SUFFIX_RE);
  if (withLineAndColumnMatch?.groups) {
    const { path, line, column } = withLineAndColumnMatch.groups;
    if (path && line && column) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: Number.parseInt(column, 10),
      };
    }
  }

  const withLineMatch = normalizedHref.match(LINE_SUFFIX_RE);
  if (withLineMatch?.groups) {
    const { path, line } = withLineMatch.groups;
    if (path && line) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: null,
      };
    }
  }

  return {
    path: normalizeMarkdownFilePath(normalizedHref),
    lineNumber: null,
    columnNumber: null,
  };
}

// 解析分五段：命名家目录拒绝、家目录展开、盘符加固、workspace 相对、根相对与绝对兜底
// 每段都以返回收敛，绝不落穿到下一段继续判断 [失败路径]
// workspacePath 缺失时只有家目录与绝对路径可能成功，其余一律 null [权衡]
// 相对链接的分隔符跟随 workspacePath 风格，纯反斜杠才使用反斜杠
// 分支顺序本身就是安全边界，调换会让逃逸路径绕过包含性检查 [失败路径]
// 本函数是纯函数，不 stat、不读文件、也不访问本机 Home [资源]
// 返回值只描述目标位置，是否打开与如何展示由调用方决定
//
export function resolveMarkdownFileLink(
  workspacePath: string | undefined,
  href: string,
  options: MarkdownFileLinkResolveOptions = {},
): ParsedMarkdownFileLink | null {
  // 聊天消息里的本地文件链接现在既可能是 `./src/app.ts` 这种工作区相对路径，
  // 也可能是 `/abs/path/app.ts:30` 这种绝对路径 + 行号。
  // 只看到前导 `/` 就当成 workspace 子路径会让绝对路径被再拼一次 workspace 前缀，
  // 同时 `:30` 也会混进文件名里。这里先拆掉可选行号，再把“相对路径”和“绝对路径”分开解析。
  const parsedTarget = parseMarkdownFileLinkTarget(href);

  if (isUnsupportedNamedHomePath(parsedTarget.path)) {
    return null;
  }

  const homePath = resolveHomeRelativeFilePath(parsedTarget.path, options.homePath);
  if (isHomeRelativeFilePath(parsedTarget.path)) {
    return homePath
      ? {
          ...parsedTarget,
          path: homePath,
        }
      : null;
  }

  if (HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE.test(parsedTarget.path)) {
    // `/C:/...` 只是在 Windows Markdown 渲染管线中绕过 harden 的内部格式。
    // 旧 guard 只把盘符 workspace 当成 Windows，遗漏统一路径工具已支持的 UNC。
    // Windows workspace 既可能是盘符也可能是反斜杠 UNC；以 `/` 开头的 Unix 路径仍须拒绝。
    if (!workspacePath || workspacePath.startsWith("/") || !isAbsoluteFilePath(workspacePath)) {
      return null;
    }
    return {
      ...parsedTarget,
      path: parsedTarget.path.slice(1),
    };
  }

  if (
    isWorkspaceRelativeFileHref(parsedTarget.path) ||
    isBareWorkspaceRelativeFileHref(parsedTarget.path)
  ) {
    if (!workspacePath) {
      return null;
    }

    const relativePath = isWorkspaceRelativeFileHref(parsedTarget.path)
      ? parsedTarget.path.slice(2)
      : parsedTarget.path;
    if (!relativePath) {
      return null;
    }

    const containedPath = resolveContainedWorkspaceRelativePath(workspacePath, relativePath);
    if (!containedPath) return null;

    return {
      ...parsedTarget,
      path: containedPath,
    };
  }

  if (
    workspacePath &&
    parsedTarget.path.startsWith("/") &&
    !isLikelyUnixAbsoluteFilePath(parsedTarget.path)
  ) {
    // 远程 workspace 常见 `/workspace`、`/repo` 这类非系统根目录。
    // 如果链接已经位于当前 workspace 内，不能再按 Markdown 根相对路径拼接一次。
    if (isPathInsideWorkspaceRoot(parsedTarget.path, workspacePath)) {
      return parsedTarget;
    }
    // Streamdown/rehype-harden 会把 `./flappy.html` 规范化成 `/flappy.html`。
    // 这里的前导 `/` 表示 markdown 根相对链接，不是系统根目录；否则会误去 stat `/flappy.html`。
    const containedPath = resolveContainedWorkspaceRelativePath(
      workspacePath,
      parsedTarget.path.slice(1),
    );
    if (!containedPath) return null;
    return {
      ...parsedTarget,
      path: containedPath,
    };
  }

  if (isAbsoluteMarkdownFileHref(href, parsedTarget.path)) {
    return parsedTarget;
  }

  return null;
}
