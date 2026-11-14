// INV-01 内置剔除：守住位置 裸模块收集；改错故障：把 fs 等内置模块当成待复制依赖。
// INV-02 包名归一：守住位置 作用域包切分；改错故障：作用域包只取到 @scope，解析失败。
// INV-03 可选可缺：守住位置 optional 分支；改错故障：可选依赖缺失让整个打包失败。
// INV-04 必选必在：守住位置 非可选缺失分支；改错故障：发行包静默缺少运行依赖。
// INV-05 工作区回退：守住位置 目录解析兜底；改错故障：未提升的包在 node_modules 找不到。
// INV-06 真实路径：守住位置 realpath 调用；改错故障：软链接导致同一包被复制两份。
// INV-07 首版独占：守住位置 闭包已存在判断；改错故障：后解析版本覆盖先解析版本。
// INV-08 依赖入队：守住位置 dependencies 遍历；改错故障：传递依赖不会被收集。
// INV-09 可选并存：守住位置 optionalDependencies 遍历；改错故障：可选依赖的子依赖被漏掉。
// INV-10 路径归一：守住位置 相对路径转斜杠；改错故障：Windows 分隔符让白名单全部失配。
// INV-11 许可保留：守住位置 许可文件白名单；改错故障：发行包缺少 LICENSE，合规检查失败。
// INV-12 拒绝宿主产物：守住位置 prebuilds 白名单；改错故障：把宿主平台二进制打进目标包。
// INV-13 目标匹配：守住位置 opentui 目标判断；改错故障：跨平台二进制混入发行目录。
// INV-14 嵌套剔除：守住位置 copyPackageDir 过滤；改错故障：node_modules 被整棵复制，体积暴涨。
// INV-15 解引用：守住位置 cp 选项；改错故障：发行包内残留指向工作区的软链接。
// INV-16 平台拆分：守住位置 koffi 目标键推导；改错故障：musl 与 glibc 二进制错配。
// INV-17 缺失可跳：守住位置 access 异常分支；改错故障：缺少某平台预编译导致整批失败。
// INV-18 权限修正：守住位置 spawn-helper chmod；改错故障：非 darwin 平台因缺文件报错。
//
// 模块职责：为服务端发行包解析并复制生产依赖闭包与原生运行文件。
// 状态所有权：无状态；所有结果由入参目录派生，不写全局缓存。
// 阅读顺序：裸模块收集 → 包查找 → 闭包解析 → 白名单 → 目录复制与裁剪。
import { access, chmod, cp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ServerTarget } from "../runtime/manifest.js";

// Node 内置模块不进入发行依赖闭包。
// 用 Set 保证查找为常数时间。
//
const NODE_BUILTIN_MODULES = new Set(builtinModules);

/** 提取 bundle 的顶层裸模块引用，并过滤 Node 内置模块。 */
// 正则同时覆盖 from、import()、require() 与副作用 import。
// 相对与绝对路径不是裸模块，直接跳过。
// node: 前缀显式标记内置模块，同样跳过。
// `@scope/pkg` 取两段，其余包名只取首段。
//
export function collectBareModuleSpecifiers(source: string): Set<string> {
  const names = new Set<string>();
  const specifierPattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = specifierPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier.startsWith("node:")) continue;
    const segments = specifier.split("/");
    const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (!packageName || NODE_BUILTIN_MODULES.has(packageName)) continue;
    names.add(packageName);
  }
  return names;
}

// 读不到或解析失败都返回 null，由调用方决定是可选还是硬失败。
// 不做缓存，文件可能在一次构建中被改写。
//
async function readPackageJson(packageDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

// 从起始目录逐级向上找 node_modules。
// 命中即取真实路径，避免软链接造成同一包重复。
// 到达文件系统根后返回 null，防止死循环。
//
async function findDependencyDir(fromDir: string, name: string): Promise<string | null> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if ((await readPackageJson(candidate)) !== null) return await realpath(candidate);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 从入口包集合递归解析 production + optional dependency 闭包。 */
// `entryPackage` 以可选身份入队：缺入口不阻断构建。
// 依赖优先按 node_modules 解析，失败再回退工作区目录。
// 可选依赖缺失时跳过，必选依赖缺失直接抛错。
// 同名包只保留首个解析结果，多版本由 nested 目录承载。
// 依赖与可选依赖都入队，后者标记为可选。
//
export async function resolveProductionPackageClosure(
  entryPackageNames: readonly string[],
  nodeModulesDir: string,
  workspacePackageDirs: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, string>> {
  const closure = new Map<string, string>();
  const queue: Array<{ name: string; fromDir: string; optional: boolean }> = entryPackageNames.map(
    (name) => ({
      name,
      fromDir: dirname(resolve(nodeModulesDir)),
      optional: true,
    }),
  );

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const packageDir =
      (await findDependencyDir(item.fromDir, item.name)) ??
      workspacePackageDirs.get(item.name) ??
      null;
    if (!packageDir) {
      if (item.optional) continue;
      throw new Error(
        `Missing production dependency in workspace: ${item.name} (from ${item.fromDir})`,
      );
    }
    const existing = closure.get(item.name);
    if (existing) {
      // pnpm peer 依赖可能合法地解析到多个版本。发行根保留首个版本，包自身已知
      // peer 冲突的 nested node_modules 在复制阶段保留。
      continue;
    }
    closure.set(item.name, packageDir);

    const packageJson = await readPackageJson(packageDir);
    const dependencies = (packageJson?.dependencies ?? {}) as Record<string, string>;
    const optionalDependencies = (packageJson?.optionalDependencies ?? {}) as Record<
      string,
      string
    >;
    for (const dependencyName of Object.keys(dependencies)) {
      queue.push({
        name: dependencyName,
        fromDir: packageDir,
        optional: dependencyName in optionalDependencies,
      });
    }
    for (const dependencyName of Object.keys(optionalDependencies)) {
      queue.push({ name: dependencyName, fromDir: packageDir, optional: true });
    }
  }
  return closure;
}

/** node-pty 只保留运行文件与目标平台 prebuild，拒绝宿主 build 产物。 */
// 路径先归一为斜杠形式，跨平台比较才稳定。
// 包清单与许可文件必须保留，发行包需要声明。
// 只放行运行目录与 typings，不带走宿主 build 产物。
// prebuilds 仅保留目标平台子目录。
export function isNodePtyRuntimePath(relativePath: string, target: ServerTarget): boolean {
  const normalized = relativePath.split(sep).join("/");
  if (normalized === "" || normalized === "package.json") return true;
  // 运行文件白名单曾漏掉包内许可；模块拆分后也必须保留发行包所需声明。
  if (/^(?:LICENSE|NOTICE|COPYING)(?:[._-].*)?$/iu.test(normalized)) return true;
  if (normalized === "lib" || normalized.startsWith("lib/")) return true;
  if (normalized === "typings" || normalized.startsWith("typings/")) return true;
  return (
    normalized === "prebuilds" ||
    normalized === `prebuilds/${target}` ||
    normalized.startsWith(`prebuilds/${target}/`)
  );
}

// 只对 opentui 系列按目标过滤。
// 与 `targetPlatform` 无关的包全部保留。
//
export function isTargetSpecificPackage(packageName: string, target: ServerTarget): boolean {
  if (!packageName.startsWith("@mbears/opentui-core-")) return true;
  return packageName === `@mbears/opentui-core-${target}`;
}

// 递归复制并解引用软链接，得到自包含目录。
// 默认剔除任何层级的 node_modules。
// 过滤函数收到相对路径，便于按包定制。
export async function copyPackageDir(
  sourceDir: string,
  targetDir: string,
  filter?: (relativePath: string) => boolean,
  includeNestedNodeModules = false,
): Promise<void> {
  await cp(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const relativePath = relative(sourceDir, source);
      if (relativePath === "") return true;
      if (
        !includeNestedNodeModules &&
        (relativePath === "node_modules" || relativePath.split(sep).includes("node_modules"))
      ) {
        return false;
      }
      return filter ? filter(relativePath) : true;
    },
  });
}

export async function pruneKoffiRuntime(
  sourceDir: string,
  targetDir: string,
  target: ServerTarget,
): Promise<void> {
  const [platform, architecture] = target.split("-");
  const targetKeys =
    platform === "linux"
      ? [`linux_${architecture}`, `musl_${architecture}`]
      : [`${platform}_${architecture}`];
  const sourceBuild = join(sourceDir, "build", "koffi");
  const targetBuild = join(targetDir, "build", "koffi");
  await rm(targetBuild, { recursive: true, force: true });
  await mkdir(targetBuild, { recursive: true });
  for (const targetKey of targetKeys) {
    const sourcePath = join(sourceBuild, targetKey);
    try {
      await access(sourcePath);
    } catch {
      continue;
    }
    await cp(sourcePath, join(targetBuild, targetKey), {
      recursive: true,
      dereference: true,
    });
  }
}

export async function ensureNodePtyPrebuild(
  options: { target: ServerTarget; workspaceNodeModulesDir: string },
  nodeModulesTargetDir: string,
): Promise<void> {
  const prebuildDir = join(nodeModulesTargetDir, "node-pty", "prebuilds", options.target);
  const ptyNodePath = join(prebuildDir, "pty.node");
  let hasPtyNode = true;
  try {
    await access(ptyNodePath);
  } catch {
    hasPtyNode = false;
  }
  if (!hasPtyNode) {
    const lydellDir = await findDependencyDir(
      dirname(resolve(options.workspaceNodeModulesDir)),
      `@lydell/node-pty-${options.target}`,
    );
    const lydellPtyNode = lydellDir
      ? join(lydellDir, "prebuilds", options.target, "pty.node")
      : null;
    if (!lydellPtyNode) {
      throw new Error(
        `Missing node-pty prebuild for ${options.target}: install @lydell/node-pty-${options.target}`,
      );
    }
    await mkdir(prebuildDir, { recursive: true });
    await cp(lydellPtyNode, ptyNodePath, { dereference: true });
  }
  const spawnHelperPath = join(prebuildDir, "spawn-helper");
  try {
    await access(spawnHelperPath);
    await chmod(spawnHelperPath, 0o755);
  } catch {
    // 非 darwin 平台没有 spawn-helper。
  }
}
