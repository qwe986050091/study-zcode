// INV-01 非内置搜索不注入：守住位置 类型判断；改错故障 系统搜索被无端改写。
// INV-02 非函数方言不注入：守住位置 方言判断；改错故障 cmd 里出现非法语法。
// INV-03 关闭开关退回原命令：守住位置 空数组分支；改错故障 用户关闭后仍被劫持。
// INV-04 无内容返回原引用：守住位置 三元返回；改错故障 上层判等失效导致重复执行。
// INV-05 先撤别名再定义函数：守住位置 语句顺序；改错故障 旧别名优先于新函数。
// INV-06 Git Bash 保留系统 find：守住位置 方言判断；改错故障 覆盖用户自定义 find。
// INV-07 Windows 路径在 Git Bash 下改写：守住位置 路径归一；改错故障 bash 找不到可执行文件。
// INV-08 UNC 路径同样识别：守住位置 前缀判断；改错故障 网络路径未转换。
// INV-09 函数内先校验后端存在：守住位置 命令探测；改错故障 后端缺失时命令直接报错。
// INV-10 后端缺失退回系统命令：守住位置 或分支；改错故障 搜索完全不可用。
// INV-11 grep 不兼容参数绕回系统：守住位置 分支模式；改错故障 空字节语义被静默改变。
// INV-12 绕回前逐参数扫描：守住位置 循环；改错故障 只检查第一个参数。
// INV-13 rg 回退仅在缺失时定义：守住位置 外壳判断；改错故障 可用 rg 被同名函数遮蔽。
// INV-14 内部命令无原生 rg 不定义：守住位置 早退分支；改错故障 出现必然失败的 rg。
// INV-15 同名 rg 不作回退：守住位置 等值判断；改错故障 探测误报可用。
// INV-16 环境变量赋值先于命令：守住位置 展开顺序；改错故障 后端读到错误分发名。
// INV-17 引用按需加单引号：守住位置 字符判断；改错故障 含空格参数被拆开。
// INV-18 单引号转义完整：守住位置 替换调用；改错故障 参数注入破坏脚本。
//
// 模块职责：生成把 find/grep/rg 指向内置后端的 Bash 启动前缀。
// 状态所有权：无状态；纯字符串拼接，不探测可执行文件。
// 阅读顺序：先看入口与前缀正文，再看三个 shim，最后看调用拼装。
// ============================================================
// 文件定位：生成 Bash 启动前缀，把 find/grep/rg 指向 ZCode 内置搜索后端（bfs/ugrep/rg）。
// 输入输出：输入 backend 描述 + shell 方言，输出可安全 source 的 shell function 文本。
// 副作用：无；纯字符串拼接，不写文件、不探测可执行文件。
// 失败语义：非 embedded-search、非 POSIX 方言或关闭 find/grep 时返回 undefined/原命令。
// 不变量：function 内先 `command -v` 校验后端，失败退回系统命令；不覆盖用户自定义的 find/rg。
// ============================================================
import {
  type EmbeddedSearchBackend,
  type ExecutionEmbeddedSearchPrelude,
  type ExecutionShellSelection,
  windowsPathToGitBashPath,
} from "@zcode/contracts";

// 方言类型直接复用 selection 的 dialect 联合，避免两处枚举漂移。
type EmbeddedSearchPreludeShellDialect = ExecutionShellSelection["dialect"];
// internal-cli/argv0-dispatch 可用 unified invocation；native-binaries 单独按命令分组装。
type EmbeddedSearchCommandBackend = Exclude<EmbeddedSearchBackend, { kind: "native-binaries" }>;

interface EmbeddedSearchPreludeOptions {
  // cmd/legacy-shell 无法定义函数，调用方应期望 undefined。
  shellDialect?: EmbeddedSearchPreludeShellDialect;
}

// ugrep 的 -z/-Z 与 GNU grep 的 null-data 语义不同；这些参数必须绕回系统 grep。
const GREP_BYPASS_CASE_PATTERN =
  "-*-filter*|-*-pager*|-*-view*|-*-format-open*|-*-config*|---*|-@*|-*-save-config*|-[Zz]*|-[!-]*[Zz]*|--null|--null-data";

const BFS_DEFAULT_ARGS = ["-S", "dfs", "-regextype", "findutils-default"] as const;

const UGREP_DEFAULT_ARGS = [
  "-G",
  "--ignore-files",
  "--hidden",
  "-I",
  "--exclude-dir=.git",
  "--exclude-dir=.svn",
  "--exclude-dir=.hg",
  "--exclude-dir=.bzr",
  "--exclude-dir=.jj",
  "--exclude-dir=.sl",
] as const;

// 便捷入口：有前缀内容时拼到命令前面，否则原样返回（引用相等，便于上层判等跳过）。
// 拼接用换行分隔：前缀是完整的 shell 命令行，空格会把两段并成一条命令。
// 前缀为空时原样返回 command，返回值类型恒为 string。
// 走这条直通分支的条件是 buildEmbeddedSearchPreludeContent 返回 undefined。
export function applyEmbeddedSearchPrelude(
  command: string,
  prelude?: ExecutionEmbeddedSearchPrelude,
  options: EmbeddedSearchPreludeOptions = {},
): string {
  const content = buildEmbeddedSearchPreludeContent(prelude, options);
  return content ? [content, command].join("\n") : command;
}

// 生成前缀正文：预先 unalias 再定义 find/grep（以及可选的 rg fallback）。
// 返回 undefined 表示“无需/无法注入”，调用方不应追加空行。
// prelude.kind 不是 embedded-search 时返回 undefined，其他执行路径不受影响。
// shellDialect 为 cmd 或 legacy-shell 时返回 undefined，由 supportsPosixShellFunctionPrelude 判定。
// findAndGrepEnabled === false 时 content 为空数组，join 得到空串而不是 undefined。
export function buildEmbeddedSearchPreludeContent(
  prelude?: ExecutionEmbeddedSearchPrelude,
  options: EmbeddedSearchPreludeOptions = {},
): string | undefined {
  if (prelude?.kind !== "embedded-search") return undefined;
  if (!supportsPosixShellFunctionPrelude(options.shellDialect)) return undefined;

  const backend = normalizeBackendForShell(prelude.backend, options.shellDialect);
  // Windows 不分发 bfs；Git Bash 必须保留系统 find，不能只因存在 fallback 就覆盖用户定义。
  const shouldWrapFind = options.shellDialect !== "git-bash";
  const content =
    prelude.findAndGrepEnabled === false
      ? []
      : [
          // Git Bash 保留系统 find：Windows 不分发 bfs，且用户可能已自定义 find。
          ...(shouldWrapFind ? ["unalias find 2>/dev/null || true"] : []),
          "unalias grep 2>/dev/null || true",
          ...(shouldWrapFind ? [createFindFunction(backend)] : []),
          createGrepFunction(backend),
        ];
  const ripgrepFallback = createRipgrepFallback(backend);
  if (ripgrepFallback) content.push(ripgrepFallback);
  return content.join("\n");
}

// 只有能定义 shell function 的 POSIX 方言（posix/git-bash）才注入；cmd 与 legacy 返回 false。
function supportsPosixShellFunctionPrelude(
  shellDialect: EmbeddedSearchPreludeShellDialect | undefined,
): boolean {
  return shellDialect !== "cmd" && shellDialect !== "legacy-shell";
}

function normalizeBackendForShell(
  backend: EmbeddedSearchBackend,
  shellDialect: EmbeddedSearchPreludeShellDialect | undefined,
): EmbeddedSearchBackend {
  if (shellDialect !== "git-bash") return backend;

  switch (backend.kind) {
    case "native-binaries":
      return {
        ...backend,
        findCommand: normalizeGitBashPathArg(backend.findCommand),
        grepCommand: normalizeGitBashPathArg(backend.grepCommand),
        rgCommand: normalizeGitBashPathArg(backend.rgCommand),
      };
    case "internal-cli":
    case "argv0-dispatch":
      return {
        ...backend,
        command: normalizeGitBashPathArg(backend.command),
        args: backend.args?.map(normalizeGitBashPathArg),
      };
  }
}

// Git Bash 下把 Windows 绝对路径（盘符/UNC）转成 /c/...，否则 bash 里 command -v / exec 会找不到文件。
function normalizeGitBashPathArg(value: string): string {
  return isWindowsAbsolutePath(value) ? windowsPathToGitBashPath(value) : value;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/u.test(value) || value.startsWith("\\\\");
}

// find 的 shim：三种 backend 形态分别拼命令行，统一追加 BFS 默认参数与 "$@"。
// 三种 backend.kind 分别由 switch 分支拼装：internal-cli、argv0-dispatch、native-binaries。
// argv0-dispatch 分支带 BFS_DEFAULT_ARGS，internal-cli 分支不追加默认参数。
// 每个分支末尾都带 "$@"，把 bash 位置参数原样透传给后端。
function createFindFunction(backend: EmbeddedSearchBackend): string {
  switch (backend.kind) {
    case "internal-cli":
      return createFunction(
        "find",
        backend.command,
        `${createCommandInvocation(backend)} find "$@"`,
      );
    case "argv0-dispatch":
      return createFunction(
        "find",
        backend.command,
        `ARGV0=bfs ${createCommandInvocation(backend)} ${BFS_DEFAULT_ARGS.join(" ")} "$@"`,
      );
    case "native-binaries":
      return createFunction(
        "find",
        backend.findCommand,
        `command ${shellQuote(backend.findCommand)} ${BFS_DEFAULT_ARGS.join(" ")} "$@"`,
      );
  }
}

// grep 的 shim：追加 ugrep 的默认安全参数（忽略 ignore 文件、扫隐藏文件、跳过二进制等）。
function createGrepFunction(backend: EmbeddedSearchBackend): string {
  switch (backend.kind) {
    case "internal-cli":
      return createFunction(
        "grep",
        backend.command,
        `${createCommandInvocation(backend)} grep "$@"`,
      );
    case "argv0-dispatch":
      return createFunction(
        "grep",
        backend.command,
        `ARGV0=ugrep ${createCommandInvocation(backend)} ${UGREP_DEFAULT_ARGS.join(" ")} "$@"`,
      );
    case "native-binaries":
      return createFunction(
        "grep",
        backend.grepCommand,
        `command ${shellQuote(backend.grepCommand)} ${UGREP_DEFAULT_ARGS.join(" ")} "$@"`,
      );
  }
}

// rg fallback：仅在 shell 里确实没有 rg 时才定义，避免 command -v 误报可用而调用必失败。
// internal-cli 没有原生 rg，返回 undefined（不恢复无法保留 stdin 的 Node/WASM 转发）。
function createRipgrepFallback(backend: EmbeddedSearchBackend): string | undefined {
  let backendCommand: string;
  let invocation: string;

  switch (backend.kind) {
    case "internal-cli":
      // 兼容 backend 没有原生 rg；不能恢复无法保留 stdin 的 Node/WASM 转发路径。
      return undefined;
    case "argv0-dispatch":
      backendCommand = backend.command;
      invocation = `ARGV0=rg ${createCommandInvocation(backend)} "$@"`;
      break;
    case "native-binaries":
      // 同名 rg 不是独立 fallback：外层检查已经证明 shell 里没有可执行 rg。
      // 此时再定义 rg function 会让 command -v 误报可用，但调用仍只能失败。
      if (backend.rgCommand === "rg") return undefined;
      backendCommand = backend.rgCommand;
      invocation = `command ${shellQuote(backend.rgCommand)} "$@"`;
      break;
  }

  return [
    "if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then",
    "  unalias rg 2>/dev/null || true",
    indentShellContent(createFunction("rg", backendCommand, invocation)),
    "fi",
  ].join("\n");
}

// 生成 function 定义：grep 先走 bypass 参数判断，再校验后端可执行，最后 exec 后端或退回系统命令。
// 先校验后端可执行：command -v backendCommand 失败时函数立即 return。
// 后端缺失时退回系统同名命令，command -v 失败不会让调用方脚本中断。
// grep 额外先走绕回判断。
function createFunction(
  name: "find" | "grep" | "rg",
  backendCommand: string,
  invocation: string,
): string {
  return [
    `${name}() {`,
    ...(name === "grep" ? createGrepBypassLines() : []),
    `  command -v ${shellQuote(backendCommand)} >/dev/null 2>&1 || { command ${name} "$@"; return; }`,
    `  ${invocation}`,
    "}",
  ].join("\n");
}

function indentShellContent(content: string): string {
  return content
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

// ugrep 不兼容的参数（-z/-Z/--null 等）必须绕回系统 grep，否则语义会静默改变。
function createGrepBypassLines(): string[] {
  return [
    "  local _zcode_grep_arg",
    '  for _zcode_grep_arg in "$@"; do',
    `    case "$_zcode_grep_arg" in ${GREP_BYPASS_CASE_PATTERN}) command grep "$@"; return ;; esac`,
    "  done",
  ];
}

// 统一后端调用：先内联 env 赋值（如 ARGV0=bfs），再 `command <cmd> <args...>`，全程单引号转义。
function createCommandInvocation(backend: EmbeddedSearchCommandBackend): string {
  return [
    ...Object.entries(backend.env ?? {}).map(([name, value]) =>
      createShellEnvAssignment(name, value),
    ),
    "command",
    shellQuote(backend.command),
    ...(backend.args ?? []).map(shellQuote),
  ].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createShellEnvAssignment(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}
