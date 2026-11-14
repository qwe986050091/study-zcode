// ============================================================================
// windowsCuaDevRuntime.ts —— Windows CUA 运行时的开发/产品双模式解析
// ============================================================================
// 【定位】解析出可 spawn 的 helper entry 与原生 addon 路径，并在产品模式下
// 用 runtime-manifest.json 做兼容性与 SHA-256 完整性校验。
//
// 【不变量】
// INV-01：显式开发目录优先且失败即抛，绝不静默回落到安装资源。
//   守住它的位置：resolveWindowsCuaRuntime 的两条分支。
//   破坏后果：开发者改源码却跑的是打包版，排查方向完全错误。
// INV-02：任何工件路径必须是根内的规范相对路径（无盘符、无反斜杠、无 ..）。
//   守住它的位置：isCanonicalRelativeArtifactPath 与 resolveManifestArtifact。
//   破坏后果：目录穿越，扫描或加载根外任意文件。
// INV-03：根与工件都必须是非链接的常规条目，且 realpath 仍与根同源。
//   守住它的位置：requirePackagedRuntimeRoot / requireDevelopmentRuntimeRoot / requireContainedRegularArtifact。
//   破坏后果：junction 或 symlink 让校验对象与实际运行对象不是同一个文件。
// INV-04：产品模式先校验清单再读字节，最后逐项核对 SHA-256。
//   守住它的位置：resolvePackagedRuntime 与 requireArtifactHash。
//   破坏后果：未经验证的原生二进制被加载进主进程。
// INV-05：失败原因只暴露稳定 reason，不泄漏宿主 IO 细节。
//   守住它的位置：各 catch 折叠与 WindowsCuaDevRuntimeResolutionError。
//   破坏后果：诊断随平台或 errno 漂移，UI 无法按 reason 分流。
/* eslint-disable max-lines -- source/product 两种解析模式共享同一稳定错误契约与路径校验，拆开会引入循环依赖 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 as windowsPath } from "node:path";

// 环境变量名属于运维接口：改名等于让所有已配置的开发机静默回落到产品模式，
// 用户只会看到 CUA 不可用，而不是配置没被读取。
const DEV_ROOT_ENV = "ZCODE_CUA_DEV_ROOT";
// 包名必须精确相等：开发目录可能指向 monorepo 里的同名子目录，
// 用包含或前缀匹配会让一个无关包通过校验。
const EXPECTED_PACKAGE_NAME = "@zcode/zcode-cua";
const PACKAGE_JSON = "package.json";
const PRODUCT_RUNTIME_MANIFEST = "runtime-manifest.json";
// 产品运行时的固定相对位置，与打包脚本的复制目标一一对应；
// 改这里必须同步改打包配置，否则产品模式永远找不到清单。
const PRODUCT_RUNTIME_SEGMENTS = ["tools", "cua-helper"] as const;

// 返回的是可直接 spawn 的描述而不是已启动进程：调用方负责生命周期，
// 这里只保证各路径字段都指向已校验的常规文件。
export interface WindowsCuaRuntime {
  root: string;
  entryPath: string;
  addonPath: string;
  command: string;
  commandEnv: Record<string, string>;
}

// 文件系统做成可注入接口：构建与单测要在非 Windows 主机上校验 Windows 清单
// 与符号链接逃逸，不能依赖真实磁盘布局。
// 三个方法可选是为了让只做路径拼装的单测省事；缺省时回落到真实文件系统
export interface WindowsCuaRuntimeFileSystem {
  stat(path: string): Promise<Pick<Stats, "isDirectory" | "isFile">>;
  lstat?(path: string): Promise<Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">>;
  realpath?(path: string): Promise<string>;
  readFile(path: string, encoding?: "utf8"): Promise<string | Uint8Array>;
}

export interface WindowsCuaRuntimeResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  fileSystem?: WindowsCuaRuntimeFileSystem;
  hashBytes?: (bytes: string | Uint8Array) => Promise<string>;
}

// reason 是跨进程稳定契约：UI 与日志按它分流，不允许改成自由文本。
// 每个取值对应一条具体失败路径，新增分支必须同时扩这个联合类型。
export type WindowsCuaDevRuntimeResolutionReason =
  | "unsupported-platform"
  | "development-root-not-absolute"
  | "development-root-not-found"
  | "invalid-package"
  | "missing-helper-entry"
  | "missing-native-addon"
  | "missing-resources-path"
  | "resources-path-not-absolute"
  | "invalid-runtime-manifest"
  | "incompatible-runtime-manifest"
  | "invalid-artifact-path"
  | "artifact-integrity-mismatch";

// 显式设置 name 而不是复用 Error：跨执行上下文时 instanceof 可能失效，
// 上层还能靠 name 识别这一类错误。
export class WindowsCuaDevRuntimeResolutionError extends Error {
  constructor(
    readonly reason: WindowsCuaDevRuntimeResolutionReason,
    message: string,
    readonly artifact?: string,
  ) {
    super(message);
    this.name = "WindowsCuaDevRuntimeResolutionError";
  }
}

// 默认实现只做最薄的一层转发：任何路径归一化都必须发生在解析逻辑里，
// 否则注入实现与真实实现的行为会分叉。
const defaultFileSystem: WindowsCuaRuntimeFileSystem = {
  stat: (path) => fs.stat(path),
  lstat: (path) => fs.lstat(path),
  realpath: (path) => fs.realpath(path),
  readFile: (path, encoding) =>
    encoding === "utf8" ? fs.readFile(path, encoding) : fs.readFile(path),
};
// 哈希放在可注入位置，是为了让单测伪造校验失败，
// 而不必真的构造一个损坏的二进制文件。
const defaultHashBytes = async (bytes: string | Uint8Array): Promise<string> =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Windows 产品运行时解析边界：
 * - 显式开发目录具有最高优先级，配置错误时 fail closed，不能悄悄改用安装资源；
 * - 产品模式只读取 resources/tools/cua-helper，不搜索源码目录或 node_modules。
 */
// 两条分支的顺序是产品语义：显式开发目录优先，且失败即抛，
// 绝不静默回落到安装资源。
// 未配置开发目录时才走产品模式，后者要求 resourcesPath 存在且绝对。
export async function resolveWindowsCuaRuntime(
  options: WindowsCuaRuntimeResolveOptions = {},
): Promise<WindowsCuaRuntime> {
// 平台判定放在最前面：非 Windows 主机上后续的盘符与反斜杠语义都不成立，
// 提前失败能给出唯一明确的诊断。
  if ((options.platform ?? process.platform) !== "win32") {
    throw new WindowsCuaDevRuntimeResolutionError(
      "unsupported-platform",
      "Windows CUA runtime is only available on win32.",
    );
  }

// trim 后再判空：CI 里常见空值占位，空串必须当成未配置，
// 而不是把当前目录当成开发根。
  const configuredRoot = (options.env ?? process.env)[DEV_ROOT_ENV]?.trim();
  if (configuredRoot) {
    return resolveDevelopmentRuntime(configuredRoot, options.fileSystem ?? defaultFileSystem);
  }

  return resolvePackagedRuntime(options, options.fileSystem ?? defaultFileSystem);
}

// 开发模式校验的是生产者契约：package.json 的 zcodeCuaRuntime 声明
// entry 与 nativeAddon，再用根的 realpath 校验二者都落在根内。
// 这条链是唯一能挡住目录穿越与符号链接替换的地方。
async function resolveDevelopmentRuntime(
  configuredRoot: string,
  fileSystem: WindowsCuaRuntimeFileSystem,
): Promise<WindowsCuaRuntime> {
// 同时接受宿主与 Windows 两种绝对路径判定：在 Linux CI 上校验 Windows 配置时
// 宿主判定返回 false，只看一种会把合法路径误判成相对路径。
// 两者都失败才报 development-root-not-absolute。
  const isHostAbsolute = isAbsolute(configuredRoot);
  const isWindowsAbsolute = windowsPath.isAbsolute(configuredRoot);
  if (!isHostAbsolute && !isWindowsAbsolute) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "development-root-not-absolute",
      `${DEV_ROOT_ENV} must be an absolute path.`,
    );
  }

  // 构建和测试会在非 Windows 主机校验 Windows runtime；宿主 path.isAbsolute
  // 不认识 C:\ 路径，不能在进入可注入文件系统前误判为相对路径。
// 只有 Windows 形态才做 win32.normalize：对 POSIX 路径调它会把正斜杠
// 变成反斜杠，与宿主文件系统语义冲突。
  const root = isHostAbsolute ? resolve(configuredRoot) : windowsPath.normalize(configuredRoot);
  const rootRealPath = await requireDevelopmentRuntimeRoot(fileSystem, root);
// 根必须先是常规目录且不逃逸的物理路径，才允许读取 package.json：
// 顺序反了会让一次穿越读到系统里任意 package.json 并据此拼出工件路径。
  const producerContract = await requireExpectedPackage(
    fileSystem,
    join(root, PACKAGE_JSON),
    rootRealPath,
  );

// 工件路径由清单字段拼出后再做包含性校验：不信任清单里的字符串，
// 同时挡住盘符与 .. 两种 Windows 特有写法。
  const entryPath = resolveManifestArtifact(root, producerContract.entry, "entry");
  await requireContainedRegularArtifact(
    fileSystem,
    rootRealPath,
    entryPath,
// 校验用 rootRealPath 与工件 realpath 的关系：必须在解析链接后比较，
// 否则一个指向根外的 symlink 就能通过字面路径检查。
    producerContract.entry,
    "missing-helper-entry",
    "entry",
  );

// addon 与 entry 分开校验而不是合并成数组：诊断需要精确指出缺的是哪一个，
// 用户据此判断是重跑构建还是重装依赖。
  const addonPath = resolveManifestArtifact(root, producerContract.addon, "addon");
  await requireContainedRegularArtifact(
    fileSystem,
    rootRealPath,
    addonPath,
    producerContract.addon,
    "missing-native-addon",
    "addon",
  );

  return {
    root,
    entryPath,
    addonPath,
    command: process.execPath,
    commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

// 清单字段全部精确匹配（见 hasExactKeys）：多一个字段也算不兼容，
// 因为新版本可能带来新的运行语义，旧加载器没有能力解释它。
interface RuntimeManifest {
  schemaVersion: 1;
  packageName: typeof EXPECTED_PACKAGE_NAME;
  packageVersion: string;
  platform: "win32";
  arch: NodeJS.Architecture;
  electronVersion: string;
  entry: string;
  addon: string;
  sha256: {
    entry: string;
    addon: string;
  };
}

// 产品模式的安全前提是清单可信：先校验 schema、架构与 Electron 版本，
// 再按清单路径读文件并核对 SHA-256。任一步失败都必须 fail closed，
// 不能退化成先启动再验证。
async function resolvePackagedRuntime(
  options: WindowsCuaRuntimeResolveOptions,
  fileSystem: WindowsCuaRuntimeFileSystem,
): Promise<WindowsCuaRuntime> {
// resourcesPath 是 Electron 注入的属性，不在 Process 类型里，
// 因此这里做一次局部类型扩展而不是全局声明。
  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const resourcesPath = (options.resourcesPath ?? processResourcesPath)?.trim();
  if (!resourcesPath) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "missing-resources-path",
      "Windows CUA packaged runtime requires resourcesPath.",
    );
  }
// 必须是宿主绝对路径：相对路径会跟随进程 cwd，
// 而打包后的 cwd 通常是用户目录，能拼出任意位置。
  if (!isAbsolute(resourcesPath)) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "resources-path-not-absolute",
      "Windows CUA packaged runtime resourcesPath must be absolute.",
    );
  }

// 固定两段子目录，不接受任何来自外部输入的偏移：
// 产品模式的可搜索范围必须是一个常量。
  const root = resolve(resourcesPath, ...PRODUCT_RUNTIME_SEGMENTS);
// 后续所有包含性比较都以这个 realpath 为基准：
// 不能改用字面 root，否则 junction 可以把基准整体搬走。
  const rootRealPath = await requirePackagedRuntimeRoot(fileSystem, root);
// 清单文件名是常量，不接受覆盖：允许外部指定等于让调用方
// 用自己准备的清单通过校验。
  const manifestPath = join(root, PRODUCT_RUNTIME_MANIFEST);
// 先确认根是常规目录且不逃逸，再读清单：
// 否则清单本身就可能来自链接目标。
  const manifest = await readRuntimeManifest(fileSystem, manifestPath, rootRealPath);
// 兼容性校验必须早于任何文件读取：一份为别的架构或 Electron 版本准备的清单，
// 即使文件齐全也不能用——原生 addon 的 ABI 不匹配会在 require 时崩进程。
  validateRuntimeManifest(manifest, {
    arch: options.arch ?? process.arch,
    electronVersion: options.electronVersion ?? process.versions.electron,
  });

  const entryPath = resolveManifestArtifact(root, manifest.entry, "entry");
  const addonPath = resolveManifestArtifact(root, manifest.addon, "addon");
  await Promise.all([
    requireContainedRegularArtifact(
      fileSystem,
      rootRealPath,
      entryPath,
      manifest.entry,
      "missing-helper-entry",
      "entry",
    ),
    requireContainedRegularArtifact(
      fileSystem,
      rootRealPath,
      addonPath,
      manifest.addon,
      "missing-native-addon",
      "addon",
    ),
  ]);
// 两个工件并发读取以缩短冷启动；哈希在下一步并发计算，
// 但逐项核对，失败时能指出具体是哪个工件被篡改。
  const [entryBytes, addonBytes] = await Promise.all([
    readRequiredArtifact(fileSystem, entryPath, manifest.entry, "missing-helper-entry", "entry"),
    readRequiredArtifact(fileSystem, addonPath, manifest.addon, "missing-native-addon", "addon"),
  ]);
// 注入优先于默认实现：单测用它伪造不匹配，生产路径始终是 sha256。
  const hashBytes = options.hashBytes ?? defaultHashBytes;
// 哈希算法固定 sha256 且与清单字段同名：换算法会把已发布的清单全部判为不匹配，
// 属于破坏性变更。
  const [entryHash, addonHash] = await Promise.all([hashBytes(entryBytes), hashBytes(addonBytes)]);
// 逐项核对而不是一次性比较拼接值：错误信息能直接指出是 entry 还是 addon，
// 也避免拼接引入分隔符歧义。
  requireArtifactHash(entryHash, manifest.sha256.entry, "entry");
  requireArtifactHash(addonHash, manifest.sha256.addon, "addon");

  return {
    root,
    entryPath,
    addonPath,
    command: process.execPath,
    commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

// 清单读取把结构不合法统一折叠成 invalid-runtime-manifest：
// 底层错误文本（ENOENT、EACCES、JSON 位置）不外泄，诊断保持稳定可断言。
async function readRuntimeManifest(
  fileSystem: WindowsCuaRuntimeFileSystem,
  manifestPath: string,
  rootRealPath: string,
): Promise<RuntimeManifest> {
  try {
    const stats = await lstatFile(fileSystem, manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
// 先判类型再判链接：两者任一成立都说明清单不是一个可信的普通文件，
// 后续 realpath 复核只是第二道防线。
      throw new Error("manifest is not a regular file");
    }
// 先 lstat 拒绝链接，再 realpath 复核包含关系：两道检查针对不同攻击面，
// 只做其中一个都会留下链接到根外清单的缺口。
    const manifestRealPath = await realpathFile(fileSystem, manifestPath);
    if (!isPathContainedBy(rootRealPath, manifestRealPath)) {
      throw new Error("manifest escapes runtime root");
    }
    const contents = await fileSystem.readFile(manifestPath, "utf8");
    if (typeof contents !== "string") throw new Error("manifest is not text");
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("manifest is not an object");
    }
    return value as RuntimeManifest;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "invalid-runtime-manifest",
      `Windows CUA packaged runtime has an invalid ${PRODUCT_RUNTIME_MANIFEST}.`,
      PRODUCT_RUNTIME_MANIFEST,
    );
  }
}

// 产品根的 realpath 必须与字面路径是同一物理路径：
// 一个指向别处的 junction 会让整个 tools/cua-helper 变成可替换内容。
async function requirePackagedRuntimeRoot(
  fileSystem: WindowsCuaRuntimeFileSystem,
  root: string,
): Promise<string> {
  try {
    const stats = await lstatFile(fileSystem, root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
// lstat 不跟随链接，因此这里能直接看出替换：若用 stat，
// 链接目录会表现为普通目录，后面的 realpath 比较才可能发现。
// 非目录一律拒绝，不尝试猜测下一个候选位置。
      throw new Error("runtime root is not a regular directory");
    }
    const rootRealPath = await realpathFile(fileSystem, root);
    if (!samePhysicalPath(root, rootRealPath)) {
      throw new Error("runtime root resolves outside its packaged location");
    }
    return rootRealPath;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "invalid-runtime-manifest",
      `Windows CUA packaged runtime has an invalid ${PRODUCT_RUNTIME_MANIFEST}.`,
      PRODUCT_RUNTIME_MANIFEST,
    );
  }
}

// 这个函数是清单可信的唯一判定点：字段集合、枚举值、哈希格式全部通过才返回。
// 任何一项放松都等于允许加载未经验证的二进制。
// [权衡] 用一个大布尔表达式而不是逐项抛错：诊断对外只暴露
// incompatible-runtime-manifest 一种，逐项分支没有额外信息量。
function validateRuntimeManifest(
  manifest: RuntimeManifest,
  expected: { arch: NodeJS.Architecture; electronVersion?: string },
): void {
  const hashPattern = /^[0-9a-f]{64}$/u;
// 精确键集而不是包含必需键：多出的字段意味着清单来自更新的生成器，
// 其语义当前加载器无法保证。
  const hasExactManifestKeys = hasExactKeys(manifest, [
    "schemaVersion",
    "packageName",
    "packageVersion",
    "platform",
    "arch",
    "electronVersion",
    "entry",
    "addon",
    "sha256",
  ]);
  const hasExactHashKeys =
    manifest.sha256 !== null &&
    typeof manifest.sha256 === "object" &&
    hasExactKeys(manifest.sha256, ["entry", "addon"]);
  const compatible =
    hasExactManifestKeys &&
    manifest.schemaVersion === 1 &&
    manifest.packageName === EXPECTED_PACKAGE_NAME &&
    isNonEmptyTrimmedString(manifest.packageVersion) &&
    manifest.platform === "win32" &&
// 先限定支持的两个架构再比对期望值：只比对期望值会让一个写错的
// arch 字符串在恰好相同时通过。
    (manifest.arch === "x64" || manifest.arch === "arm64") &&
    manifest.arch === expected.arch &&
    typeof expected.electronVersion === "string" &&
    expected.electronVersion.length > 0 &&
    manifest.electronVersion === expected.electronVersion &&
    typeof manifest.entry === "string" &&
    typeof manifest.addon === "string" &&
    manifest.entry !== manifest.addon &&
    hasExactHashKeys &&
    hashPattern.test(manifest.sha256.entry) &&
    hashPattern.test(manifest.sha256.addon);
  if (compatible) return;
  throw new WindowsCuaDevRuntimeResolutionError(
    "incompatible-runtime-manifest",
    `Windows CUA packaged runtime ${PRODUCT_RUNTIME_MANIFEST} is incompatible with this runtime.`,
    PRODUCT_RUNTIME_MANIFEST,
  );
}

// 开发根的校验与产品根同构：拒绝链接目录，且 realpath 必须等于配置值。
// 少了这一步，一个 junction 就能让后续所有包含性校验以攻击者指定的根为基准。
async function requireDevelopmentRuntimeRoot(
  fileSystem: WindowsCuaRuntimeFileSystem,
  root: string,
): Promise<string> {
  try {
    const stats = await lstatFile(fileSystem, root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("development root is not a regular directory");
    }
    const rootRealPath = await realpathFile(fileSystem, root);
    // 根因：stat 会跟随 symlink/junction；开发目录必须绑定到用户显式配置的物理根。
    if (!samePhysicalPath(root, rootRealPath)) {
      throw new Error("development root resolves outside its configured location");
    }
    return rootRealPath;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "development-root-not-found",
      `${DEV_ROOT_ENV} must reference an existing regular directory.`,
    );
  }
}

// 已 trim 是刻意要求：版本号或包名带前后空白说明清单被手改过，
// 这类清单不应被当作可信输入。
function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

// 双向排序后逐位比较：集合相等比长度加包含判定更严格，
// 顺序无关，也不依赖对象键的插入顺序。
function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

// 工件路径的三重约束：字面必须是规范相对路径、拼出后必须在根内、且非空。
// 前两条用字符串判定，第三条用 relative 复核，
// 因为不同平台对绝对的定义不一致。
function resolveManifestArtifact(root: string, artifact: string, field: "entry" | "addon"): string {
  // 测试和构建编排可能在非 Windows 主机上检查 Windows 清单；仅用宿主 path.isAbsolute
  // 会把 C:\... 误判成相对路径，因此同时按 Windows 路径语义 fail closed。
  if (!isCanonicalRelativeArtifactPath(artifact)) {
    throwInvalidArtifactPath(field);
  }
// Windows 形态的根必须用 win32.join 拼：在 Linux 上 resolve 会把盘符路径
// 当成相对路径，拼出当前目录下的混合路径。
  const artifactPath =
    windowsPath.isAbsolute(root) && !isAbsolute(root)
      ? join(root, ...artifact.split("/"))
      : resolve(root, ...artifact.split("/"));
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throwInvalidArtifactPath(field);
  }
  return artifactPath;
}

// 规范的含义是可逆：normalize 后把反斜杠换成斜杠必须与原串完全相等，
// 这样 a/./b、a//b、反斜杠写法、盘符前缀全部被拒，
// 同一工件不会存在多个合法写法。
// 段内也不允许冒号（Windows 数据流）与 NUL 字节。
function isCanonicalRelativeArtifactPath(artifact: unknown): artifact is string {
  if (
    typeof artifact !== "string" ||
    !artifact ||
    artifact.includes("\\") ||
    isAbsolute(artifact) ||
    windowsPath.isAbsolute(artifact) ||
    windowsPath.normalize(artifact).replaceAll("\\", "/") !== artifact
  ) {
    return false;
  }
  return !artifact
    .split("/")
    .some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        segment.includes("\0"),
    );
}

// 工件的四步校验：lstat 存在、非链接、是常规文件、realpath 仍在根内。
// [失败路径] 不存在与越界用不同 reason：前者提示重跑构建，
// 后者是安全事件，不能混为一谈。
// 根内的链接也拒绝：它能让同一路径在两次校验之间被替换。
async function requireContainedRegularArtifact(
  fileSystem: WindowsCuaRuntimeFileSystem,
  rootRealPath: string,
  artifactPath: string,
  artifact: string,
  missingReason: "missing-helper-entry" | "missing-native-addon",
  artifactKind: "entry" | "addon",
): Promise<void> {
  let stats: Pick<Stats, "isFile" | "isSymbolicLink">;
  try {
    stats = await lstatFile(fileSystem, artifactPath);
  } catch {
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
// 链接一律拒绝，即使指向根内：无法保证校验的对象就是最终运行的对象。
  if (stats.isSymbolicLink()) {
    throwInvalidArtifactPath(artifactKind);
  }
  if (!stats.isFile()) {
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
  try {
    const artifactRealPath = await realpathFile(fileSystem, artifactPath);
    if (!isPathContainedBy(rootRealPath, artifactRealPath)) {
      throwInvalidArtifactPath(artifactKind);
    }
  } catch (error) {
    if (error instanceof WindowsCuaDevRuntimeResolutionError) throw error;
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
}

// 统一出口保证 reason 与 artifactKind 的配对不会被写错，
// 也保证 artifact 字段总是回显清单里的原始字符串。
function throwMissingArtifact(
  reason: "missing-helper-entry" | "missing-native-addon",
  artifact: string,
  artifactKind: "entry" | "addon",
): never {
  throw new WindowsCuaDevRuntimeResolutionError(
    reason,
    `Windows CUA runtime is missing required ${artifactKind}: ${artifact}.`,
    artifact,
  );
}

// 可注入方法缺失时回落到真实文件系统：这样省略方法的测试桩
// 不会变成绕过安全校验的后门。
// 两个包装函数是唯一访问注入实现的入口，便于统一审阅。
function lstatFile(
  fileSystem: WindowsCuaRuntimeFileSystem,
  path: string,
): Promise<Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">> {
  return (fileSystem.lstat ?? defaultFileSystem.lstat!)(path);
}

function realpathFile(fileSystem: WindowsCuaRuntimeFileSystem, path: string): Promise<string> {
  return (fileSystem.realpath ?? defaultFileSystem.realpath!)(path);
}

// 包含判定要求相对路径非空且不以 .. 开头：空串意味着候选就是根本身，
// 而工件不能是目录根，因此这里判为不包含。
function isPathContainedBy(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

// Windows 路径比较前必须小写归一：真实盘符大小写常不一致，
// 而 isAbsolute 判定又依赖形态，因此先按 win32 语义判断再归一。
function samePhysicalPath(expected: string, actual: string): boolean {
  const normalize = (path: string): string => {
    if (windowsPath.isAbsolute(path)) return windowsPath.normalize(path).toLowerCase();
    return resolve(path);
  };
  return normalize(expected) === normalize(actual);
}

// 校验通过后仍要单独读：stat 与 read 之间存在 TOCTOU，
// 读失败按缺工件处理，与前面的 reason 保持一致。
async function readRequiredArtifact(
  fileSystem: WindowsCuaRuntimeFileSystem,
  artifactPath: string,
  artifact: string,
  reason: "missing-helper-entry" | "missing-native-addon",
  artifactKind: "entry" | "addon",
): Promise<string | Uint8Array> {
  try {
    return await fileSystem.readFile(artifactPath);
  } catch {
    // stat 与 read 之间文件仍可能被替换/删除；不能把宿主 I/O 细节泄漏成不稳定诊断。
    throw new WindowsCuaDevRuntimeResolutionError(
      reason,
      `Windows CUA runtime is missing required ${artifactKind}: ${artifact}.`,
      artifact,
    );
  }
}

// 越界路径不抛 missing：路径非法通常意味着清单被篡改或生成器写坏了，
// 与文件缺失的运维含义完全不同。
function throwInvalidArtifactPath(field: "entry" | "addon"): never {
  throw new WindowsCuaDevRuntimeResolutionError(
    "invalid-artifact-path",
    `Windows CUA packaged runtime ${field} must be a contained relative artifact path.`,
    field,
  );
}

// 哈希不符是唯一的完整性信号：读到的字节必须与清单声明逐字节一致，
// 否则宁可让 CUA 不可用，也不能把未验证的原生二进制加载进主进程。
function requireArtifactHash(
  actualHash: string,
  expectedHash: string,
  artifact: "entry" | "addon",
): void {
  if (actualHash === expectedHash) return;
  throw new WindowsCuaDevRuntimeResolutionError(
    "artifact-integrity-mismatch",
    `Windows CUA packaged runtime ${artifact} failed SHA-256 verification.`,
    artifact,
  );
}

// 开发模式的 package.json 契约同时锁三件事：包名、版本非空、
// zcodeCuaRuntime.windows 精确含 entry 与 nativeAddon 两个规范化相对路径。
// [失败路径] 所有内部错误在此折叠成 invalid-package，
// 避免把 JSON 解析位置等细节泄漏出去。
async function requireExpectedPackage(
  fileSystem: WindowsCuaRuntimeFileSystem,
  packagePath: string,
  rootRealPath: string,
): Promise<{ packageVersion: string; entry: string; addon: string }> {
  try {
    const stats = await lstatFile(fileSystem, packagePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("package.json is not a regular file");
    }
    const packageRealPath = await realpathFile(fileSystem, packagePath);
    if (!isPathContainedBy(rootRealPath, packageRealPath)) {
      throw new Error("package.json escapes development root");
    }
    const contents = await fileSystem.readFile(packagePath, "utf8");
    if (typeof contents !== "string") throw new Error("package.json is not text");
    const pkg: unknown = JSON.parse(contents);
    if (!isPlainRecord(pkg)) throw new Error("package.json is not an object");
// 只读这一个声明字段：开发模式下不推断默认 entry 路径，
// 隐式约定会让改了构建产物位置却没改清单变成难查的运行时错误。
    const contract = pkg.zcodeCuaRuntime;
    if (
      pkg.name !== EXPECTED_PACKAGE_NAME ||
      !isNonEmptyTrimmedString(pkg.version) ||
      !isPlainRecord(contract) ||
      !hasExactKeys(contract, ["schema", "windows"]) ||
      contract.schema !== 1 ||
      !isPlainRecord(contract.windows) ||
      !hasExactKeys(contract.windows, ["entry", "nativeAddon"]) ||
      !isCanonicalRelativeArtifactPath(contract.windows.entry) ||
      !isCanonicalRelativeArtifactPath(contract.windows.nativeAddon) ||
      contract.windows.entry === contract.windows.nativeAddon
    ) {
      throw new Error("package runtime contract is incompatible");
    }
    return {
      packageVersion: pkg.version,
      entry: contract.windows.entry,
      addon: contract.windows.nativeAddon,
    };
  } catch {
    // 解析和 I/O 失败共用稳定的 package 诊断，避免依赖底层错误文本。
  }
  throw new WindowsCuaDevRuntimeResolutionError(
    "invalid-package",
    `Windows CUA development root package.json must name ${EXPECTED_PACKAGE_NAME} and expose a valid zcodeCuaRuntime contract.`,
    PACKAGE_JSON,
  );
}

// 显式排除数组与 null：JSON.parse 的 null 会通过 typeof 判断，
// 后续 Object.keys 会在 null 上抛 TypeError。
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
