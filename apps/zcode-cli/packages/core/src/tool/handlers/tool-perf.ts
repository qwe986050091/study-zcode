// ============================================================
// 工具遥测与计时工具
// ============================================================
// 定位：handlers 与 executor 共用的"纯函数遥测工具箱"——计时取整、Bash 命令分类/指纹、
// 工作区类型判定、以及 ToolExecutionTelemetry 的读取/合并/挂载。
// 共同约束：这里的函数会被每条工具结果调用，因此都必须 O(有界) 或有界内存；不得读文件、
// 不得发网络、不得抛可避免的异常。
// 隐私边界：只有白名单里的命令名可以进入远端 Trace；原始命令正文、自定义脚本名一律降级为
// "other"，绝不外传 token。
// 挂载方式：perf 以**不可枚举**属性挂在 output 上，模型可见内容与 JSON 序列化都看不到它。

import { createHash } from "node:crypto";
import type { CommandExecutionTelemetry, ToolExecutionTelemetry } from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { analyzeBashCommand } from "./bash-command-parser.js";
import { BASH_COMMAND_REGISTRY } from "./generated/bash-command-registry.js";

// 指纹/分类的边界（全部按 UTF-16 字符数计）：
// - HASH_LENGTH：sha256 十六进制截断到 16 字符，碰撞概率对遥测归因足够低，体积减半。
// - HASH_EDGE_CHARS：只哈希首尾各 4096 字符，避免超大 heredoc 让埋点产生 O(n) 开销。
// - CLASSIFY_PREFIX_CHARS：只看前 2048 字符做分类，防止正文里的 "npm test" 误导分类。
// - MAX_COMMAND_IDENTITY_PARSE_CHARS：超过 8KB 直接放弃解析，宁可少一个 count。
const COMMAND_HASH_LENGTH = 16;
const COMMAND_HASH_EDGE_CHARS = 4096;
const COMMAND_CLASSIFY_PREFIX_CHARS = 2048;
const MAX_COMMAND_IDENTITY_PARSE_CHARS = 8 * 1024;

/**
 * 把毫秒时长归一成非负整数。
 *
 * 输入可以来自 Date.now() 差值、performance 读数或上层透传；NaN/±Infinity → 0，
 * 负数（时钟回拨/计时器误用）→ 0，其余四舍五入。保证遥测里不会出现 NaN 或负时长。
 */
export function roundNonNegativeMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms));
}

// 从起点时间戳算到"现在"的毫秒数，复用 roundNonNegativeMs 的取整/防负语义。
// 不计入等待中的暂停，调用方自己决定在哪两段之间取值。
export function elapsedMsSince(startedAt: number): number {
  return roundNonNegativeMs(Date.now() - startedAt);
}

/**
 * 计算命令的稳定短指纹（16 位十六进制）。
 *
 * 输入构造：`length \0 head`，超长时再补 `\0 tail`。先写长度的理由是两个同长前缀/后缀的
 * 命令不会因为拼接歧义撞成同一输入；只取首尾是因为超大 heredoc 不应让埋点复制整串。
 * 只用于聚合/去重，不能当安全校验用（截断后的 sha256 仍可被构造碰撞）。
 */
export function commandHash(command: string): string {
  const hash = createHash("sha256");
  hash.update(String(command.length));
  hash.update("\0");
  hash.update(command.slice(0, COMMAND_HASH_EDGE_CHARS));
  if (command.length > COMMAND_HASH_EDGE_CHARS) {
    hash.update("\0");
    hash.update(command.slice(-COMMAND_HASH_EDGE_CHARS));
  }
  return hash.digest("hex").slice(0, COMMAND_HASH_LENGTH);
}

/**
 * 把 Bash 命令粗分成固定类别（test/package/git/search/build/network/other/empty）。
 *
 * 只看前 2048 字符、转小写、复用同一份有界前缀——超大 heredoc 不该产生 O(n) 扫描，
 * 正文里出现的 "npm test" 也不该把一条 `cat` 误判成测试。空命令单独归 "empty"。
 * 注意判定顺序有依赖：test 先于 package/build，避免 `npm run test` 落进别的类别；
 * git/search 先于 build，避免 `git grep build` 被归成构建。
 */
export function classifyCommand(command: string): string {
  // Bugfix: Bash command 可能包含超大 heredoc/inline script，遥测分类只看有界前缀，
  // 避免为了埋点复制并扫描完整命令，也避免正文里的 "npm test" 误导命令分类。
  const normalized = command.slice(0, COMMAND_CLASSIFY_PREFIX_CHARS).trimStart().toLowerCase();
  if (!normalized) return "empty";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test|vitest|jest)\b/u.test(normalized)) {
    return "test";
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|update|remove)\b/u.test(normalized)) {
    return "package";
  }
  if (/\bgit\b/u.test(normalized)) return "git";
  if (/\b(?:rg|grep|find|fd)\b/u.test(normalized)) return "search";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile)\b/u.test(normalized)) {
    return "build";
  }
  if (/\b(?:curl|wget|gh\s+api)\b/u.test(normalized)) return "network";
  return "other";
}

/**
 * 解析命令身份，产出遥测可上报的 `{count, name}`。
 *
 * 输入：原始命令字符串（可能含 heredoc/inline script）。
 * 输出：`count` = 解析出的顶层命令数；`name` 只会是公开命令表里的静态可执行名、
 *   "compound"（多命令）、"other"、"empty" 之一。
 * 失败/降级：超 8KB 不解析直接 `{name:"other"}`；有解析错误/不支持语法/动态词也降级为
 *   "other"；`count` 仍尽量保留（它不泄露内容）。
 * 隐私不变量：绝不把原始 token、自定义脚本名或动态表达式写进远端 Trace——只允许白名单
 *   （BASH_COMMAND_REGISTRY）里存在的名字通过。
 */
export function classifySafeCommandIdentity(
  command: string,
): Pick<CommandExecutionTelemetry, "count" | "name"> {
  // 类别和 hash 已经有界，但安全命令名仍会把完整 heredoc/inline script
  // 交给 parser。遥测不能为超大命令额外制造 O(n) CPU/内存；此时宁可少一个 count。
  if (command.length > MAX_COMMAND_IDENTITY_PARSE_CHARS) {
    return { name: "other" };
  }
  const analysis = analyzeBashCommand(command);
  const commandCount = analysis.commands.length;
  if (!command.trim()) return { count: 0, name: "empty" };
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax || analysis.hasDynamicWords) {
    return { count: commandCount, name: "other" };
  }
  if (commandCount !== 1) {
    return {
      count: commandCount,
      name: commandCount > 1 ? "compound" : "other",
    };
  }
  const executable = basename(analysis.commands[0]?.name ?? "").toLowerCase();
  return {
    count: commandCount,
    // 隐私边界：只允许公开命令表中的静态可执行文件名进入远端 Trace；
    // 自定义脚本名和无法判定的动态表达式统一降级，绝不上传原始 token。
    name: Object.hasOwn(BASH_COMMAND_REGISTRY, executable) ? executable : "other",
  };
}

/**
 * 判断当前执行环境的"工作区种类"，供遥测归类。
 *
 * 口径：subagent 会话一律 "unknown"（子代理可能继承父的工作区或跑在别处，不能冒充 local）；
 * 其余返回 "local"。类型里的 "remote" 不由本函数产生——需要区分远端时，调用方必须结合
 * 执行端口的事实，不能把这里的 "local" 当成"一定在本地"。
 */
export function workspaceKind(context: ToolExecutionContext): "local" | "remote" | "unknown" {
  return context.runtimeScope === "subagent" ? "unknown" : "local";
}

// 按 UTF-8 字节计长（不是字符数）。字节预算（maxInlineBytes/maxModelBytes）与落 artifact
// 的判定都用这个口径；中文/emoji 因此不会因为"看起来短"而绕过预算。
export function fileByteCount(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/**
 * 从工具 output 里读出 perf 事实。
 *
 * 只接受"非 null、非数组的对象"，再要求其 `perf` 也是对象——数组/原始值一律返回 undefined，
 * 因为 handler 可能返回任意合法 output，遥测读取不能在这里抛类型错误。
 * 返回的是**裁剪后**的 telemetry（见 compactToolExecutionTelemetry）；空对象也返回 undefined，
 * 让调用方用一次判空决定"是否挂 perf"。
 */
export function readToolExecutionTelemetry(
  output: unknown,
): ToolExecutionTelemetry | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return undefined;
  }
  const perf = (output as { perf?: unknown }).perf;
  if (typeof perf !== "object" || perf === null || Array.isArray(perf)) {
    return undefined;
  }
  return compactToolExecutionTelemetry(perf as ToolExecutionTelemetry);
}

/**
 * 裁剪遥测载荷：只保留 totalMs / permissionWaitMs / detail 三个字段。
 *
 * 为什么只留这些：perf 会进入远端 Trace，输出字节数、命令正文等大字段已经在别的通道
 * 上报；这里保持固定小集合，避免遥测随工具字段增长而失控。全部字段缺失时返回 undefined。
 */
export function compactToolExecutionTelemetry(
  perf: ToolExecutionTelemetry,
): ToolExecutionTelemetry | undefined {
  const compact: ToolExecutionTelemetry = {
    ...(perf.totalMs !== undefined ? { totalMs: perf.totalMs } : {}),
    ...(perf.permissionWaitMs !== undefined ? { permissionWaitMs: perf.permissionWaitMs } : {}),
    ...(perf.detail ? { detail: perf.detail } : {}),
  };
  return Object.keys(compact).length > 0 ? compact : undefined;
}

/**
 * 合并多份遥测，后者覆盖前者（Object.assign 语义），再统一裁剪。
 *
 * 用途：executor 自己的计时与 handler 上报的 perf 需要汇成一条；同名字段以更靠近执行点的
 * 来源为准。传入 undefined 是常态（handler 没挂 perf），Object.assign 会忽略它们。
 */
export function mergeToolExecutionTelemetry(
  ...items: (ToolExecutionTelemetry | undefined)[]
): ToolExecutionTelemetry | undefined {
  return compactToolExecutionTelemetry(Object.assign({}, ...items));
}

/**
 * 把 perf 挂到 output 上。
 *
 * 用 defineProperty 而非赋值：`enumerable:false` 保证它不会进入模型可见内容、JSON.stringify
 * 与深比较；`configurable/writable:true` 让后续合并可以覆盖。perf 缺席时原样返回同一个
 * 对象——不要为了"形状统一"给每次调用加一个空字段。
 */
export function attachToolExecutionTelemetry<T extends object>(
  output: T,
  perf: ToolExecutionTelemetry | undefined,
): T {
  if (!perf) return output;
  Object.defineProperty(output, "perf", {
    configurable: true,
    enumerable: false,
    value: perf,
    writable: true,
  });
  return output;
}

// 手写按分隔符切分而不是用 node:path.basename：这里只处理"可执行名"，且入参可能来自
// POSIX 风格命令字符串（Windows 开发机上也可能出现 /usr/bin/x），不能用宿主平台的
// 路径规则去猜。找不到分隔符时返回整串。
function basename(value: string): string {
  return value.split(/[\\/]/u).at(-1) ?? "";
}
