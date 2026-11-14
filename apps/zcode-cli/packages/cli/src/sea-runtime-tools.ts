// SEA 形态下把内嵌的搜索工具二进制（bfs/ripgrep/ugrep）解压到本地缓存，并以环境变量形式回填路径。
// 非 SEA 形态直接返回空对象，表示"无需注入"，调用方沿用系统已安装的工具。
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getRuntimeToolRuntime, type RuntimeToolId } from "@zcode/shared/runtime-tool-runtime";

type CliEnv = Record<string, string | undefined>;

// node:sea 的最小接口子集，便于测试注入假实现。
export interface SeaRuntimeModule {
  // 读取文本资源；资源不存在时抛错。
  getAsset(key: string, encoding: "utf8"): string;
  // 读取二进制资源；调用方负责校验大小与哈希。
  getRawAsset(key: string): ArrayBuffer;
  // 当前进程是否为打包后的单体可执行文件。
  isSea(): boolean;
}

// 清单中的单个工具条目。
interface SeaRuntimeTool {
  // 落盘后的文件名（仅 basename，不含目录），必须是纯文件名。
  binaryName: string;
  // 工具标识，决定环境变量名与缓存子目录。
  id: RuntimeToolId;
  // 二进制内容的 SHA-256，用于校验完整性并参与缓存目录命名。
  sha256: string;
  // 预期字节数；与哈希一起作为双重校验，可尽早发现截断。
  size: number;
  // 工具自身版本号，参与缓存目录命名，升级后自动换目录。
  version: string;
}

// 整个资源包的清单。
interface SeaRuntimeToolManifest {
  // 目标平台标识（`win|darwin|linux`-`arm64|x64`），必须与运行时一致。
  target: string;
  // 工具集合；空集合视为非法清单。
  tools: SeaRuntimeTool[];
  // 清单格式版本，目前仅支持 1。
  version: 1;
}

// 缓存目录内的完成标记，字段与清单条目一一对应，用于判定缓存是否仍然有效。
interface RuntimeToolMarker {
  // 落盘文件名；与预期不同即视为缓存失效。
  binaryName: string;
  // 工具标识。
  id: RuntimeToolId;
  // 二进制内容哈希。
  sha256: string;
  // 字节数。
  size: number;
  // 生成该缓存的平台目标。
  target: string;
  // 工具版本。
  toolVersion: string;
  // marker 格式版本。
  version: 1;
}

// ensureSeaRuntimeTools 的可选依赖；全部可注入，便于在非 SEA 环境做单测。
export interface EnsureSeaRuntimeToolsOptions {
  // 目标架构，缺省 process.arch。
  arch?: string;
  // 读取已有环境变量（用于跳过用户已显式指定的工具路径），缺省 process.env。
  env?: CliEnv;
  // 目标平台，缺省 process.platform。
  platform?: NodeJS.Platform;
  // node:sea 模块替身；缺省通过 process.getBuiltinModule 获取。
  sea?: SeaRuntimeModule;
  // 缓存根目录；缺省取 ZCODE_STORAGE_DIR，再退到 ~/.zcode。
  storageRoot?: string;
}

// SEA 资源键前缀、清单键与缓存标记文件名；改动需与打包脚本同步。
const assetPrefix = "zcode-runtime-tools/";
const manifestAssetKey = `${assetPrefix}manifest.json`;
const markerFileName = ".zcode-runtime-tool.json";
// 允许出现在清单里的工具白名单：既防拼写错误，也避免解包未知二进制。
const runtimeToolIds = new Set<RuntimeToolId>(["bfs", "ripgrep", "ugrep"]);

// 确保 SEA 内嵌的搜索工具已就绪，并返回需要注入的环境变量。
// 输入：options 全部可选；env 中的既有工具路径优先，不会被覆盖。
// 输出：`{ [binaryEnvVar]: absoluteBinaryPath }`；非 SEA 或用户已指定时对应键不出现在结果里（可能为空对象）。
// 副作用：首次调用会解压二进制到 storageRoot/cache/runtime_tools 并 chmod 0o755；不修改 process.env。
// 失败语义：清单损坏、平台不匹配、大小/哈希不符都会抛错 —— 此时不能继续用系统工具糊弄，否则行为不可预期。
// 不变量：返回的每个路径都指向已校验过的可执行文件，调用方可直接 spawn。
export async function ensureSeaRuntimeTools(
  options: EnsureSeaRuntimeToolsOptions = {},
): Promise<CliEnv> {
  const sea = options.sea ?? getSeaModule();
  // 非 SEA 且无注入时返回空对象：表示"无需设置任何工具路径"，不是错误。
  if (!sea?.isSea()) return {};

  const platform = options.platform ?? process.platform;
  const target = runtimeTarget(platform, options.arch ?? process.arch);
  const manifest = readManifest(sea);
  // 平台不匹配说明拿错了构建产物；继续解包会得到无法执行的二进制，因此直接失败。
  if (manifest.target !== target) {
    throw new Error(
      `SEA runtime tool target mismatch: binary contains ${manifest.target}, runtime is ${target}.`,
    );
  }

  const env = options.env ?? process.env;
  const configuredStorageRoot = options.storageRoot ?? env.ZCODE_STORAGE_DIR?.trim();
  const storageRoot = configuredStorageRoot || join(homedir(), ".zcode");
  const runtimeEnv: CliEnv = {};

  for (const tool of manifest.tools) {
    const runtime = getRuntimeToolRuntime(tool.id);
    // 用户已显式指定该工具路径时尊重其选择，不用内嵌副本覆盖。
    if (env[runtime.binaryEnvVar]?.trim()) continue;

    runtimeEnv[runtime.binaryEnvVar] = await ensureRuntimeTool({
      manifest,
      platform,
      sea,
      storageRoot,
      tool,
    });
  }

  return runtimeEnv;
}

// 确保单个工具二进制在缓存中就位，返回其绝对路径。
// 输入：清单、平台、sea 模块、缓存根目录与具体工具条目。
// 输出：可执行文件的绝对路径（无论缓存命中还是刚解包）。
// 副作用：可能创建临时目录、写文件与 chmod；finally 中总是清理临时目录。
// 并发语义：两个进程同时解包时，后者 rename 失败但会复查缓存，命中即视为成功。
async function ensureRuntimeTool(input: {
  manifest: SeaRuntimeToolManifest;
  platform: NodeJS.Platform;
  sea: SeaRuntimeModule;
  storageRoot: string;
  tool: SeaRuntimeTool;
}): Promise<string> {
  const { manifest, platform, sea, storageRoot, tool } = input;
  const cacheDirectory = join(
    storageRoot,
    "cache",
    "runtime_tools",
    manifest.target,
    tool.id,
    `${tool.version}-${tool.sha256}`,
  );
  const binaryPath = join(cacheDirectory, tool.binaryName);
  const marker = markerFor(manifest, tool);

  // 缓存有效则直接复用；校验包含权限位与内容哈希，能发现被截断或改动过的副本。
  if (await isCacheCurrent(cacheDirectory, marker, platform)) return binaryPath;

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await rm(temporaryDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(temporaryDirectory, {
    recursive: true,
  });

  try {
    const bytes = Buffer.from(sea.getRawAsset(assetKeyFor(tool)));
    // 先比大小再算哈希：截断的资源包用一次比较就能暴露，省掉昂贵的哈希计算。
    if (bytes.byteLength !== tool.size) {
      throw new Error(`SEA runtime tool size mismatch for ${tool.id}.`);
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== tool.sha256) {
      throw new Error(`SEA runtime tool hash mismatch for ${tool.id}.`);
    }

    const temporaryBinaryPath = join(temporaryDirectory, tool.binaryName);
    await writeFile(temporaryBinaryPath, bytes);
    await chmod(temporaryBinaryPath, 0o755);
    await writeFile(join(temporaryDirectory, markerFileName), JSON.stringify(marker, null, 2));

    await mkdir(dirname(cacheDirectory), {
      recursive: true,
    });
    // rename 前再查一次：并发场景下另一进程可能刚装好，命中就不必重复安装。
    if (await isCacheCurrent(cacheDirectory, marker, platform)) return binaryPath;
    await installCacheDirectory(temporaryDirectory, cacheDirectory, marker, platform);
    return binaryPath;
  } finally {
    await rm(temporaryDirectory, {
      force: true,
      recursive: true,
    });
  }
}

// 把临时目录原子地替换成目标缓存目录。
// 输入：已写好的临时目录、目标目录、marker 与平台。
// 输出：无返回值；成功后缓存目录包含完整二进制与 marker。
// 失败语义：EEXIST/ENOTEMPTY 视为并发竞争，删掉旧目录后重试一次；仍失败或其它错误向上抛。
async function installCacheDirectory(
  temporaryDirectory: string,
  cacheDirectory: string,
  marker: RuntimeToolMarker,
  platform: NodeJS.Platform,
): Promise<void> {
  // 最多重试一次：并发安装时冲突是瞬时的，第二次基本能成功；无限重试只会放大竞争。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await rename(temporaryDirectory, cacheDirectory);
      return;
    } catch (error) {
      // 若目标目录此时已经完整（别的进程刚装好），直接采用它，不必删除重装。
      if (await isCacheCurrent(cacheDirectory, marker, platform)) return;
      if (!isDirectoryReplaceRace(error) || attempt === 1) throw error;
      await rm(cacheDirectory, {
        force: true,
        recursive: true,
      });
    }
  }
}

// 读取并校验内嵌清单；解析失败与结构不合法都抛同一类错误，且保留原始 cause。
function readManifest(sea: SeaRuntimeModule): SeaRuntimeToolManifest {
  let manifest: SeaRuntimeToolManifest;
  try {
    manifest = JSON.parse(sea.getAsset(manifestAssetKey, "utf8")) as SeaRuntimeToolManifest;
  } catch (error) {
    throw new Error("Invalid SEA runtime tool manifest.", {
      cause: error,
    });
  }

  validateManifest(manifest);
  return manifest;
}

// 对清单做严格校验：版本、target 格式、工具 id 白名单与去重、文件名字符集、哈希/大小/版本格式。
// 失败语义：任一条件不满足即抛错；这里不接受"尽力修复"，因为后续会按清单内容直接写盘与执行。
function validateManifest(manifest: SeaRuntimeToolManifest): void {
  if (
    manifest?.version !== 1 ||
    typeof manifest.target !== "string" ||
    !/^[a-z0-9]+-(?:arm64|x64)$/u.test(manifest.target) ||
    !Array.isArray(manifest.tools) ||
    manifest.tools.length === 0
  ) {
    throw new Error("Invalid SEA runtime tool manifest.");
  }

  // 同一 id 出现两次会让缓存目录与环境变量冲突，必须在解包前拒绝。
  const seenToolIds = new Set<RuntimeToolId>();
  for (const tool of manifest.tools) {
    if (
      !runtimeToolIds.has(tool?.id) ||
      seenToolIds.has(tool.id) ||
      typeof tool.binaryName !== "string" ||
      basename(tool.binaryName) !== tool.binaryName ||
      !/^[A-Za-z0-9._-]+$/u.test(tool.binaryName) ||
      !/^[a-f0-9]{64}$/u.test(tool.sha256) ||
      !Number.isSafeInteger(tool.size) ||
      tool.size < 0 ||
      typeof tool.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tool.version)
    ) {
      throw new Error("Invalid SEA runtime tool manifest.");
    }
    seenToolIds.add(tool.id);
  }
}

// 判断缓存目录是否可用：marker 字段全等 + 文件存在、大小一致、可执行位存在、内容哈希一致。
// 输出：true 仅当全部条件满足；任意读取异常都吞掉并返回 false（触发重新安装）。
// 代价：命中时也会读一次二进制做哈希，属于用 CPU 换"绝不复用脏文件"的正确性。
async function isCacheCurrent(
  cacheDirectory: string,
  expected: RuntimeToolMarker,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(cacheDirectory, markerFileName), "utf8"),
    ) as RuntimeToolMarker;
    if (
      marker.version !== expected.version ||
      marker.id !== expected.id ||
      marker.toolVersion !== expected.toolVersion ||
      marker.sha256 !== expected.sha256 ||
      marker.target !== expected.target ||
      marker.binaryName !== expected.binaryName ||
      marker.size !== expected.size
    ) {
      return false;
    }

    const binaryPath = join(cacheDirectory, expected.binaryName);
    const binaryStat = await stat(binaryPath);
    if (!binaryStat.isFile() || binaryStat.size !== expected.size) return false;
    if (platform !== "win32" && (binaryStat.mode & 0o111) === 0) return false;

    const actualSha256 = createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex");
    return actualSha256 === expected.sha256;
  } catch {
    return false;
  }
}

// 由清单条目生成对应的缓存 marker；字段必须与 isCacheCurrent 的比较项一一对应。
function markerFor(manifest: SeaRuntimeToolManifest, tool: SeaRuntimeTool): RuntimeToolMarker {
  return {
    binaryName: tool.binaryName,
    id: tool.id,
    sha256: tool.sha256,
    size: tool.size,
    target: manifest.target,
    toolVersion: tool.version,
    version: 1,
  };
}

// 把 Node 的 platform/arch 折算成清单里的 target 标识（win32 → win）。
// 失败语义：不在支持矩阵内的组合直接抛错，避免产出一个永远无法命中的缓存目录。
function runtimeTarget(platform: NodeJS.Platform, arch: string): string {
  const releasePlatform = platform === "win32" ? "win" : platform;
  if (!["darwin", "linux", "win"].includes(releasePlatform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported SEA runtime target ${platform}-${arch}.`);
  }
  return `${releasePlatform}-${arch}`;
}

// 拼出 SEA 内的资源键；带 sha256 段是为了让不同版本的资源互不复用键。
function assetKeyFor(tool: SeaRuntimeTool): string {
  return `${assetPrefix}${tool.id}/${tool.sha256}/${tool.binaryName}`;
}

// 通过 process.getBuiltinModule 取 node:sea；旧版本 Node 无该能力时返回 undefined（按非 SEA 处理）。
function getSeaModule(): SeaRuntimeModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: string) => SeaRuntimeModule | undefined)
    | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

// 判断 rename 失败是否属于"目标已存在"的并发竞争，这类错误值得重试一次。
function isDirectoryReplaceRace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code))
  );
}
