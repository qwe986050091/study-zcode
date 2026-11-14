/**
 * git 子命令里"参数形态决定是否只读"的回调集合：
 * git 的写能力常常不在子命令名上（tag -d、branch -D、reflog expire、--format 里的签名、
 * remote show 不带 -n 会联网），所以这里逐条按 argv 语义判断。
 * 返回 true 表示危险；返回 false 只代表"没有发现写/联网形态"，上层仍会用 safeFlags 校验其余参数。
 * 由 bash-readonly-policy-git-subcommands-core.ts / -history.ts 的 policy 条目引用；
 * 通过文件末尾的 re-export 汇总到 -callbacks.ts，再被 simple-commands 使用。
 */

export function gitRevisionFormatCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
    // `%G` 会调用 gpg 做签名校验，`%(signature)`/`%(*signature)` 读取提交签名内容，
    // 都可能触发外部程序或读取非仓库内容，因此 format/pretty 里出现即判危险。
    if (
      (arg === "--format" ||
        arg === "--pretty" ||
        arg.startsWith("--format=") ||
        arg.startsWith("--pretty=")) &&
      value
    ) {
      if (/%[-+ ]?G|%\(\*?signature/.test(value)) return true;
    }
  }
  return false;
}

export function gitReflogCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  const allowedSubcommands = new Set(["show", "list"]);
  // expire/delete/drop 会重写或删除 reflog，write 会导入内容，都是写操作。
  const dangerousSubcommands = new Set(["expire", "delete", "exists", "drop", "write"]);
  const firstPositional = args.find((arg) => arg && !arg.startsWith("-"));
  // 第一个位置参数就是 git reflog 的子命令；不在 show/list 内直接判写。
  if (firstPositional && !allowedSubcommands.has(firstPositional)) return true;
  return args.some((arg) => dangerousSubcommands.has(arg));
}

export function gitLsRemoteCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && (arg.startsWith("-") || !arg)) {
      // --sort 是唯一合法的带值选项，跳过它的取值避免把排序字段误当成远端名。
      if (arg === "--sort") index += 1;
      continue;
    }
    // ls-remote 只接受远端名或 URL 作为位置参数；一旦出现位置参数就表示要连接远端。
    return true;
  }
  return false;
}

export function gitRemoteShowCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  const doubleDashIndex = args.indexOf("--");
  const optionArgs = doubleDashIndex === -1 ? args : args.slice(0, doubleDashIndex);
  const positionalArgs = (doubleDashIndex === -1 ? [] : args.slice(doubleDashIndex + 1)).concat(
    optionArgs.filter((arg) => arg !== "-n"),
  );
  if (!optionArgs.includes("-n")) return true;
  // -n 表示只读本地 remotes 配置、不查询远端；缺省时 git 会访问网络。
  if (positionalArgs.length !== 1) return true;
  // 远端名必须是普通标识符；URL、绝对路径、带 `..` 的写法都可能访问本地仓库之外。
  return !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(positionalArgs[0] ?? "");
}

export function gitTagCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return gitListLikeCommandIsDangerous(
    args,
    new Set([
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "--points-at",
      "--sort",
      "--format",
      "-n",
    ]),
  );
}

export function gitBranchCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  return gitListLikeCommandIsDangerous(
    args,
    new Set(["--contains", "--no-contains", "--points-at", "--sort"]),
  );
}

function gitListLikeCommandIsDangerous(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): boolean {
  let hasList = false;
  let afterDoubleDash = false;
  let previousFlag = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) continue;
    if (arg === "--" && !afterDoubleDash) {
      afterDoubleDash = true;
      previousFlag = "";
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (
        arg === "--list" ||
        arg === "-l" ||
        (arg[0] === "-" && arg[1] !== "-" && arg.slice(1).includes("l"))
      )
        hasList = true;
      previousFlag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (!arg.includes("=") && valueFlags.has(previousFlag)) index += 1;
      continue;
    }
    if (!hasList && previousFlag !== "--merged" && previousFlag !== "--no-merged") return true;
    // 没有 --list/-l 时，位置参数是新建/删除的 tag/branch 名；--merged/--no-merged
    // 是唯一允许带 ref 位置参数的列举模式，其余情况一律按写处理。
  }
  return false;
}
