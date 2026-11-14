// TUI 运行时加载器：SEA 形态下把内嵌的 @zcode/tui 解压到缓存目录，再按 file URL 动态 import。
// 非 SEA 直接 import 常规包，保证开发/普通安装路径与本模块无关。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { runTui } from "@zcode/tui";

// 打包时注入的 CLI 版本号；参与缓存目录命名，保证升级后不复用旧解包结果。
declare const __CLI_VERSION__: string;

// 本模块对外只暴露 runTui，避免 TUI 内部实现被意外耦合。
type TuiRuntimeModule = {
  runTui: typeof runTui;
};

// node:sea 类型别名，便于在签名中传递。
type SeaModule = typeof import("node:sea");

// 清单中的单个文件条目。
type SeaTuiRuntimeFile = {
  // 期望权限位；缺省时按扩展名推断（见 modeForPath）。
  mode?: number;
  // 相对缓存根的路径，必须落在 node_modules/@zcode/tui 之下。
  path: string;
  // 文件内容 SHA-256，解包时逐文件校验。
  sha256: string;
};

// 整个 TUI 资源包清单。
type SeaTuiRuntimeManifest = {
  // 文件全集；空数组会让后续 import 失败，因此视为非法清单。
  files: SeaTuiRuntimeFile[];
  // 整包哈希，决定缓存目录并作为失效判据。
  hash: string;
  // 目标平台标识（如 win-x64），跨平台复用缓存会得到无法加载的产物。
  target: string;
  // 清单格式版本，目前仅支持 1。
  version: 1;
};

// 资源键前缀、清单键、入口相对路径与缓存标记文件名；改动需与打包脚本同步。
const assetPrefix = "zcode-tui-runtime/";
const manifestAssetKey = `${assetPrefix}manifest.json`;
// 解包后动态 import 的入口；路径变化会直接导致运行时找不到模块。
const packageEntryPath = "node_modules/@zcode/tui/dist/index.js";
// 缓存目录内的完成标记，存在且 hash/target 一致即认为可用。
const manifestFileName = "manifest.json";

// 加载 TUI 运行时模块。
// 输入：无；形态由 isSea() 判定。
// 输出：含 runTui 的模块对象，可直接调用启动界面。
// 副作用：SEA 下首次调用会解压资源到缓存目录（写盘 + 哈希校验），后续命中缓存只读 marker。
// 失败语义：清单非法、哈希不符或写盘失败均抛错，不做降级（TUI 无法启动时应显式失败）。
export const loadTuiRuntime = async (): Promise<TuiRuntimeModule> => {
  const sea = await import("node:sea");

  // 非 SEA 直接走标准解析；SEA 里没有 node_modules 目录，必须走解包路径。
  if (!sea.isSea()) {
    return await import("@zcode/tui");
  }

  const runtimeDirectory = await ensureSeaTuiRuntime(sea);
  return await import(pathToFileURL(join(runtimeDirectory, packageEntryPath)).href);
};

// 确保 TUI 运行时已解压到缓存，并返回可 import 的目录。
// 输入：已确认 isSea() 的 node:sea 模块。
// 输出：缓存根目录绝对路径（其中包含 packageEntryPath）。
// 副作用：可能创建临时目录、写文件、chmod、删除旧缓存并 rename 新目录。
// 并发语义：临时目录名带 pid+时间戳；先删目标再 rename，最坏情况下另一进程会重建，不影响正确性。
const ensureSeaTuiRuntime = async (sea: SeaModule): Promise<string> => {
  const manifest = readManifest(sea);
  const cacheDirectory = join(
    cacheBaseDirectory(),
    __CLI_VERSION__,
    manifest.target,
    manifest.hash,
  );
  const markerPath = join(cacheDirectory, manifestFileName);

  // 只比较 marker 的 hash/target，不重算每个文件哈希：以一次读取换取启动速度。
  if (await isCacheCurrent(markerPath, manifest)) {
    return cacheDirectory;
  }

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(temporaryDirectory, {
    recursive: true,
  });

  for (const file of manifest.files) {
    const asset = sea.getRawAsset(`${assetPrefix}${file.path}`);
    const bytes = Buffer.from(asset);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    // 哈希不符立即中止：带着损坏的文件去 rename 会得到"看似成功但无法 import"的缓存。
    if (actualHash !== file.sha256) {
      throw new Error(`SEA TUI asset hash mismatch for ${file.path}`);
    }

    const outputPath = join(temporaryDirectory, file.path);
    await mkdir(dirname(outputPath), {
      recursive: true,
    });
    await writeFile(outputPath, bytes);
    await chmod(outputPath, file.mode ?? modeForPath(file.path));
  }

  // marker 随临时目录一起 rename，保证"缓存目录可见时 marker 一定存在"。
  await writeFile(markerPathForDirectory(temporaryDirectory), JSON.stringify(manifest, null, 2));
  // 先清掉旧目录再 rename：Windows 不允许 rename 覆盖已存在的非空目录。
  await rm(cacheDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(dirname(cacheDirectory), {
    recursive: true,
  });
  await rename(temporaryDirectory, cacheDirectory);
  return cacheDirectory;
};

// 读取并校验内嵌清单；版本、hash、files 任一不合法即抛错（不填充默认值）。
const readManifest = (sea: SeaModule): SeaTuiRuntimeManifest => {
  const raw = sea.getAsset(manifestAssetKey, "utf8");
  const manifest = JSON.parse(raw) as SeaTuiRuntimeManifest;
  if (manifest.version !== 1 || !manifest.hash || !Array.isArray(manifest.files)) {
    throw new Error("Invalid SEA TUI runtime manifest.");
  }
  return manifest;
};

// 判断缓存是否与当前清单一致：marker 缺失、读取失败、JSON 损坏、hash/target 不符都返回 false。
const isCacheCurrent = async (
  markerPath: string,
  expected: SeaTuiRuntimeManifest,
): Promise<boolean> => {
  if (!existsSync(markerPath)) return false;

  try {
    const current = JSON.parse(await readFile(markerPath, "utf8")) as SeaTuiRuntimeManifest;
    return current.hash === expected.hash && current.target === expected.target;
  } catch {
    return false;
  }
};

// 按平台选择缓存根目录（macOS 用 Library/Caches，Windows 用 LOCALAPPDATA，其它用 XDG_CACHE_HOME）。
// 降级：HOME/LOCALAPPDATA/XDG 均可能缺失，逐个回落到 tmpdir，保证返回可用路径。
const cacheBaseDirectory = (): string => {
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
};

// 缓存目录内 marker 的固定位置；集中成一个函数，避免写与读的口径分叉。
const markerPathForDirectory = (directory: string): string => join(directory, manifestFileName);

// 按扩展名推断权限位：原生库需要可执行位，其余按普通文件处理。
const modeForPath = (filePath: string): number =>
  /\.(?:dll|dylib|node|so)$/i.test(filePath) ? 0o755 : 0o644;
