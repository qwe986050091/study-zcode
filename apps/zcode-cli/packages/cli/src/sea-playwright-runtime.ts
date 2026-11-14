// SEA（单文件可执行）形态下 playwright-core 的加载器：把打包进二进制的资源解压到用户缓存目录后按需 require。
// 非 SEA 形态直接走普通依赖解析，保证开发与常规 npm 安装不受影响。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import type { PlaywrightChromiumModule } from "@zcode/adapters/browser";

declare const __CLI_VERSION__: string;

type SeaModule = typeof import("node:sea");

// 清单中的单个文件条目。
interface SeaPlaywrightFile {
  // 落盘后的权限位（POSIX 语义；Windows 上 chmod 基本无效，仅作尽力而为）。
  mode: number;
  // 相对 node_modules 根的路径，必须以 node_modules/playwright-core/ 开头，落盘前会校验。
  path: string;
  // 该文件内容的 SHA-256（十六进制小写），解包时逐文件校验，防止打包损坏或篡改。
  sha256: string;
}

// 整个运行时资源包的清单。
interface SeaPlaywrightManifest {
  // 需要解压的文件全集；空数组会被视为非法资源包。
  files: SeaPlaywrightFile[];
  // 整包哈希，与 target 一起作为缓存目录名与失效判据。
  hash: string;
  // playwright-core 的版本号，参与缓存目录命名，避免不同版本互相污染。
  packageVersion: string;
  // 目标平台标识（如 win-x64），用于隔离不同架构的解包结果。
  target: string;
  // 清单格式版本，当前仅支持 1，其余值直接报错。
  version: 1;
}

// SEA 资源键前缀与两个约定文件名；改动后必须与打包脚本保持一致。
const ASSET_PREFIX = "zcode-playwright-runtime/";
const MANIFEST_ASSET_KEY = `${ASSET_PREFIX}manifest.json`;
// 缓存目录内的完成标记：存在且哈希一致即认为解包完整。
const MARKER_FILE = "playwright-manifest.json";
// 用来判定解包结果的完整性：缺少它说明资源包不完整。
const PACKAGE_JSON_PATH = "node_modules/playwright-core/package.json";

// 加载 playwright-core（Chromium 版本）模块。
// 输入：无；行为由当前进程是否为 SEA 决定。
// 输出：可直接用于启动浏览器的模块对象，接口与普通 `import("playwright-core")` 一致。
// 副作用：SEA 形态下会写用户缓存目录（解压资源），首次调用有磁盘 IO 与哈希校验开销。
// 失败语义：资源缺失、哈希不匹配或解包不完整都会抛错，且不返回降级实现（避免静默不可用）。
// 性能：缓存命中只读一次 marker，不重复哈希全部文件。
export async function loadCliPlaywrightChromium(): Promise<PlaywrightChromiumModule> {
  const sea = await import("node:sea");
  // 非 SEA（源码运行 / 普通安装）直接用标准模块解析，不触碰缓存目录。
  if (!sea.isSea()) {
    return (await import("playwright-core")) as PlaywrightChromiumModule;
  }

  const runtimeDirectory = await ensureSeaPlaywrightRuntime(sea);
  const require = createRequire(join(runtimeDirectory, "zcode-playwright-loader.cjs"));
  return require("playwright-core") as PlaywrightChromiumModule;
}

// 确保 SEA 内嵌的 playwright 运行时已解压到缓存，并返回可用目录。
// 输入：已确认 isSea() 的 node:sea 模块。
// 输出：包含 node_modules/playwright-core 的缓存目录绝对路径。
// 副作用：可能创建 `.tmp-*` 临时目录、写入文件、chmod，并原子 rename 成最终目录。
// 失败语义：任何哈希不符、路径越界或资源缺失都抛错，临时目录留在原位便于排查（不清理已成功目录）。
// 并发安全通过"临时目录 + rename"实现：并发进程各自解包，最后只有一个 rename 成功，其余读到完整目录。
async function ensureSeaPlaywrightRuntime(sea: SeaModule): Promise<string> {
  const manifest = readManifest(sea);
  const cacheDirectory = join(
    cacheBaseDirectory(),
    __CLI_VERSION__,
    manifest.target,
    `playwright-${manifest.packageVersion}-${manifest.hash}`,
  );
  const markerPath = join(cacheDirectory, MARKER_FILE);
  // marker 哈希与 target 都匹配即复用：不重新校验每个文件的内容，避免每次启动都做全量哈希。
  if (await isCacheCurrent(markerPath, manifest)) return cacheDirectory;

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryDirectory, { force: true, recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });

  for (const file of manifest.files) {
    // 先做路径校验再解包：防止恶意/损坏清单把文件写到缓存目录之外。
    assertSafeRuntimePath(file.path);
    const bytes = Buffer.from(sea.getRawAsset(`${ASSET_PREFIX}${file.path}`));
    const hash = createHash("sha256").update(bytes).digest("hex");
    // 逐文件校验哈希：发现不匹配立即失败，不留下半成品缓存（临时目录名带 pid 可区分）。
    if (hash !== file.sha256) {
      throw new Error(`SEA Playwright asset hash mismatch for ${file.path}`);
    }
    const outputPath = join(temporaryDirectory, file.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes);
    await chmod(outputPath, file.mode);
  }

  // package.json 是 require 解析包根的锚点；缺它就说明资源包截断，不能当作可用缓存。
  if (!existsSync(join(temporaryDirectory, PACKAGE_JSON_PATH))) {
    throw new Error("SEA Playwright runtime is missing playwright-core/package.json");
  }
  // marker 写在临时目录内、随 rename 一起就位，保证"可见即有 marker"这一不变量。
  await writeFile(join(temporaryDirectory, MARKER_FILE), JSON.stringify(manifest, null, 2));
  await mkdir(dirname(cacheDirectory), { recursive: true });
  await rm(cacheDirectory, { force: true, recursive: true });
  await rename(temporaryDirectory, cacheDirectory);
  return cacheDirectory;
}

// 读取并校验内嵌清单；字段缺失或版本不符时抛错（不做字段级默认值填充）。
function readManifest(sea: SeaModule): SeaPlaywrightManifest {
  const parsed = JSON.parse(sea.getAsset(MANIFEST_ASSET_KEY, "utf8")) as SeaPlaywrightManifest;
  if (
    parsed.version !== 1 ||
    !parsed.hash ||
    !parsed.packageVersion ||
    !parsed.target ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("Invalid SEA Playwright runtime manifest");
  }
  return parsed;
}

// 判断缓存目录是否与当前清单匹配。
// 输入：marker 路径与期望清单。
// 输出：marker 存在且 hash/target 一致时为 true；读失败、JSON 损坏、字段缺失一律 false（触发重新解包）。
async function isCacheCurrent(
  markerPath: string,
  expected: SeaPlaywrightManifest,
): Promise<boolean> {
  if (!existsSync(markerPath)) return false;
  try {
    const current = JSON.parse(await readFile(markerPath, "utf8")) as SeaPlaywrightManifest;
    return current.hash === expected.hash && current.target === expected.target;
  } catch {
    return false;
  }
}

// 校验清单里的相对路径不会逃出缓存目录，且限定在 node_modules/playwright-core 之下。
// 失败语义：越界或落在其它包目录时抛错，阻断整个解包过程。
function assertSafeRuntimePath(filePath: string): void {
  const normalized = normalize(filePath);
  if (
    normalized.startsWith(`..${sep}`) ||
    normalized === ".." ||
    !normalized.startsWith(`node_modules${sep}playwright-core${sep}`)
  ) {
    throw new Error(`Invalid SEA Playwright asset path: ${filePath}`);
  }
}

// 按平台选择用户缓存根目录（macOS/Linux 遵循各自惯例，Windows 用 LOCALAPPDATA）。
// 失败/降级：homedir 与 XDG/LOCALAPPDATA 都可能缺失，此时退到 homedir 或 tmpdir 下，仍保证返回可用路径。
function cacheBaseDirectory(): string {
  const home = homedir();
  if (platform() === "darwin" && home) {
    return join(home, "Library", "Caches", "zcode", "sea-assets");
  }
  if (platform() === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(home || tmpdir(), "AppData", "Local"),
      "zcode",
      "Cache",
      "sea-assets",
    );
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(home || tmpdir(), ".cache"),
    "zcode",
    "sea-assets",
  );
}
