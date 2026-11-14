// 运行时工具解析：为给定 toolId 找到「可执行的真实二进制路径」，并把其目录追加到 PATH 尾部。
// 本文件是纯解析层：不下载、不校验版本、不修改全局 process.env，只产出补丁供调用方合并。
// INV-01：优先级固定为 环境变量显式指定 > ZCODE_SERVER_RUNTIME_ROOT / Electron resourcesPath
// > 跨部署形态的 bundled-tools 候选 > PATH 查找；顺序不可调换，否则开发者本机的同名工具会
// 覆盖随包分发的固定版本。（守住位置：findRuntimeToolBinary 候选数组的顺序）
// INV-02：候选项必须同时通过 existsSync 与 X_OK 才算命中；只判存在会把目录、无执行位的文件
// 当成可用工具。（守住位置：resolveExistingPath / isExecutableFile）
// INV-03：buildRuntimeToolEnvPatch 只追加、不删除 baseEnv 已有条目；PATH 条目先去重再加，
// 避免多个 toolId 落在同一目录时重复。（守住位置：joinUniquePathEntries）
// 破坏后果：顺序颠倒会让「本机另装一版」的机器与打包机行为不一致；未校验执行位则 spawn 才报
// EACCES，且错误点离解析处很远；候选顺序与执行位必须在解析阶段就校验。
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { getRuntimeToolRuntime, type RuntimeToolId } from "@zcode/shared";

// [失败路径] 只信 accessSync(X_OK)：existsSync 为真但不可执行时（目录、ACL 拒绝、无执行位）
// 必须判否，否则会在 spawn 阶段才失败，且 Windows 与 POSIX 的表现不一致。
function isExecutableFile(path: string): boolean {
  try {
    // constants.X_OK 才是可执行判定：F_OK 只证明文件存在，目录与缺执行位的文件都会被它放行。
    // accessSync 抛错统一在 catch 里转 false，因为调用方把 false 当作「继续试下一个候选」，异常会中断整条解析链。
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 按传入顺序返回第一个「存在且可执行」的候选：顺序即优先级，调用方靠数组顺序表达覆盖关系。
// [权衡] 不在这里做软链解析或 realpath 归一：返回路径最终会进 envPatch/PATH，改动它会让日志
// 与实际执行位置不一致；同一路径的重复出现在 joinUniquePathEntries 里统一收敛。
function resolveExistingPath(candidates: Array<string | null | undefined>): string | null {
  // 遍历顺序就是 INV-01 的优先级，函数内不做排序，排在前面的候选先被 existsSync 校验。
  for (const candidate of candidates) {
    // null 项来自缺失的 resourcesPath 与未设置的 ZCODE_SERVER_RUNTIME_ROOT，跳过即可；否则精简安装会整体解析失败。
    if (!candidate) {
      continue;
    }

    // 两重校验缺一不可：只判存在会把目录当成工具，spawn 阶段才抛 EACCES，报错点离这里很远。
    if (existsSync(candidate) && isExecutableFile(candidate)) {
      // 原样返回而不做 resolvePath 归一，否则日志里的路径与 PATH 中的条目对不上。
      return candidate;
    }
  }

  return null;
}

// [权衡] 自己枚举 PATH 而不调用 which/where：后者要多起一个进程，且 Windows 上 where 的输出
// 编码不稳定；这里只需要「给定 env 的可复现查找」，便于测试注入自定义 PATH。
function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // 前置条件：env.PATH 必须与后续 spawn 使用的 env 是同一份快照，否则解析到的路径在子进程里可能不可见。
  // 读入参 env.PATH 而非 process.env.PATH，测试注入自定义 PATH 时才能拿到同一份快照。
  const pathEnv = env.PATH;
  if (!pathEnv) {
    return null;
  }

  // Windows 上裸命令名不带扩展名时，必须按 PATHEXT 逐个拼出候选（node → node.EXE）；PATHEXT
  // 缺失时回退到最常见的四种，否则精简过的环境变量会让解析静默失败。
  // 非 Windows 的 PATHEXT 补全为空数组：命令名本身就是文件名，补 .exe 反而会拼出不存在的路径。
  // PATHEXT 缺失时回退 .EXE/.CMD/.BAT/.COM，否则精简环境变量会让裸命令名永远落空。
  const windowsPathExt =
    process.platform === "win32"
      ? (env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".COM"])
      : [""];
  // 命令名自带扩展名时不再补全，否则会拼出 foo.cmd.EXE 这类永远不存在的候选。
  const extensions =
    process.platform === "win32" && !command.includes(".")
      ? windowsPathExt
      : [""];

  // 空条目来自连续分隔符，直接跳过；POSIX 上空条目语义是 cwd，这里故意不支持，避免当前目录劫持解析。
  // 按 delimiter 切分，POSIX 是冒号而 Windows 是分号；空条目直接跳过，避免当前目录被当成 PATH 项劫持解析。
  for (const pathEntry of pathEnv.split(delimiter)) {
    if (!pathEntry) {
      continue;
    }

    // 扩展名循环嵌在目录循环内部，保证命中次序是「先按 PATH 顺序、再按后缀顺序」。
    for (const extension of extensions) {
      const candidate = join(pathEntry, `${command}${extension}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

// 五种相对根覆盖实际出现过的部署形态：monorepo 根执行、packages/desktop 下执行、打包后 asar
// 的相邻目录，以及 moduleDir 上溯两/三层的安装布局；null 表示该形态无此根，调用方需跳过。
// platformKey 参与路径是因为随包工具按平台与架构分目录，跨架构复用只会拿到不可执行的二进制。
// 顺序即优先级：越贴近当前进程布局的根越先命中，避免误用残留的旧构建产物。
function resolvePlatformScopedBundledToolRoots(moduleDir?: string): Array<string | null> {
  // 前置条件：moduleDir 是当前模块所在目录；内联打包时可能为空，空值候选必须保留给上层跳过。
  // platformKey 必须与打包脚本的目录命名一致，跨架构复用只会拿到不可执行的二进制。
  const platformKey = `${process.platform}-${process.arch}`;
  return [
    // cwd 位于仓库根时命中这一项，这是 pnpm dev 直接起桌面端最常见的布局。
    resolvePath(process.cwd(), "bundled-tools", platformKey),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-tools", platformKey),
    resolvePath(process.cwd(), "..", "desktop", "bundled-tools", platformKey),
    // moduleDir 为空（被内联打包时）该候选为 null，resolveExistingPath 会跳过，不能让 undefined 混进 join。
    moduleDir ? resolvePath(moduleDir, "..", "..", "..", "desktop", "bundled-tools", platformKey) : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-tools", platformKey) : null,
  ];
}

// [权衡] prepend 用于「必须遮蔽系统同名工具」的场景（如内置 node），因此放在最前；去重时保留
// 首次出现的位置，被 prepend 的条目即使原本也在 PATH 里也只保留前置这一份。
export function prependPathEntries(
  currentPath: string | undefined,
  entries: readonly string[],
): string {
  // prepend 会改变同名工具的优先级：只用于必须遮蔽系统同名工具的场景，普通工具应走 append。
  // filter(Boolean) 先剔除空段，否则连续分隔符产生的空串会被当成一个有效目录写回 PATH。
  const normalizedCurrent = currentPath?.split(delimiter).filter(Boolean) ?? [];
  return joinUniquePathEntries([...entries, ...normalizedCurrent]);
}

// 追加而非前置：随包工具目录排在用户 PATH 之后，保证显式安装的同名工具优先，不被悄悄替换。
export function appendPathEntries(
  currentPath: string | undefined,
  entries: readonly string[],
): string {
  // append 保持用户 PATH 优先：随包目录排在后面，用户显式安装的同名工具不会被悄悄替换。
  // 两侧共用同一套空段过滤，prepend 与 append 的归一化口径才能保持一致。
  const normalizedCurrent = currentPath?.split(delimiter).filter(Boolean) ?? [];
  return joinUniquePathEntries([...normalizedCurrent, ...entries]);
}

// 去重而不排序：PATH 语义是「先命中先用」，排序会改变已有条目的优先级，属于越权。
// seen 用原始字符串比较而非大小写归一，因为 POSIX 上大小写不同是两个真实不同的目录。
function joinUniquePathEntries(entries: readonly string[]): string {
  // 输出数组保持输入顺序，PATH 语义是先命中先用，排序会改变已有条目的优先级。
  const nextEntries: string[] = [];
  const seen = new Set<string>();

  // 边遍历边写入 seen，在过滤空串的同时保住每个目录首次出现的位置。
  for (const entry of entries) {
    // 空串与重复项都跳过；空段在 POSIX 上等价于当前目录，会带来目录劫持风险。
    if (!entry || seen.has(entry)) {
      continue;
    }
    // 按原始字符串比较而不做小写归一，POSIX 上 /Bin 与 /bin 是两个真实不同的目录。
    seen.add(entry);
    nextEntries.push(entry);
  }

  // 用 node:path 的 delimiter 拼回，Windows 下得到分号，确保与子进程解析 PATH 的口径一致。
  return nextEntries.join(delimiter);
}

// 契约：返回 null 表示「本机没有可用的该工具」，调用方必须降级或提示，不得抛错；解析失败是
// 常态（精简安装、跨架构包缺失），把它当异常会让整条命令路径不可用。
export function findRuntimeToolBinary(
  toolId: RuntimeToolId,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // 前置条件：env 必须与后续 spawn 使用的 env 是同一份；混用会让解析结果与实际子进程环境不一致。
  // runtime 元数据来自 @zcode/shared，binaryEnvVar 与 bundledResourceDir 只能以共享包为唯一来源。
  const runtime = getRuntimeToolRuntime(toolId);
  // entrySegments 按平台展开，最后一段同时被复用成 PATH 查找的命令名。
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  // 显式环境变量是唯一允许覆盖随包版本的口子：trim 后仍存在且可执行才采用，否则继续向下找，
  // 而不是直接失败——路径过期（卸载后残留）不应让工具整体不可用。
  const envPath = env[runtime.binaryEnvVar]?.trim();
  if (envPath && existsSync(envPath) && isExecutableFile(envPath)) {
    return envPath;
  }

  // resourcesPath 是 Electron 打包后的固定位置；ZCODE_SERVER_RUNTIME_ROOT 则用于服务器/CI 覆盖，
  // 两者都排在 bundled-tools 相对根之前，因为它们更具体、更可预期。
  const resourcesPath =
    typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      : null;
  const runtimeRoot = env.ZCODE_SERVER_RUNTIME_ROOT?.trim();
  const moduleDir: string | undefined = import.meta.dirname;
  // 候选数组的字面顺序就是 INV-01 的优先级实现：改动这里的顺序等于改变部署行为，必须同步文档。
  // 每一个候选都走 resolveExistingPath 的「存在 + 可执行」双重校验，不在这里单独短路。
  const candidate = resolveExistingPath([
    runtimeRoot ? resolvePath(runtimeRoot, "tools", runtime.bundledResourceDir, ...entrySegments) : null,
    resourcesPath ? resolvePath(resourcesPath, "tools", runtime.bundledResourceDir, ...entrySegments) : null,
    ...resolvePlatformScopedBundledToolRoots(moduleDir).map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
  ]);

  // 首个命中直接返回、不再查 PATH，否则用户机器上另装的一版会顶掉随包版本。
  if (candidate) {
    return candidate;
  }

  const binaryName = entrySegments[entrySegments.length - 1];
  if (!binaryName) {
    return null;
  }

  // 末段命令名先去掉 .exe 再交给 PATH 查找：Windows 侧由 PATHEXT 重新补全，保留原后缀会拼出双层扩展名。
  return resolveCommandOnPath(binaryName.replace(/\.exe$/i, ""), env);
}

// 输出是「补丁」而不是完整 env：调用方把它合并进 spawn 的 env，未列出的键保持原样；这样
// 不会把本进程的临时变量泄漏给子进程，也不会覆盖调用方刻意设置的覆盖值。
export function buildRuntimeToolEnvPatch(
  toolIds: readonly RuntimeToolId[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // 只构造增量补丁，保证 baseEnv 的其余键不被复制，避免本进程的临时变量泄漏给子进程。
  const envPatch: Record<string, string> = {};
  const pathEntries: string[] = [];

  for (const toolId of toolIds) {
    const runtime = getRuntimeToolRuntime(toolId);
    // 用 baseEnv 而不是 process.env 解析，同一份快照既决定 PATH 又决定变量值，不会自相矛盾。
    const binaryPath = findRuntimeToolBinary(toolId, baseEnv);
    if (!binaryPath) {
      continue;
    }

    // 每个工具写自己的变量名（由 shared 的 runtime 元数据给出），解析不到则跳过而不写空串。
    // 键名由 runtime.binaryEnvVar 给出，写死字符串会与 shared 元数据脱节。
    envPatch[runtime.binaryEnvVar] = binaryPath;
    pathEntries.push(dirname(binaryPath));
  }

  // 仅在至少命中一个工具时改写 PATH，无命中还写会让子进程环境多出一份内容相同的冗余项。
  if (pathEntries.length > 0) {
    // PATH 只在至少命中一个工具时才改写：无命中仍写 PATH 会制造一份内容相同但语义不同的环境。
    // 走 append 而非 prepend，随包目录排在用户 PATH 之后，显式安装的同名工具仍优先。
    envPatch.PATH = appendPathEntries(baseEnv.PATH, pathEntries);
  }

  return envPatch;
}
