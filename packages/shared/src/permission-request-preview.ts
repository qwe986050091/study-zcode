// 文件 permission-request-preview.ts 是权限请求预览的纯函数归一化层，无 I/O、无模块级可变状态、不依赖外部包。
// 职责：把各工具差异极大的 raw/input 结构收敛成 {title, command, filePaths, scope, fileChange, fileChanges} 六字段预览。
// 调用方是权限确认 UI 与审计日志；任何结构变动都会直接改变用户看到的命令文本与待改文件清单。
// 契约：所有导出函数对任意 unknown 输入都必须返回确定结构，绝不抛出，因为权限弹窗不能因解析失败而崩溃。
// 纯函数约束：不使用模块级可变状态，seen 集合与累积数组都由调用链新建，便于并发调用与单元测试复现。
// INV-01 顶层入口永不抛出：getPermissionRequestPreview 只用 typeof、in、Array.isArray 判定，改成正则或 JSON.parse 会引入异常路径。
// INV-02 输入信封优先取 rawInput：readPermissionInputSource 决定命令来源，调换优先级会让新协议的 input 字段被旧结构遮蔽。
// INV-03 键名大小写不敏感：所有键比较都先走 key.toLowerCase()，去掉会把 ShellCommand 这类驼峰键整体漏掉。
// INV-04 命令键集合封闭：COMMAND_KEYS 只认 command/cmd/script/shellcommand，新增键需同步评估把路径误当命令的误报。
// INV-05 参数拼接在命令成立之后：getCommandFromRecord 先确认命令非空再找 args，顺序颠倒会产出前导空格的脏命令。
// INV-06 空白命令视为缺失：normalizeBlockText 后长度为零即跳过，否则 UI 会渲染空命令行且 scope 误判为 command。
// INV-07 所有递归必须有环检测：四个递归函数都依赖 seen 集合，删掉即对自引用 JSON 造成栈溢出。
// INV-08 seen 由调用方注入而非共享：跨函数复用会污染后续收集的可见性，导致后续子树被跳过。
// INV-09 文件路径上限为 6：MAX_PERMISSION_FILE_PATHS 在每个递归入口与循环内前置判断，删掉会让超大 diff 的遍历量失控。
// INV-10 路径去重按规范化字符串：pushUniquePath 先 trim 再比较，否则带首尾空格的同一路径会重复展示。
// INV-11 目录键必须跳过：IGNORED_DIRECTORY_KEYS 排除 cwd/directory/workingdirectory，漏掉会把工作目录当成待改文件。
// INV-12 路径键集合决定命中面：FILE_PATH_KEYS 覆盖 path/file_path/filepath/target 等，缺一个就退化成只剩标题的通用预览。
// INV-13 显式 path 字段优先于深挖：extractPathsFromCandidate 先取 value.path 再遍历其余值，保证主路径排在列表首位。
// INV-14 变更类型只认 add 与 update：collectFileChanges 做白名单校验，放开会把 delete/rename 混进新增与修改计数。
// INV-15 变更去重按 path 与 type 二元组：同路径不同 type 是两条合法记录，只按 path 去重会丢失信息。
// INV-16 单值 fileChange 仅在唯一时成立：fileChanges 长度恰为 1 才回填，否则置 null，防止 UI 用错单文件摘要。
// INV-17 scope 优先级固定为 command 高于 file 高于 generic：三元链顺序即产品语义，调换会把带路径的命令请求降级。
// INV-18 title 兜底链 title 到 description 到 kind 到 permission：任一环得到空串都继续下探，保证标题永不为空。
// INV-19 文本归一化分工明确：行内版压平所有空白用于标题与路径，块版只统一换行用于命令，混用会破坏多行脚本。
// INV-20 遍历顺序依赖 Object.entries 的插入序：不排序是为贴近工具原始语义，改成排序会改变多候选项的命中优先级。
// 失败路径总述：非法结构一律返回空数组或 null 而非抛错；权衡是牺牲诊断信息，换取权限弹窗的绝对可用性。
import type { ZCodePermissionRequest } from "./zcode-task-types-core.js";

export type PermissionRequestScope = "command" | "file" | "generic";

export interface PermissionRequestPreview {
  title: string;
  command: string | null;
  filePaths: string[];
  scope: PermissionRequestScope;
  fileChange: PermissionRequestFileChange | null;
  fileChanges: PermissionRequestFileChange[];
}

export interface PermissionRequestFileChange {
  path: string;
  type: "add" | "update";
}

// 命令键白名单：大小写不敏感匹配，覆盖 command/cmd/script/shellcommand 四种历史写法。
// [权衡] 集合刻意保持封闭，宁可漏识别也不把 file/path 之类键当成命令，误报命令会让用户以为要执行脚本。
// 新增键时必须同步单测，否则旧工具（如 shell 包一层）可能被识别成 generic 预览。
const COMMAND_KEYS = new Set(["command", "cmd", "script", "shellcommand"]);
// 参数键白名单：只在命令键已命中之后才会被读取，用于把 argv 数组拼成一行可读命令。
// [失败路径] 缺失时直接返回裸命令且不抛错，UI 仍能展示主命令。
const ARGUMENT_KEYS = new Set(["args", "argv", "arguments"]);
// 路径键白名单：所有可能承载待改文件路径的字段名，匹配前统一转小写。
// [权衡] 覆盖偏宽（path/file/target/location 等）以兼容各工具 schema，代价是可能多收集到非文件字段。
// 该集合是“预览是否存在文件”的唯一开关，删减必须回到真实请求样本上回归。
const FILE_PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  // ZCode Agent edit 权限常把目标文件放在 file_path/filePath，漏掉会让权限预览只剩标题。
  "file_path",
  "filepath",
  "files",
  "filename",
  "filenames",
  "target",
  "targets",
  "location",
  "locations",
]);
// 目录类键显式排除：cwd 与 directory 是执行上下文，不是本次要改的文件。
// 漏掉排除会把工作目录塞进 filePaths，让 scope 误判为 file。
const IGNORED_DIRECTORY_KEYS = new Set(["cwd", "directory", "workingdirectory"]);
// 文件路径硬上限 6：既是权限弹窗一屏可读量，也是递归遍历的熔断阈值。
// [资源] 每层递归入口与循环内都做长度判定，保证最坏情况下遍历工作量有固定上界。
// 调整该值会同时影响 UI 布局与遍历开销，必须成对评估。
const MAX_PERMISSION_FILE_PATHS = 6;

// 类型守卫：排除 null 与数组，只放行普通对象，避免把数组当对象按键取值。
// [契约] isRecord 排除 null 与数组：所有递归入口先判型，作为环检测之外的第二道防线。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 行内归一化：trim 后把连续空白压成单空格，用于标题与路径展示。
// [失败路径] 入参假定为 string，调用方需先判型，本函数不做兜底转换。
function normalizeInlineText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// 块文本归一化：只把 CRLF 统一为 LF，保留换行以维持多行脚本的可读性。
// 与行内版本分工不同，命令必须走这个函数，否则管道与 here-doc 会被压成一行。
function normalizeBlockText(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

// 把未知值收敛成去空串的字符串数组，供 argv 等参数位使用。
// 非数组一律返回空数组，保证上层拼接逻辑无需再判型。
// 字符串 trim 后保留，数字/布尔/bigint 转字符串，兼容 JSON 里被写成标量的参数。
// 其余类型（对象、null、undefined）先映射为空串，再在 filter 阶段统一丢弃。
// [代价] 静默丢弃无法表达的参数，换取拼接结果永远可展示。
function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }

      if (typeof item === "number" || typeof item === "boolean" || typeof item === "bigint") {
        return String(item);
      }

      return "";
    })
    .filter((item) => item.length > 0);
}

// 从 raw 信封里解出真正的工具入参，命令搜索只在这个子树内进行。
// 非对象直接原样返回，允许 raw 本身是字符串或数组的旧格式。
// rawInput 存在且不为 undefined 时优先，兼容早期 agent 协议。
// 否则回退到 input 字段，ZCode protocol 的 requestPermission 用它承载工具参数。
// [失败路径] 两者都缺失时返回整个 raw，让后续递归兜底而不是在这一层判死。
function readPermissionInputSource(rawSource: unknown): unknown {
  if (!isRecord(rawSource)) {
    return rawSource;
  }

  if ("rawInput" in rawSource && rawSource.rawInput !== undefined) {
    return rawSource.rawInput;
  }

  // ZCode protocol 的 requestPermission schema 使用 input 承载工具参数；
  // 只按旧 rawInput 读取会让 Write/Edit 这类结构化工具退回到通用 JSON 预览。
  return "input" in rawSource ? rawSource.input : rawSource;
}

// 在单层对象上尝试取命令：先按白名单找命令键，再决定是否拼接参数。
// 空命令直接跳过并继续扫描其他键，避免第一个空串阻断后续有效键。
// 参数只取第一个命中的非空数组，多个 argv 别名不做合并，防止重复拼接。
// [权衡] 返回第一个可展示命令而非全部，权限弹窗只展示一条主命令。
function getCommandFromRecord(record: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (!COMMAND_KEYS.has(key.toLowerCase()) || typeof value !== "string") {
      continue;
    }

    const command = normalizeBlockText(value);
    if (command.length === 0) {
      continue;
    }

    for (const [argsKey, argsValue] of Object.entries(record)) {
      if (!ARGUMENT_KEYS.has(argsKey.toLowerCase())) {
        continue;
      }

      const args = getStringArray(argsValue);
      if (args.length > 0) {
        return `${command} ${args.join(" ")}`;
      }
    }

    return command;
  }

  return null;
}

// 深度优先搜索命令：按 rawInput/input/params/toolCall 的固定键序优先下探。
// 字符串只在 allowBareString 为真时被视作命令，防止把普通描述文本误当成待执行命令。
// [并发] seen 由调用方注入且默认每次新建，函数内不共享状态，可安全并发调用。
// 数组与对象进入前先查 seen 再登记，形成环检测，双向引用结构不会无限递归。
// 固定键序搜索失败后才回退到全量 Object.values，保证已知结构优先于任意字段。
// 全部失败返回 null，调用方据此把 scope 降级为 file 或 generic。
function findFirstCommand(
  value: unknown,
  seen: Set<unknown> = new Set(),
  allowBareString = false,
): string | null {
  if (typeof value === "string") {
    if (!allowBareString) {
      return null;
    }

    const command = normalizeBlockText(value);
    return command.length > 0 ? command : null;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);

    for (const item of value) {
      const nestedCommand = findFirstCommand(item, seen);
      if (nestedCommand) {
        return nestedCommand;
      }
    }
    return null;
  }

  if (!isRecord(value) || seen.has(value)) {
    return null;
  }
  seen.add(value);

  const directCommand = getCommandFromRecord(value);
  if (directCommand) {
    return directCommand;
  }

  for (const key of ["rawInput", "input", "params", "toolCall"] as const) {
    if (!(key in value)) {
      continue;
    }

    const nestedCommand = findFirstCommand(
      value[key],
      seen,
      key === "rawInput" || key === "input" || key === "params",
    );
    if (nestedCommand) {
      return nestedCommand;
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (!Array.isArray(nestedValue) && !isRecord(nestedValue)) {
      continue;
    }

    const nestedCommand = findFirstCommand(nestedValue, seen);
    if (nestedCommand) {
      return nestedCommand;
    }
  }

  return null;
}

// 路径写入的唯一入口：先归一化再去重，保证 filePaths 无重复且无首尾空白。
// 空串直接返回，避免空白路径占据上限名额。
// [权衡] 去重基于规范化后的完整字符串，不做 realpath，符号链接会被当作不同文件。
function pushUniquePath(paths: string[], value: string) {
  const normalizedPath = normalizeInlineText(value);
  if (!normalizedPath || paths.includes(normalizedPath)) {
    return;
  }

  paths.push(normalizedPath);
}

// 在单个候选子树里抽取路径，遇到字符串即视为路径候选。
// 对象的 path 字段优先单独提取，确保主路径先于嵌套值进入列表。
// 递归复用注入的 seen 做环检测，并与 collectFilePaths 共享同一集合避免重复遍历。
// 每步之后检查上限并提前返回，控制单次抽取的最坏耗时。
function extractPathsFromCandidate(value: unknown, paths: string[], seen: Set<unknown>): void {
  if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
    return;
  }

  if (typeof value === "string") {
    pushUniquePath(paths, value);
    return;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    for (const item of value) {
      extractPathsFromCandidate(item, paths, seen);
      if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (typeof value.path === "string") {
    pushUniquePath(paths, value.path);
    if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
      return;
    }
  }

  for (const nestedValue of Object.values(value)) {
    extractPathsFromCandidate(nestedValue, paths, seen);
    if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
      return;
    }
  }
}

// 遍历 raw 收集待改文件路径，是 filePaths 字段的唯一来源。
// 数组分支先查环再逐个递归，命中上限立即退出。
// 对象分支按键分发：目录类键跳过，路径类键交给 extractPathsFromCandidate，其余容器继续下探。
// 标量且非路径的键直接忽略，避免把数字或布尔值转成伪路径。
// [资源] 递归深度受原始 JSON 深度约束，靠上限与 seen 双重熔断，防止深嵌套拖垮弹窗。
// 顺序即优先级：先命中的键排在前，UI 截断展示时保留最相关文件。
function collectFilePaths(value: unknown, paths: string[], seen: Set<unknown> = new Set()): void {
  if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
    return;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    for (const item of value) {
      collectFilePaths(item, paths, seen);
      if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  for (const [key, candidate] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (IGNORED_DIRECTORY_KEYS.has(normalizedKey)) {
      continue;
    }

    if (FILE_PATH_KEYS.has(normalizedKey)) {
      extractPathsFromCandidate(candidate, paths, seen);
      if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
        return;
      }
      continue;
    }

    if (!Array.isArray(candidate) && !isRecord(candidate)) {
      continue;
    }

    collectFilePaths(candidate, paths, seen);
    if (paths.length >= MAX_PERMISSION_FILE_PATHS) {
      return;
    }
  }
}

// 收集结构化文件变更，来源是形如 changes 映射的对象。
// 数组与对象都先做环检测，与路径收集共用同一套递归纪律。
// changes 里的条目必须是对象，且 type 严格等于 add 或 update，其他变更类型直接丢弃。
// 去重按 path 与 type 的组合，同路径的新增与修改算两条独立记录。
// [失败路径] 结构不符合预期时静默跳过且绝不抛出，预览宁可缺信息也不能中断确认流程。
function collectFileChanges(
  value: unknown,
  changes: PermissionRequestFileChange[],
  seen: Set<unknown> = new Set(),
): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    for (const item of value) {
      collectFileChanges(item, changes, seen);
    }
    return;
  }

  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (isRecord(value.changes)) {
    for (const [path, change] of Object.entries(value.changes)) {
      if (!isRecord(change)) {
        continue;
      }

      if (change.type !== "add" && change.type !== "update") {
        continue;
      }

      if (changes.some((item) => item.path === path && item.type === change.type)) {
        continue;
      }

      changes.push({
        path,
        type: change.type,
      });
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (!Array.isArray(nestedValue) && !isRecord(nestedValue)) {
      continue;
    }

    collectFileChanges(nestedValue, changes, seen);
  }
}

// 对外唯一入口：把任意权限请求压成固定六字段的预览模型。
// [纯函数] 只读入参并新建局部数组，不写回 request，调用方可在任意上下文重复调用。
// 先收集路径再计算标题与命令，三路解析互不影响，任一失败只影响对应字段。
// fileChange 仅在变更恰好一条时回填，多条时置 null，避免 UI 误用单文件摘要。
// 所有字段都保证不为 undefined：command 用 null，fileChange 用 null，fileChanges 用空数组。
// [权衡] 不做 schema 校验也不打日志，保持无依赖与无副作用，诊断信息交给上游。
export function getPermissionRequestPreview(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
): PermissionRequestPreview {
  const rawSource = request.raw;
  const filePaths: string[] = [];

  collectFilePaths(rawSource, filePaths);

  const title =
    normalizeInlineText(request.title ?? request.description ?? request.kind) || "permission";
  const command = findFirstCommand(readPermissionInputSource(rawSource), new Set(), true);
  const fileChanges: PermissionRequestFileChange[] = [];
  collectFileChanges(rawSource, fileChanges);
  const fileChange = fileChanges.length === 1 ? fileChanges[0]! : null;
  // scope 判定按 command 高于 file 高于 generic 的固定优先级，三元链顺序即产品语义。
  // 只有存在可执行命令才归为 command，带路径但无命令归为 file，其余归为 generic。
  // 调换顺序会让带路径的命令请求被降级，直接影响确认弹窗的展示形态。
  const scope: PermissionRequestScope = command
    ? "command"
    : filePaths.length > 0
      ? "file"
      : "generic";

  return {
    title,
    command,
    filePaths,
    scope,
    fileChange,
    fileChanges,
  };
}
