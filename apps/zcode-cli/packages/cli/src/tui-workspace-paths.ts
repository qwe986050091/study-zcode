// 工作区路径补全：把 TUI 输入框中的路径 token 解析为候选文件/目录列表，供 @ 引用补全框展示。
// 所有文件系统访问都走注入的 FileSystemPort，不直接调用 fs；失败一律降级为空集合，不向 UI 抛错。
// 安全口径：token 必须是工作区内相对路径，绝对路径与 ".." 一律拒绝，最终还会用 path.relative 做物理包含性复核。

import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import type { FileSystemPort } from "@zcode/contracts";
import type { TuiListWorkspacePathSuggestions, TuiWorkspacePathSuggestion } from "@zcode/tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

// 默认候选上限 50 条：够用且能避免超大目录一次性灌满补全列表与渲染压力。
const DEFAULT_WORKSPACE_PATH_SUGGESTION_LIMIT = 50;
// 统一 Windows 反斜杠与重复分隔符为 "/"，后续所有解析只按 "/" 处理，保证跨平台行为一致。
const PATH_SEPARATOR_PATTERN = /[\\/]+/gu;
// POSIX 上的 isAbsolute 不识别盘符路径，故显式匹配 "C:\" / "C:/" 形式，避免 Windows 绝对路径漏判。
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/u;
// 版本控制与依赖目录不作为补全目标：减少噪声，也避免用户误引用内部元数据。
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".bzr",
  ".git",
  ".hg",
  ".jj",
  ".sl",
  ".svn",
  "node_modules",
]);

// 创建工作区路径补全提供者，返回符合 TUI 契约的异步查询函数。
// 输入：workspaceDirectory 必填，会被 resolve 归一化为比较基准；fileSystemPort 缺省时使用真实 Node 文件系统适配器。
// 输出：每次调用返回 { items, truncated }；items 为工作区内相对路径（目录带尾 "/"），无匹配或任何失败时为空数组。
// 副作用：仅在查询时读取一次目标目录（不递归、不缓存、不订阅），并透传 request.abortSignal 以支持取消。
// 不变量：返回的 path 永远不越出 workspaceDirectory，且统一使用 "/" 分隔符。
export function createWorkspacePathSuggestionProvider(options: {
  // 文件系统端口注入点；测试可替换为内存实现，避免真实磁盘依赖。
  fileSystemPort?: FileSystemPort;
  // 工作区根目录（可为相对路径，内部会 resolve 成绝对路径作为包含性判断基准）。
  workspaceDirectory: string;
}): TuiListWorkspacePathSuggestions {
  const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
  // resolve 会消掉尾部斜杠与 "." 片段，保证后续 relative 结果稳定；符号链接在这里不解引用。
  const workspaceDirectory = resolve(options.workspaceDirectory);

  return async (request) => {
    const parsed = parseWorkspacePathToken(request.token);
    // token 非法（绝对路径或含 ".."）时返回空集合而非报错：补全框应静默无候选，不影响用户继续输入。
    if (!parsed) return { items: [], truncated: false };

    // resolve 会吸收 directoryToken 中的相对片段；随后再用 relative 复核，防止大小写/符号链接差异绕过字符串层校验。
    const directory = resolve(workspaceDirectory, parsed.directoryToken);
    // 越界直接返回空：不尝试列举工作区外目录，避免泄露本机其他路径信息。
    if (!isPathInside(workspaceDirectory, directory)) {
      return { items: [], truncated: false };
    }

    // 目录不存在、无权限、读取中途被 abort 等错误由 port 抛出；这里统一降级为空结果，避免 TUI 渲染路径出现异常。
    try {
      const listed = await fileSystemPort.listDirectory(
        { path: directory },
        { signal: request.abortSignal },
      );
      // 用 flatMap 而非 filter+map：每个被排除的条目返回空数组，一次遍历同时完成过滤与投影。
      const candidates = listed.entries
        .flatMap((entry): TuiWorkspacePathSuggestion[] => {
          // 只接受明确的 file/directory；符号链接等其它 kind 不参与补全，避免指向不可预期目标。
          if (entry.kind !== "directory" && entry.kind !== "file") return [];
          // 仅对目录做版本控制/依赖目录排除；同名文件（理论上不存在）不受影响。
          if (entry.kind === "directory" && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) return [];
          // 隐藏项默认不展示；只有用户显式输入以 "." 开头的 query 时才放开，符合 shell 补全直觉。
          if (!parsed.query.startsWith(".") && entry.name.startsWith(".")) return [];
          if (!matchesPathQuery(entry.name, parsed.query)) return [];

          // 越出工作区（含跨盘符）的条目直接丢弃，保证输出 path 始终可以安全拼回 workspace 根。
          const relativePath = toWorkspaceRelativePath(workspaceDirectory, entry.path);
          if (!relativePath) return [];
          // 目录追加尾 "/"：一是与会话中的目录语法一致，二是让用户能继续按键下钻到下一级。
          return [
            {
              kind: entry.kind,
              path: entry.kind === "directory" ? `${relativePath}/` : relativePath,
            },
          ];
        })
        // 排序依赖 query 做前缀优先判定，必须在过滤之后、截断之前执行，否则截断结果不稳定。
        .sort((left, right) => compareWorkspacePathSuggestion(left, right, parsed.query));

      // 下限钳到 1 并向下取整：request.limit 可能来自外部输入（0、负数、NaN），避免返回空列表或小数切片。
      const limit = Math.max(
        1,
        Math.floor(request.limit ?? DEFAULT_WORKSPACE_PATH_SUGGESTION_LIMIT),
      );
      // truncated 反映"被截断"而非"已取满"，UI 据此决定是否展示"更多候选"提示。
      return {
        items: candidates.slice(0, limit),
        truncated: candidates.length > limit,
      };
    } catch {
      // 兜底降级：一次失败的补全不应打断输入；空 items + truncated=false 表示"确实没有候选"。
      return { items: [], truncated: false };
    }
  };
}

// 把输入框 token 拆成"目录前缀 + 文件名查询"两段。
// 输入：token 形如 "@src/uti"、"src/uti"、"uti"，可有可无的 "@" 触发符会被剥离。
// 输出：directoryToken 保留尾部分隔符（可直接与工作区根拼接），query 为最后一个 "/" 之后的片段；
// 绝对路径（POSIX 或盘符）与包含 ".." 的路径一律返回 undefined，由调用方降级为空候选。
// 纯函数，无副作用；不做物理路径校验，包含性由调用方用 isPathInside 二次确认。
function parseWorkspacePathToken(
  token: string,
): { directoryToken: string; query: string } | undefined {
  // 剥离仅有一个的 "@" 前缀；它只是 UI 触发符，不属于文件路径本身。
  const trimmed = token.replace(/^@/u, "");
  // 同时拦三类绝对路径：POSIX 根、Windows 根分隔符已覆盖前两条，再补 isAbsolute 与盘符正则兜底跨平台输入。
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    isAbsolute(trimmed) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)
  ) {
    return undefined;
  }

  // 先归一化分隔符，用户从 Windows 资源管理器粘贴的反斜杠路径也能被正确拆分。
  const normalized = trimmed.replace(PATH_SEPARATOR_PATTERN, "/");
  // 任意层级出现 ".." 即整体拒绝，而不是尝试消解：与后续 resolve 校验共同构成双保险。
  if (normalized.split("/").some((part) => part === "..")) return undefined;
  const slashIndex = normalized.lastIndexOf("/");
  // 无分隔符表示在根目录按文件名匹配，空 directoryToken 与 resolve 组合后恰好得到工作区根。
  if (slashIndex < 0) {
    return { directoryToken: "", query: normalized };
  }
  // slice 用 slashIndex + 1 保留尾部 "/"，使目录前缀能直接作为 resolve 的相对基准。
  return {
    directoryToken: normalized.slice(0, slashIndex + 1),
    query: normalized.slice(slashIndex + 1),
  };
}

// 判定条目名是否命中查询：空 query 表示"列出全部"，否则做大小写不敏感的子串匹配（非前缀匹配）。
// 纯函数无副作用；只比较 basename，不含目录前缀。
function matchesPathQuery(name: string, query: string): boolean {
  // 空 query 视为通配全部，避免用户刚输入 "src/" 时列表为空。
  if (query.length === 0) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

// 补全候选的排序契约（传给 Array.sort）：目录优先 → basename 前缀命中优先 → 全路径字典序稳定兜底。
// 纯函数；query 只用于前缀判定，比较时统一转小写，保证大小写不敏感排序与匹配口径一致。
function compareWorkspacePathSuggestion(
  left: TuiWorkspacePathSuggestion,
  right: TuiWorkspacePathSuggestion,
  query: string,
): number {
  // 目录排在文件之前：用户按 Tab 时更可能想继续下钻目录。
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  const leftName = basenameFromSuggestion(left.path);
  const rightName = basenameFromSuggestion(right.path);
  const queryLower = query.toLowerCase();
  const leftPrefix = leftName.toLowerCase().startsWith(queryLower);
  const rightPrefix = rightName.toLowerCase().startsWith(queryLower);
  // 前缀命中排在子串命中之前；query 为空时全部命中前缀，等同于跳过这一级比较。
  if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
  // 末级用 localeCompare 而非减法，保证不同语言环境下顺序稳定且可预期。
  return left.path.localeCompare(right.path);
}

// 从已归一化的候选路径中取 basename；目录路径带尾 "/"，需先剥掉再切分。
// 依赖候选 path 始终使用 "/" 分隔符（由 toWorkspaceRelativePath 保证），不处理反斜杠与盘符。
function basenameFromSuggestion(path: string): string {
  // 先去掉目录的尾斜杠，否则 lastIndexOf("/") 会落在末尾并得到空 basename。
  const withoutSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const slashIndex = withoutSlash.lastIndexOf("/");
  // 无分隔符说明是根目录下的单段名称，直接返回。
  return slashIndex < 0 ? withoutSlash : withoutSlash.slice(slashIndex + 1);
}

// 计算条目相对工作区根的路径，并统一成 "/" 分隔符，供补全结果直接回填输入框。
// 返回 undefined 表示不可用：恰好等于根（空串）、越出工作区（以 ".." 开头）、或是跨盘符的绝对路径。
// 纯函数；不做归一化以外的事情，符号链接的真实指向不在这里解析。
function toWorkspaceRelativePath(workspaceDirectory: string, path: string): string | undefined {
  const relativePath = relative(workspaceDirectory, path);
  // 空串意味着条目就是根目录自身；紧接 ".." 或绝对路径都说明越界，统一丢弃以防泄露工作区外内容。
  // 注意这里用 startsWith("..") 而非 === ".."：宁可误杀名为 "..foo" 的条目，也不放过路径穿越。
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }
  // Windows 的 relative 返回反斜杠，统一转换为 "/"，使前端展示与后续 token 拼接口径一致。
  return relativePath.split(sep).join("/");
}

// 判断 path 是否落在 root 内部（含 root 自身），作为补全目录的第二道安全校验。
// 语义：空 relative 表示同一目录，视为"在内部"；以 ".." 开头或仍是绝对路径（跨盘符）即视为越界。
// 纯函数，仅做字符串层判断；不解析符号链接，因此挂载/软链指向外部的场景仍需上游信任工作区根。
function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  // 用"排除法"而非 startsWith(sep)：避免 root 名是 "work" 时把 "workspace2" 误判为内部。
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
