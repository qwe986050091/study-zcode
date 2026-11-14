/**
 * bundled-plugins：把随包内置的官方插件 seed 到用户 storage 缓存，并给出 discovery 用的根目录。
 * 定位：seed 源二选一（SEA 内嵌资产 / 文件系统插件包）→ 逐插件校验必需资产与哈希 → 加锁后
 *   原子替换 <storage>/cache/<marketplace>/<plugin>/<version> → 写 runtime manifest；
 *   随后把可用 fallback 根目录与调用方 extraRoots 合并返回。
 * 所有权：只写 storage 下的 cache，不加载插件、不删"已抑制"的内置插件——运行时是否加载由
 *   discovery 依据 suppressedBuiltins 决定，seed 阶段删缓存会让卸载后详情页无法读取。
 * 失败语义：单插件失败（缺资产 / 哈希不符 / 等锁超时 / 并发替换竞争）只 warn 并回退可用旧缓存，
 *   绝不把会话恢复炸成 resumeFailed；只有非预期错误（真实缓存损坏 / IO）才上抛。
 * 并发语义：多进程（桌面多窗口/协议/CLI）会并发 seed 同一缓存，靠 seed lock + 唯一临时目录 +
 *   marker 二次检查收敛；同一进程内所有插件共享 15s 等锁总预算，避免 N×15s 的启动冻结。
 * 不变量：缓存目录一旦可见必须完整（temp 写完才 rename）；marker 指纹包含 path + sha256 + mode。
 */
// bundled-plugins.ts：把内置官方插件 seed 进 storage cache，并为 discovery 计算可用根目录。
// INV-01 缓存目录一旦可见必须完整，临时目录写完并逐文件校验哈希后才 rename；守住位置：seedBundledOfficialPlugins 的临时目录分支；改错故障：discovery 读到半成品文件，插件加载即崩。
// INV-02 拿到 seed lock 后必须二次检查 marker，等锁者应直接复用已提交缓存；守住位置：withOfficialPluginSeedLock 回调开头；改错故障：多窗口并发预热白耗 IO，并在 Windows 上触发 EPERM。
// INV-03 marker 指纹包含每个文件的 path、sha256 与最终 mode；守住位置：hashSeedFiles；改错故障：只改权限的升级无法被识别，旧缓存被长期复用。
// INV-04 单插件失败只 warn 并回退旧缓存，绝不升级为 resumeFailed；守住位置：seedBundledOfficialPlugins 的每插件 catch；改错故障：一个残缺插件让整个会话恢复失败。
// INV-05 缺 requiredSeedPaths 时拒绝写缓存；守住位置：missingSeedPaths 长度判断；改错故障：残缺插件进缓存后详情页组件缺失且无法自愈。
// INV-06 15s 等锁预算由整批插件共享，不是每插件一份；守住位置：seedLockDeadlineAt；改错故障：N 个遗留锁让启动同步冻结 N×15s。
// INV-07 每次替换使用唯一 backup 名，catch 只回滚自己移出的那份；守住位置：createSeedBackupRoot 与 replaceSeedRoot；改错故障：并发进程互窃事务状态，target 与 backup 双双丢失。
// INV-08 只有 marker 证明新 target 完整时，才把 rename 竞争错误降级；守住位置：seedBundledOfficialPlugins 的 ENOENT 判断；改错故障：真实缓存损坏被当成并发竞争静默吞掉。
// INV-09 CUA 插件不给 fallback，feature flag 关闭时加入抑制集合；守住位置：resolveOfficialPluginRoots；改错故障：旧 frame contract 接新 consumer，CUA 布局错配。
// INV-10 被抑制的内置插件不删除 cache；守住位置：resolveOfficialPluginRoots 与 seed 阶段；改错故障：卸载后商店详情页读不到组件，重装也无法恢复。
// INV-11 seed 源按 SEA 优先、filesystem 兜底，两者都不可用视为无源；守住位置：resolveSeedSource；改错故障：打包态读到磁盘残留旧插件包，版本与二进制不一致。
// INV-12 SEA 插件按 marketplace、name、version 三元匹配定义；守住位置：resolveSeaSeedSource；改错故障：旧 manifest 配新定义，资产哈希与必需路径全部错位。
// INV-13 顶层白名单决定 filesystem seed 的裁剪边界；守住位置：includedTopLevelPaths 与 collectFilesystemPluginFiles；改错故障：新增顶层目录被静默裁掉，运行期才报模块缺失。
// INV-14 可执行位必须显式落盘，hook 与 dist/mcp/server.js 兜底 0755；守住位置：modeForSeedFile；改错故障：polyglot wrapper 直接执行时 permission denied。
// INV-15 非 ENOENT 的文件系统错误保持 fatal；守住位置：isNotFoundFsError 与各处 catch；改错故障：ENOTEMPTY 或 EPERM 被当作竞争掩盖，缓存持续损坏。
// INV-16 临时目录名唯一，清理失败不得覆盖原始 seed 错误；守住位置：temporaryRoot 生成与内层 catch；改错故障：原始错误被吞，排障只剩一条无关的清理失败。
// INV-17 回退只认 manifest.name 与 requiredSeedPaths，不看 hash；守住位置：isSeedUsable；改错故障：可用的旧缓存被判损坏，插件直接消失。
// INV-18 锁目录、backup、tmp 目录不参与 fallback 排序；守住位置：findUsableOfficialPluginFallback 的过滤链；改错故障：把锁目录当版本根注册，加载到空目录。
//
// 阅读顺序：源解析 → 资产校验 → 加锁 → 临时目录 → 原子替换，之后才是根目录合并与 fallback。
// 边界：本文件只写 storage 下的 cache，不加载插件、不删除被抑制的内置插件；所有降级都必须保留旧缓存可读。
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { writeBundledOfficialMarketplacePartitionSync } from "@zcode/adapters";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, type Logger } from "@zcode/contracts";
import { isZCodeCuaInternalFeatureEnabled, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  getOfficialPluginCacheRetryAttempts,
  isTransientOfficialPluginCacheFsError,
  type OfficialPluginCacheRetryBudget,
  removeOfficialPluginCacheDirectory,
  renameOfficialPluginCachePath,
} from "./official-plugin-cache-fs.js";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  type OfficialPluginDefinition,
} from "./official-plugin-definitions.js";
import { writeOfficialPluginRuntimeManifest } from "./official-plugin-runtime.js";
import {
  isOfficialPluginSeedLockTimeoutError,
  withOfficialPluginSeedLock,
} from "./official-plugin-seed-lock.js";

const OFFICIAL_PLUGIN_MARKETPLACE = ZCODE_OFFICIAL_PLUGIN_MARKETPLACE;
const SEA_PLUGIN_ASSET_PREFIX = "zcode-official-plugins/";
const SEA_PLUGIN_MANIFEST_ASSET_KEY = `${SEA_PLUGIN_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".zcode-plugin-seed.json";
// 15s 是整批插件共享的等锁总预算，不是每插件预算；耗尽后后续插件只能立即降级。
// [权衡] 调大能减少并发热 seed 的告警，但会直接拉长最坏启动耗时。
// [并发] 无争用时首次 mkdir 即成功、不读预算，所以正常路径不受该值影响。
const SEED_LOCK_TOTAL_BUDGET_MS = 15_000;

// 顶层白名单是 filesystem seed 的唯一裁剪边界：不在此集合、也未被 runtimeTopLevelPaths 追加的目录不会进缓存。
// [失败路径] 新增官方插件顶层目录却漏登记，seed 阶段不报错，运行期才以模块缺失暴露。
const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // 官方内容插件新增 agents 后，filesystem seed 的顶层白名单未同步，目录被静默裁掉。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser skill 会从官方插件根目录动态导入 scripts/browser-client.mjs。
  // filesystem seed 若漏掉 scripts，Dev 会连接 node_repl 成功却在首次 Browser Use 时导入失败。
  "scripts",
  "skills",
  "templates",
]);

// mode 可缺省：SEA manifest 与旧版清单不带权限信息，落盘时由 modeForSeedFile 兜底 0755 或 0644。
// sha256 是逐文件内容指纹，seed 时逐字节复核，任一不符即整插件拒绝写入。
interface OfficialPluginSeedFile {
  mode?: number;
  path: string;
  sha256: string;
  sourcePath?: string;
}

interface OfficialPluginSeedPluginSource {
  definition: OfficialPluginDefinition;
  files: OfficialPluginSeedFile[];
  hash: string;
  missingSeedPaths: string[];
  rootPath?: string;
}

interface OfficialPluginSeedSource {
  kind: "filesystem" | "sea";
  plugins: OfficialPluginSeedPluginSource[];
}

interface SeaOfficialPluginManifest {
  hash: string;
  plugins: Array<{
    files: OfficialPluginSeedFile[];
    marketplace: string;
    name: string;
    version: string;
  }>;
  version: 1;
}

type SeaModule = typeof import("node:sea");

/**
 * 逐个 seed 内置插件，返回 seed 失败的定义列表（供调用方回退旧缓存）。
 * 输入：storageRoot 决定 cache 落点；logger 只用于降级告警，无 logger 时静默降级。
 * 输出：失败的 OfficialPluginDefinition[]（全部成功时为空数组）。
 * 副作用：先写 marketplace 分区（即使后续 seed 失败，商店目录仍可读），再写版本目录与 runtime
 *   manifest，并清理临时/备份目录。
 * 失败语义：见文件头——单插件失败只 warn+continue；非预期异常向上抛。
 * 顺序敏感：先写 marketplace 再 seed：catalog/cache 是不可变产品资产，与运行期加载解耦。
 */
function seedBundledOfficialPlugins(input: {
  logger?: Logger;
  storageRoot: string;
}): OfficialPluginDefinition[] {
  const source = resolveSeedSource();
  if (!source) return [];

  // Catalog/cache 是内置插件的不可变产品资产；Runtime 是否加载由 discovery 的抑制态决定，
  // 不能在 seed 阶段删除或过滤，否则卸载后详情页无法读取组件，也无法恢复。
  writeOfficialMarketplace(input.storageRoot, source);
  const retryBudget = createOfficialPluginCacheRetryBudget();
  // 等锁超时降级后循环会继续；若每个插件独立重置 15s 等待预算，成组遗留的
  // 锁会让启动同步冻结 N×15s。全部插件共享同一截止时间：无争用的锁仍瞬时获取（mkdir
  // 一次成功不查预算），预算耗尽后有争用的锁立即降级，seeding 总等待封顶 15s。
  // [并发] 截止时间在循环外计算一次，后续每个插件传入的是剩余预算，可能已经是 0。
  // [失败路径] 预算耗尽的插件走 seed lock 超时降级，而不是无限等待或直接抛错。
  const seedLockDeadlineAt = Date.now() + SEED_LOCK_TOTAL_BUDGET_MS;
  const failedSeeds: OfficialPluginDefinition[] = [];
  for (const plugin of source.plugins) {
    const pluginId = `${plugin.definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}`;
    const targetRoot = officialPluginCacheRoot(input.storageRoot, plugin.definition);
    // 入口旁的插件拷贝可能与新定义错配（升级中的桌面包、旧 checkout 未构建 dist）。
    // 缺 requiredSeedPaths 时 seed 源解析曾直接抛错，一个残缺插件把全部插件连同会话恢复
    // 一起炸成 resumeFailed。残缺只作用于单插件：拒绝写缓存，按既有降级协议告警并回退到可用旧缓存。
    // [失败路径] 缺必需资产只判该插件失败：写缓存会让 discovery 加载残缺插件，抛错会连带拖垮会话恢复。
    // 错误码 ZCODE_PLUGIN_SEED_INCOMPLETE 是降级判据；宁可不 seed 也不写半成品，避免可用旧缓存被残缺新缓存覆盖。
    if (plugin.missingSeedPaths.length > 0) {
      warnCacheDegraded(input.logger, {
        error: Object.assign(
          new Error(
            `Bundled official plugin ${plugin.definition.name} is missing required seed assets: ${plugin.missingSeedPaths.join(", ")}`,
          ),
          { code: "ZCODE_PLUGIN_SEED_INCOMPLETE" },
        ),
        missingSeedPaths: plugin.missingSeedPaths,
        operation: "seed_plugin",
        pluginId,
        targetRoot,
      });
      failedSeeds.push(plugin.definition);
      continue;
    }
    try {
      withOfficialPluginSeedLock(
        targetRoot,
        () => {
          const manifestFile = plugin.files.find(
            (file) => file.path === ".zcode-plugin/plugin.json",
          );
          if (!manifestFile)
            throw new Error(`Bundled plugin manifest is missing: ${plugin.definition.name}`);
          const sourceManifestContents = readSeedFileBytes(source, plugin, manifestFile).toString(
            "utf8",
          );
          // 桌面会并发预热多个 workspace Agent；复制插件资源时，
          // 多进程会互删 target 并在 Windows rename 时触发 EPERM。拿锁后必须二次检查，
          // 让等待者直接复用首个进程已经提交的完整缓存。
          // [并发] 持锁后必须二次检查：等锁期间首个进程可能已提交完整缓存，直接复用可省一次全量复制。
          // marker 不匹配才继续重建；hash 与插件版本任一不同都算需要刷新。
          if (isSeedCurrent(targetRoot, plugin)) {
            cleanupLegacySeedBackup(targetRoot, retryBudget);
            const manifestWritten = tryWriteOfficialPluginRuntimeManifest({
              sourceManifestContents,
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
            if (manifestWritten) return;
          }

          // [并发] 临时目录名带 pid 与时间戳，进程之间不会复用或互删半成品。
          // [资源] 创建前先清同名残留，避免上次异常退出留下的目录混入本次文件集合。
          const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
          removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
          mkdirSync(temporaryRoot, { recursive: true });

          try {
            for (const file of plugin.files) {
              const bytes = readSeedFileBytes(source, plugin, file);
              // [失败路径] 逐文件复核哈希把源被改动或传输截断挡在 rename 之前，可见缓存始终对应已验证内容。
              // 两种 seed 源共用同一校验路径，避免行为漂移。
              if (hashBytes(bytes) !== file.sha256) {
                throw new Error(
                  `Bundled plugin asset hash mismatch: ${plugin.definition.name}/${file.path}`,
                );
              }
              const outputPath = join(temporaryRoot, ...file.path.split("/"));
              mkdirSync(dirname(outputPath), { recursive: true });
              writeFileSync(outputPath, bytes);
              // [失败路径] 权限必须显式设置：writeFileSync 会继承 umask，可执行 hook 落成 0644 会在运行时 permission denied。
              // mode 参与 seed 指纹，改权限等同发布新版本，会触发下次 seed 重建。
              chmodSync(outputPath, modeForSeedFile(file.path, file.mode));
            }

            writeFileSync(
              join(temporaryRoot, SEED_MARKER_FILE),
              JSON.stringify(seedMarker(source, plugin), null, 2),
            );
            // [事务] 只有 marker 已写入才进入替换：可见的 target 要么是旧完整缓存，要么是新完整缓存。
            // [失败路径] 替换失败原样抛回外层统一降级，由调用方决定是否回退旧缓存。
            replaceSeedRoot(temporaryRoot, targetRoot, plugin, retryBudget);
            writeOfficialPluginRuntimeManifest({
              sourceManifestContents,
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
          } catch (error) {
            try {
              // [资源] 失败清理只做 best effort，且绝不覆盖原始 seed 错误。
              // [并发] 目录名唯一，清理失败不会污染后续进程的临时目录。
              removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
            } catch {
              // 临时目录清理失败不能覆盖真正的 seed 错误；目录名唯一，不会污染后续加载。
            }
            throw error;
          }
        },
        { timeoutMs: Math.max(0, seedLockDeadlineAt - Date.now()) },
      );
    } catch (error) {
      if (
        isTransientOfficialPluginCacheFsError(error) ||
        // seed lock 等待超时只说明同版本缓存锁被别的进程持有或遗留（Windows 上
        // 删不掉的遗留锁 + PID 复用会让接管长期不触发）。seeding 只是刷新缓存，超时必须
        // 走既有降级协议回退到可用缓存并告警，不能把会话恢复整体炸成 resumeFailed。
        isOfficialPluginSeedLockTimeoutError(error) ||
        // 多个 workspace app 会并发 seed 同一份官方插件缓存。当前进程
        // 写 runtime manifest 时，并发赢家可能已经原子替换整个 targetRoot，连同本进程
        // 的临时文件一起移走，rename 因此返回 ENOENT。只在新 target 已由 marker 证明
        // 完整时降级；目标缺失或仍旧时继续抛错，不能掩盖真实缓存损坏。
        (isNotFoundFsError(error) && isSeedCurrent(targetRoot, plugin))
      ) {
        warnCacheDegraded(input.logger, {
          error,
          operation: "seed_plugin",
          pluginId,
          targetRoot,
        });
        failedSeeds.push(plugin.definition);
        continue;
      }
      throw error;
    }
  }
  return failedSeeds;
}

function tryWriteOfficialPluginRuntimeManifest(input: {
  sourceManifestContents: string;
  pluginName: string;
  retryBudget: OfficialPluginCacheRetryBudget;
  rootPath: string;
}): boolean {
  try {
    writeOfficialPluginRuntimeManifest(input);
    return true;
  } catch (error) {
    // [失败路径] 瞬时文件系统错误（如 Windows EPERM）必须上抛降级，这里吞掉会让调用方误以为 manifest 已写。
    // 非瞬时错误按未写返回，交给后续流程继续完成 seed。
    if (isTransientOfficialPluginCacheFsError(error)) throw error;
    return false;
  }
}

/**
 * discovery 前的最后一站：seed 内置插件并计算可用的插件根目录。
 * 输入：extraRoots 优先（调用方显式指定）；suppressedBuiltins 是已抑制的内置插件 id 集合，
 *   CUA 的 feature flag 关闭时也在此加入抑制（在 seed/discovery 层门控，而非只隐藏 UI）。
 * 输出：去重后的根目录数组 = extraRoots + 每个失败插件的可用 fallback（CUA 例外，不给 fallback）。
 * 失败语义：seed 的不可恢复错误向上抛；缺 logger 时不写告警。
 * 口径：CUA 不给 fallback，因为其 frame contract 随 wrapper/producer 原子升级，旧 cache 会错配布局。
 */
export function resolveOfficialPluginRoots(input: {
  env?: NodeJS.ProcessEnv;
  extraRoots?: string[];
  logger?: Logger;
  storageRoot: string;
  suppressedBuiltins?: ReadonlySet<string>;
}): string[] {
  const suppressedBuiltins = new Set(input.suppressedBuiltins ?? []);
  // zcode-cua 内置 plugin 默认不启用，由 feature flag 控制加载。在 seed/discovery 层门控
  // （而非只隐藏某个 UI 面），这样开关关闭时用户无法经 plugin 列表/marketplace/MCP 设置/CLI 命令看到它。
  if (!isZCodeCuaInternalFeatureEnabled(input.env ?? process.env)) {
    // [权衡] flag 关闭时在 seed/discovery 层禁用，而不只是隐藏 UI，避免 CLI 与 MCP 入口绕过。
    // 抑制集合只影响加载可见性，不删除 cache，重新开启 flag 后可立即恢复。
    suppressedBuiltins.add(ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  }
  const failedSeeds = seedBundledOfficialPlugins({
    logger: input.logger,
    storageRoot: input.storageRoot,
  });

  // [失败路径] 只有 seed 失败的插件才需要 fallback：成功插件的新缓存已是唯一可注册根。
  // CUA 显式返回空数组：其 frame contract 随 wrapper 与 producer 原子升级，旧缓存接新 consumer 会布局错配，宁可少注册一个插件。
  const fallbackRoots = failedSeeds.flatMap((definition) => {
    // CUA 的 frame contract 随 wrapper 与 producer 原子升级。加载旧版本
    // cache 会把旧 block 布局接到新 consumer 上；当前 cache 不可用时宁可不注册 CUA。
    if (`${definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}` === ZCODE_CUA_OFFICIAL_PLUGIN_ID) {
      return [];
    }
    const fallbackRoot = findUsableOfficialPluginFallback(input.storageRoot, definition);
    return fallbackRoot ? [fallbackRoot] : [];
  });
  return uniquePaths([...(input.extraRoots ?? []), ...fallbackRoots]);
}

/** 选 seed 源：SEA 内嵌资产优先，其次文件系统插件包；两者都不可用返回 undefined（不 seed 也不算失败）。 */
function resolveSeedSource(): OfficialPluginSeedSource | undefined {
  // SEA 源优先：内嵌资产与二进制同版本，可避开磁盘上残留的旧插件包。
  // 两者都不可用时返回 undefined，调用方按无需 seed 处理，不算失败也不告警。
  const seaSource = resolveSeaSeedSource();
  if (seaSource) return seaSource;
  return resolveFilesystemSeedSource();
}

/** 从 SEA manifest 按 marketplace+name+version 精确匹配定义，缺一个就跳过该插件；零匹配视为无源。 */
function resolveSeaSeedSource(): OfficialPluginSeedSource | undefined {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;

  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const plugin = manifest.plugins.find(
      (item) =>
        item.marketplace === OFFICIAL_PLUGIN_MARKETPLACE &&
        item.name === definition.name &&
        // 三元精确匹配：版本不同即视为无源，防止旧 manifest 配新定义。
        // [失败路径] 缺任一插件只跳过该插件，不整批放弃。
        item.version === definition.version,
    );
    if (!plugin) return [];
    return [
      {
        definition,
        files: plugin.files,
        hash: hashSeedFiles(plugin.files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, plugin.files),
      },
    ];
  });
  if (plugins.length === 0) return undefined;

  return {
    kind: "sea",
    plugins,
  };
}

/** 逐个定义在候选目录里找插件根（必须含 .zcode-plugin/plugin.json），找到即收集文件；零匹配视为无源。 */
function resolveFilesystemSeedSource(): OfficialPluginSeedSource | undefined {
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const rootPath = resolveFilesystemPluginRoot(definition);
    if (!rootPath) return [];
    const files = collectFilesystemPluginFiles(rootPath, definition);
    return [
      {
        definition,
        files,
        hash: hashSeedFiles(files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, files),
        rootPath,
      },
    ];
  });
  if (plugins.length === 0) return undefined;
  return {
    kind: "filesystem",
    plugins,
  };
}

/** 返回定义要求、但 seed 文件集中缺席的路径（空数组 = 完整）。纯函数，不读盘。 */
export function findMissingOfficialPluginSeedPaths(
  definition: Pick<OfficialPluginDefinition, "requiredSeedPaths">,
  files: ReadonlyArray<{ path: string }>,
): string[] {
  // 纯函数只比较路径集合、不读盘；调用方给什么文件集就得到什么结论。
  // [失败路径] requiredSeedPaths 为空数组时永远返回空，代表该插件没有硬性资产要求。
  const availablePaths = new Set(files.map((file) => file.path));
  return (definition.requiredSeedPaths ?? []).filter(
    (requiredPath) => !availablePaths.has(requiredPath),
  );
}

function getSeaModule(): SeaModule | undefined {
  // [权衡] node:sea 在旧 Node 或非 SEA 运行时不可用，取模块失败按无 SEA 源降级而非报错。
  // [权衡] 断言把 getBuiltinModule 收窄成 node:sea 专用签名；仅为省去调用点断言，运行时仍是同一个函数。
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function readSeaManifest(sea: SeaModule): SeaOfficialPluginManifest | undefined {
  try {
    const raw = sea.getAsset(SEA_PLUGIN_MANIFEST_ASSET_KEY, "utf8");
    const manifest = JSON.parse(raw) as SeaOfficialPluginManifest;
    return manifest.version === 1 && Array.isArray(manifest.plugins) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/** 候选目录 × rootCandidates 的笛卡尔查找，首个含 manifest 的目录胜出；此处不解析 manifest 内容。 */
function resolveFilesystemPluginRoot(definition: OfficialPluginDefinition): string | undefined {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of definition.rootCandidates) {
      const rootPath = resolve(baseDir, relativePath);
      if (existsSync(join(rootPath, ".zcode-plugin", "plugin.json"))) return rootPath;
    }
  }
  return undefined;
}

/** 收集 seed 文件：顶层白名单 + 定义追加的 runtimeTopLevelPaths；记录 mode 与 sha256，按路径排序。 */
function collectFilesystemPluginFiles(
  rootPath: string,
  definition: OfficialPluginDefinition,
): OfficialPluginSeedFile[] {
  const files: OfficialPluginSeedFile[] = [];
  const allowedTopLevelPaths = new Set([
    ...includedTopLevelPaths,
    ...(definition.runtimeTopLevelPaths ?? []),
  ]);
  for (const sourcePath of walkFiles(rootPath, allowedTopLevelPaths)) {
    const relativePath = toPosixPath(sourcePath.slice(rootPath.length + 1));
    if (!shouldIncludePluginFile(relativePath, allowedTopLevelPaths)) continue;
    const bytes = readFileSync(sourcePath);
    files.push({
      mode: modeForSeedFile(relativePath, statSync(sourcePath).mode),
      path: relativePath,
      sha256: hashBytes(bytes),
      sourcePath,
    });
  }
  // 排序让 hashSeedFiles 的指纹与目录枚举顺序无关，跨平台、跨文件系统稳定。
  // [失败路径] 排序发生在收集之后，不依赖 readdir 的返回顺序。
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** 深度优先遍历；跳 .turbo / coverage / .venv / __pycache__，node_modules 仅当本身是允许顶层时才保留。 */
function* walkFiles(
  directory: string,
  allowedTopLevelPaths: ReadonlySet<string>,
  depth = 0,
): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // [资源] 跳过 .turbo、coverage、.venv、__pycache__，避免把构建产物与虚拟环境复制进缓存。
    // node_modules 仅当本身是允许的顶层目录时保留，防止递归体积失控。
    if (shouldSkipDirectory(entry.name, depth, allowedTopLevelPaths)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, allowedTopLevelPaths, depth + 1);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

/** 按源类型读字节：filesystem 直接读 sourcePath，SEA 用 getRawAsset；非 SEA 运行时读 SEA 资产是编程错误。 */
function readSeedFileBytes(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
  file: OfficialPluginSeedFile,
): Buffer {
  if (source.kind === "filesystem" && file.sourcePath) return readFileSync(file.sourcePath);
  const sea = getSeaModule();
  // [失败路径] 非 SEA 运行时读取 SEA 资产属于编程错误，必须显式抛出而不是返回空字节。
  // 带 sourcePath 的 filesystem 文件已在上一分支返回，不会走到这里。
  if (!sea?.isSea()) throw new Error("SEA plugin asset is unavailable outside SEA runtime.");
  return Buffer.from(
    sea.getRawAsset(
      `${SEA_PLUGIN_ASSET_PREFIX}${OFFICIAL_PLUGIN_MARKETPLACE}/${plugin.definition.name}/${plugin.definition.version}/${file.path}`,
    ),
  );
}

/**
 * 写 marketplace 目录分区：条目字段对齐 CDN 目录 schema（cachePath / listing / description /
 *   componentTypes），让 UI 在插件未安装或已卸载时仍能渲染商店详情；description 取自 plugin.json
 *   这个单一事实源，读取失败只降级为缺字段。
 */
function writeOfficialMarketplace(storageRoot: string, source: OfficialPluginSeedSource): void {
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      name: OFFICIAL_PLUGIN_MARKETPLACE,
      plugins: source.plugins.map((plugin) => {
        // 商店信息（listing）与描述随目录条目下发：键名与 CDN 目录 schema 一致，
        // 由 adapter 的同一套 parseEntryStoreListing 解析，UI 才能给内置插件渲染
        // 显示名/分类/作者/示例提示词。描述取自插件包内 plugin.json（单一事实源）。
        const description = readSeedPluginDescription(source, plugin);
        return {
          // 目录条目必须带 cachePath，UI 才能在插件未安装或已卸载时定位商店资源。
          // [权衡] 描述与 listing 缺字段只降级渲染，不阻断整份市场的写入。
          cachePath: officialPluginCacheRoot(storageRoot, plugin.definition),
          // 未安装/已卸载时商店读目录条目的 componentTypes 判断「UI 插件」；缺失会掉进分类分组。
          ...(plugin.definition.componentTypes
            ? { componentTypes: [...plugin.definition.componentTypes] }
            : {}),
          ...(description ? { description } : {}),
          name: plugin.definition.name,
          source: source.kind,
          version: plugin.definition.version,
          ...(plugin.definition.listing ?? {}),
        };
      }),
      version: 1,
    },
    storageRoot,
  });
}

/** 从 seed 文件集中读插件 plugin.json 的 description；读取/解析失败按 undefined 降级。 */
function readSeedPluginDescription(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): string | undefined {
  const manifestFile = plugin.files.find((file) => file.path === ".zcode-plugin/plugin.json");
  if (!manifestFile) return undefined;
  try {
    const parsed = JSON.parse(readSeedFileBytes(source, plugin, manifestFile).toString("utf8")) as {
      description?: unknown;
    };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description
      : undefined;
  } catch {
    return undefined;
  }
}

// marker 指纹与版本都匹配才算"当前"；marker 解析失败一律按"不是"处理（宁可重 seed 不读坏缓存）。
function isSeedCurrent(targetRoot: string, plugin: OfficialPluginSeedPluginSource): boolean {
  const markerPath = join(targetRoot, SEED_MARKER_FILE);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as ReturnType<typeof seedMarker>;
    // 双重比对：hash 覆盖文件集合与权限，版本则兜住内容撞哈希的极端情况。
    // marker 解析失败在 catch 中按不是当前处理，宁可重 seed 也不读坏缓存。
    return marker.hash === plugin.hash && marker.pluginVersion === plugin.definition.version;
  } catch {
    return false;
  }
}

/**
 * 旧版本缓存只要插件清单和运行所需文件完整，就可以继续服务当前会话。
 * marker hash 不匹配只表示需要升级，不能把一个可用的旧缓存当成启动失败。
 */
// 旧缓存可用性只看 manifest.name 与 requiredSeedPaths 是否齐全；hash 不匹配只代表"该升级"，不是损坏。
function isSeedUsable(targetRoot: string, definition: OfficialPluginDefinition): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(targetRoot, ".zcode-plugin", "plugin.json"), "utf8"),
    ) as { name?: unknown };
    // [失败路径] 目录名与插件名不符即判不可用，防止 fallback 把别的插件塞给当前定义。
    // 此处不校验 hash：旧缓存只代表该升级，不等于损坏。
    if (manifest.name !== definition.name) return false;
  } catch {
    return false;
  }

  return (definition.requiredSeedPaths ?? []).every((requiredPath) =>
    existsSync(join(targetRoot, ...requiredPath.split("/"))),
  );
}

/**
 * 找可回退的旧版本目录：排除当前版本、*.backup*、*.seed-lock*、*.tmp-*，按版本号降序取首个可用者。
 * undefined 有两种含义，调用方无需区分：当前版本本身可用（不回退），或根本没有可用旧版（不注册）。
 */
function findUsableOfficialPluginFallback(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): string | undefined {
  const targetRoot = officialPluginCacheRoot(storageRoot, definition);
  if (isSeedUsable(targetRoot, definition)) return undefined;

  let entries;
  try {
    entries = readdirSync(dirname(targetRoot), { withFileTypes: true });
  } catch (error) {
    if (isNotFoundFsError(error)) return undefined;
    throw error;
  }

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== definition.version &&
        !entry.name.includes(".backup") &&
        // 锁目录（含 .seed-lock.stale-*）与版本目录同级；超时降级后锁必然在场，
        // 不能依赖 isSeedUsable 的内容检查兜底，按名字直接排除。
        // [并发] 锁目录与版本目录同级，超时降级后锁必然在场，必须按名字排除而不是靠内容检查。
        // 同时排除 .backup 与 .tmp-，只让真正的版本目录参与回退排序。
        !entry.name.includes(".seed-lock") &&
        !entry.name.includes(".tmp-"),
    )
    .sort((left, right) =>
      right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map((entry) => join(dirname(targetRoot), entry.name))
    .find((rootPath) => isSeedUsable(rootPath, definition));
}

/**
 * 原子替换缓存根：target → 唯一 backup → temp → target，成功后删 backup 与遗留的固定 backup。
 * 竞争语义：rename 后若 marker 证明新 target 已完整，视为并发赢家已提交——删自己的 temp 即成功返回；
 *   否则（backup 还在且 target 缺失）把 backup 恢复回去再抛原错，绝不留下"既无 target 也无 backup"。
 * 不变量：每个替换用唯一 backup 名，catch 只恢复自己移出的那份，不能窃取别的进程的事务状态。
 */
function replaceSeedRoot(
  temporaryRoot: string,
  targetRoot: string,
  plugin: OfficialPluginSeedPluginSource,
  retryBudget: OfficialPluginCacheRetryBudget,
): void {
  const backupRoot = createSeedBackupRoot(targetRoot);
  let movedTargetToBackup = false;
  mkdirSync(dirname(targetRoot), { recursive: true });
  if (existsSync(targetRoot)) {
    try {
      renameOfficialPluginCachePath(targetRoot, backupRoot, retryBudget);
      movedTargetToBackup = true;
    } catch (error) {
      // 官方插件缓存由桌面窗口、协议与 CLI 入口共享。existsSync 之后，
      // 另一个进程可能先移走 target；此处只收敛这个 TOCTOU 的 ENOENT，随后继续
      // promote 或由 isSeedCurrent 识别并发赢家，其他缺失错误仍保持原有 fatal 语义。
      if (!isNotFoundFsError(error)) throw error;
    }
  }

  try {
    renameOfficialPluginCachePath(temporaryRoot, targetRoot, retryBudget);
  } catch (error) {
    if (isSeedCurrent(targetRoot, plugin)) {
      removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
      if (movedTargetToBackup) {
        removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
      }
      cleanupLegacySeedBackup(targetRoot, retryBudget);
      return;
    }
    // [事务] 只有自己移出 backup 且 target 仍缺失时才回滚，不窃取其他进程的事务状态。
    // [失败路径] 回滚本身失败会覆盖原始错误，但不会留下既无 target 又无 backup 的空洞。
    if (movedTargetToBackup && !existsSync(targetRoot) && existsSync(backupRoot)) {
      renameOfficialPluginCachePath(backupRoot, targetRoot, retryBudget);
    }
    throw error;
  }

  if (movedTargetToBackup) {
    removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
  }
  cleanupLegacySeedBackup(targetRoot, retryBudget);
}

function cleanupLegacySeedBackup(
  targetRoot: string,
  retryBudget: OfficialPluginCacheRetryBudget,
): void {
  // 固定 backup 没有事务归属，可能在另一个进程 promote 中被误当回滚点。
  // 因此仅在本进程 seed 已确认可用后才清理该遗留目录。
  const backupRoot = `${targetRoot}.backup`;
  if (!existsSync(backupRoot)) return;

  // 旧版固定 backup 没有事务归属，target 暂时缺失时可能属于另一个仍在
  // promote 的进程，不能把它恢复回去。仅在当前 seed 已确认可用后清理这个遗留目录。
  removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
}

function createSeedBackupRoot(targetRoot: string): string {
  // 固定 backup 会被并发启动进程共同当作 rollback 点；每次替换使用唯一目录，
  // catch 分支只恢复自己移动出的 target，避免一个进程窃取另一个进程的事务状态。
  return `${targetRoot}.backup-${process.pid}-${Date.now()}`;
}

function isNotFoundFsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    // [失败路径] 只认 ENOENT：ENOTEMPTY、EPERM 等仍按 fatal 上抛，避免把真实缓存损坏伪装成并发竞争。
    // 基于 code 而非 message 判断，跨平台与本地化下都稳定。
    String((error as NodeJS.ErrnoException).code) === "ENOENT"
  );
}

function warnCacheDegraded(
  logger: Logger | undefined,
  input: {
    error: NodeJS.ErrnoException;
    missingSeedPaths?: readonly string[];
    operation: "remove_suppressed_plugin" | "seed_plugin";
    pluginId: string;
    targetRoot: string;
  },
): void {
  logger?.warn("Official plugin cache operation degraded", {
    attempts: getOfficialPluginCacheRetryAttempts(input.error),
    degraded: true,
    errorCode: input.error.code,
    ...(input.missingSeedPaths ? { missingSeedPaths: input.missingSeedPaths } : {}),
    module: "bootstrap.official_plugin_cache",
    operation: input.operation,
    pluginId: input.pluginId,
    targetRoot: input.targetRoot,
  });
}

function seedMarker(source: OfficialPluginSeedSource, plugin: OfficialPluginSeedPluginSource) {
  return {
    hash: plugin.hash,
    marketplace: OFFICIAL_PLUGIN_MARKETPLACE,
    plugin: plugin.definition.name,
    pluginVersion: plugin.definition.version,
    source: source.kind,
    version: 1,
  };
}

function officialPluginCacheRoot(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): string {
  return join(
    storageRoot,
    "cache",
    OFFICIAL_PLUGIN_MARKETPLACE,
    definition.name,
    definition.version,
  );
}

/** 内置技能包（bundled-skills.ts）沿同一组候选目录定位，保证两类内置资产在每种运行布局下同进同出。 */
export function candidateBaseDirs(): string[] {
  // 修复原因：Electron app-server 运行在 resources/glm/zcode.cjs，官方插件资源也随桌面包
  // stage 到同级 packages/*-plugin。候选目录必须优先看入口文件目录，避免生产态退回到
  // monorepo-only 的 __dirname 查找假设。
  // 顺序即优先级：入口目录 > 模块目录 > cwd。entrypoint 优先是为了修正 Electron 生产态
  // （resources/glm/zcode.cjs 同级资源），不能假设 monorepo 的 __dirname 布局。
  return [entrypointDir(), runtimeDir(), process.cwd()].filter(
    (dir): dir is string => typeof dir === "string",
  );
}

function runtimeDir(): string | undefined {
  return typeof __dirname === "string" ? __dirname : undefined;
}

function entrypointDir(): string | undefined {
  return process.argv[1] ? dirname(process.argv[1]) : undefined;
}

function shouldSkipDirectory(
  name: string,
  depth: number,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  if (name === ".turbo" || name === "coverage" || name === ".venv" || name === "__pycache__") {
    return true;
  }
  return name === "node_modules" && !(depth === 0 && allowedTopLevelPaths.has(name));
}

function shouldIncludePluginFile(
  relativePath: string,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  const segments = relativePath.split("/");
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split("/");
  return topLevel !== undefined && allowedTopLevelPaths.has(topLevel);
}

/**
 * 权限口径：源文件带执行位 → 0755；dist/mcp/server.js 与 hooks 下的非数据文件兜底 0755
 *   （polyglot shell wrapper 会直接执行，落成 0644 会 permission denied）；其余 0644。
 * 注意 mode 参与 seed 指纹：只改权限也会被识别为新版本。
 */
function modeForSeedFile(filePath: string, sourceMode?: number): number {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  // official plugin seed 会重写缓存文件权限。部分插件通过 polyglot shell wrapper
  // 直接执行 hook 脚本，若落盘成 0644 会 permission denied。这里保留源码执行位，
  // 并对 SEA/旧 manifest 缺少 mode 的 hook 脚本兜底。
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (/^hooks\//u.test(normalizedPath) && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
}

/** 版本指纹 = (path, sha256, 最终 mode) 序列化后的 sha256；文件集合或权限任何变化都算新版本。 */
function hashSeedFiles(files: OfficialPluginSeedFile[]): string {
  return hashText(
    JSON.stringify(
      files.map((file) => [file.path, file.sha256, modeForSeedFile(file.path, file.mode)]),
    ),
  );
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function uniquePaths(paths: string[]): string[] {
  return paths.filter((path, index) => paths.indexOf(path) === index);
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashText(text: string): string {
  return hashBytes(Buffer.from(text));
}
