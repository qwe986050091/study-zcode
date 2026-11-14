// INV-01 身份判定先于形状猜测：守住位置 resolveToolCallIdentity；改错故障 工具家族判断分叉。
// INV-02 纯对象判定排除数组：守住位置 isPlainRecord；改错故障 数组被当成命令记录。
// INV-03 命令按连接符切段：守住位置 splitCommandSegments；改错故障 混合命令被当成单条。
// INV-04 空段被过滤：守住位置 长度过滤；改错故障 空命令进入只读判定。
// INV-05 剥壳支持登录 shell：守住位置 第一个正则；改错故障 包装命令被误判为执行。
// INV-06 剥壳支持 PowerShell：守住位置 第二个正则；改错故障 Windows 包装命令漏判。
// INV-07 包裹引号成对才剥：守住位置 成对判断；改错故障 单侧引号命令被截断。
// INV-08 字符串入参即候选：守住位置 字符串分支；改错故障 纯字符串命令无法识别。
// INV-09 数组入参取 -lc 后一项：守住位置 下标加一；改错故障 包装命令取到错误片段。
// INV-10 记录数组只读 cmd 字段：守住位置 记录分支；改错故障 结构化命令被整体忽略。
// INV-11 多键合并后去重：守住位置 四键遍历与集合；改错故障 同一命令重复计数。
// INV-12 写命令优先排除：守住位置 写正则先行；改错故障 写操作被当作只读探查。
// INV-13 重定向视为写：守住位置 重定向正则；改错故障 覆盖文件的命令被折叠。
// INV-14 只读命令命中即真：守住位置 读正则判断；改错故障 搜索探查不再折叠。
// INV-15 循环内只读仍算探查：守住位置 循环与读双条件；改错故障 批量查看不被识别。
// INV-16 无命令的 shell 不算执行：守住位置 空命令判断；改错故障 待补命令被标成执行中。
// INV-17 执行判定排除探查：守住位置 两个取反判断；改错故障 同一调用两种状态并存。
// INV-18 本模块不读全局状态：守住位置 纯函数入参；改错故障 判定依赖渲染上下文。
//
// 模块职责：依据工具身份与入参判定 shell 调用属于探查还是执行。
// 状态所有权：无状态；全部为纯函数。
// 阅读顺序：先看身份与命令抽取，再读剥壳与切段，最后看三类判定。
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

// unwrapShellCommand 先 command.trim() 去除首尾空白。
// 登录 shell 取参数之后。
// PowerShell 取命令参数之后。
// 包裹引号成对才剥离。
// 不匹配则原样返回。
function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const stripWrappingQuotes = (value: string) => {
    const normalized = value.trim();
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      return normalized.slice(1, -1).trim();
    }
    return normalized;
  };
  const shellCommandMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i);
  if (shellCommandMatch?.[1]) {
    return stripWrappingQuotes(shellCommandMatch[1]);
  }

  const powershellCommandMatch = trimmed.match(
    /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/i,
  );
  if (powershellCommandMatch?.[1]) {
    return stripWrappingQuotes(powershellCommandMatch[1]);
  }

  return trimmed;
}

function normalizeCommandCandidate(candidate: string): string[] {
  const unwrapped = unwrapShellCommand(candidate);
  if (unwrapped.length === 0) {
    return [];
  }

  return splitCommandSegments(unwrapped);
}

// collectFromValue 把 string 直接 trim 后加入候选。
// collectFromValue 对数组分「纯字符串」与「记录数组」两路。
// 纯字符串数组用 findIndex 定位 -lc，取其后一个元素。
// 找不到 -lc 时用 join 整体拼接。
// 记录数组只读 cmd 字段。
// 候选最后统一走 normalizeCommandCandidate 剥壳并用 Set 去重。
function extractToolCommands(input: unknown): string[] {
  const commandCandidates: string[] = [];

  const collectFromValue = (value: unknown) => {
    if (typeof value === "string") {
      const command = value.trim();
      if (command.length > 0) {
        commandCandidates.push(command);
      }
      return;
    }

    if (!Array.isArray(value)) {
      return;
    }

    if (value.every((item) => typeof item === "string")) {
      const commandParts = value as string[];
      const shellCommandIndex = commandParts.findIndex((part) => part === "-lc");
      if (shellCommandIndex >= 0 && typeof commandParts[shellCommandIndex + 1] === "string") {
        const shellCommand = commandParts[shellCommandIndex + 1]!.trim();
        if (shellCommand.length > 0) {
          commandCandidates.push(shellCommand);
          return;
        }
      }

      const joinedCommand = commandParts.join(" ").trim();
      if (joinedCommand.length > 0) {
        commandCandidates.push(joinedCommand);
      }
      return;
    }

    for (const item of value) {
      if (!isPlainRecord(item)) {
        continue;
      }

      const parsedCommand = item.cmd;
      if (typeof parsedCommand === "string" && parsedCommand.trim().length > 0) {
        commandCandidates.push(parsedCommand.trim());
      }
    }
  };

  collectFromValue(input);

  if (!isPlainRecord(input)) {
    return Array.from(
      new Set(commandCandidates.flatMap((candidate) => normalizeCommandCandidate(candidate))),
    );
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    collectFromValue(input[key]);
  }

  return Array.from(
    new Set(commandCandidates.flatMap((candidate) => normalizeCommandCandidate(candidate))),
  );
}

const EXECUTE_READ_COMMAND_RE =
  /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i;
const EXECUTE_WRITE_COMMAND_RE =
  /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i;
const SHELL_REDIRECT_WRITE_RE = /(^|[^\d<])>>?\s*\S|&>\s*\S/i;
const SHELL_LOOP_RE = /\b(for|while)\b/i;

// 先由 resolveToolCallIdentity 解析工具身份。
// 仅 shell 家族参与。
// extractToolCommands 返回空即视为命令待补。
// 该判定只看 family 与命令数，不区分读写。
// isExploreToolCall 复用同一套命令抽取结果。
export function isShellToolCallAwaitingCommand({ kind, input }: { kind: string; input: unknown }) {
  const identity = resolveToolCallIdentity({ kind, input });
  return identity.family === "shell" && extractToolCommands(input).length === 0;
}

// 写文件家族直接排除。
// file-read、search、web-fetch、explore 四个家族直接返回 true。
// 非 shell 家族一律排除。
// file-write 家族与写命令、重定向先行排除。
// 只读或循环只读视为探查。
export function isExploreToolCall({ kind, input }: { kind: string; input: unknown }) {
  const identity = resolveToolCallIdentity({ kind, input });

  if (identity.family === "file-write") {
    return false;
  }

  if (
    identity.family === "file-read" ||
    identity.family === "search" ||
    identity.family === "web-fetch" ||
    identity.family === "explore"
  ) {
    return true;
  }

  if (identity.family !== "shell") {
    return false;
  }

  const commands = extractToolCommands(input);
  if (commands.length === 0) {
    return false;
  }

  if (commands.some((command) => EXECUTE_WRITE_COMMAND_RE.test(command))) {
    return false;
  }

  if (commands.some((command) => SHELL_REDIRECT_WRITE_RE.test(command))) {
    return false;
  }

  if (commands.some((command) => EXECUTE_READ_COMMAND_RE.test(command))) {
    return true;
  }

  // 有些只读探查会包在 for/while 循环里，例如批量查看 README 或递归扫目录，
  // 这种命令本身不一定以 rg/ls 开头，但仍然属于 explore。
  return commands.some(
    (command) => SHELL_LOOP_RE.test(command) && EXECUTE_READ_COMMAND_RE.test(command),
  );
}

export function isExecuteToolCall({ kind, input }: { kind: string; input: unknown }) {
  const identity = resolveToolCallIdentity({ kind, input });
  return (
    identity.family === "shell" &&
    !isShellToolCallAwaitingCommand({ kind, input }) &&
    !isExploreToolCall({ kind, input })
  );
}
