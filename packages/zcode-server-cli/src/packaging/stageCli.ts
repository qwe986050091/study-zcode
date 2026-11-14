// INV-01 目标平台必须经 supportedServerTargets 白名单校验，未校验的自由字符串会让 staging 目录与 node 二进制架构错配。
// INV-02 运行时 Node 版本只认 SERVER_RUNTIME_NODE_VERSION，另处硬编码会让 server 与 agent 运行时不一致。
// INV-03 node 二进制查找顺序固定为 mock-cdn 缓存、包自有缓存、dist 镜像，换序会复用到非目标平台二进制。
// INV-04 包自有缓存目录键必须同时含版本与目标平台，丢掉 target 会让不同平台互相覆盖。
// INV-05 下载解包用的临时目录必须在 finally 中删除，遗漏会在 CI 上持续堆积大体积归档。
// INV-06 Windows 走 zip 且 strip 层级为 1，unix 走 tar.xz 且层级为 2，写反后目标文件不存在但命令可能仍成功。
// INV-07 解包后必须 chmod 0o755，unix 上缺执行位会让 agent 拉起 node 时直接失败。
// INV-08 仓库根以 pnpm-workspace.yaml 为唯一标记，逐级向上直到文件系统根，找不到必须抛错。
// INV-09 pathExists 把一切异常当作不存在，只能用于可选路径探测，不能承担必需产物校验。
// INV-10 runCommand 继承子进程输出并在非零退出码时 reject，忽略退出码会产出半成品。
// INV-11 ensureAgentBundle 的 skipBuild 仅在本轮第一目标真实构建后有效，否则旧 dist 会被复制进所有平台归档。
// INV-12 agent bundle 路径固定为 apps/zcode-cli/packages/cli/dist/zcode.cjs，构建后仍缺失必须抛错。
// INV-13 原生检索工具必须按目标 release plan 现做，复用 mock-cdn 会让 macOS 的 rg13 顶替发行包的 rg14。
// INV-14 原生工具缓存命中也要通过版本、摘要与架构校验，并刷新同目录许可声明。
// INV-15 workspace 包目录映射覆盖 apps/zcode-cli/packages 与 packages 两个根，漏包会让运行时缺依赖。
// INV-16 第三方与 Node 声明必须在 staging 前读取，读取失败应中止打包而不是产出空许可文件。
// INV-17 dist 目录必须含 server-cli.js 的 tsup 产物，缺失或过期会让发行包入口不可用。
// INV-18 产物统一写入 packageRoot 下的 dist-release，archive 与 componentArchives 开关只改变归档形态。
//
// 模块职责：把 server-cli 的构建产物、agent bundle、目标平台 Node 运行时、原生检索工具与工作区依赖组装成可发行目录与归档。
// 状态所有权：本模块只编排步骤与临时目录，版本与平台清单归 contracts 与 runtime/manifest，产物归 stageRelease。
// 阅读顺序：根目录定位与命令执行 → Node 二进制准备 → agent bundle → 原生工具 → 工作区包 → main 编排。
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERVER_RUNTIME_NODE_VERSION } from "../contracts.js";
import {
  currentServerTarget,
  supportedServerTargets,
  type ServerTarget,
} from "../runtime/manifest.js";
import { stageRelease } from "./stage.js";
import { resolveNodeDistBase } from "./nodeDistMirror.js";

// [契约] 日志前缀固定为 `[stage]`；打包输出与构建日志共用一条流，靠前缀区分来源。
// [权衡] 只写 stdout 不落盘，CI 归档日志依赖外层重定向。
const log = (...args: unknown[]): void => console.log("[stage]", ...args);

// 存在性探测把 access 的异常一律视为不存在，调用方只能拿它判断可选路径。
// [失败路径] 权限错误也被吞成 false，必需产物校验不能只依赖这里。
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// 仓库根以 pnpm-workspace.yaml 为唯一标记，从起始目录逐级向上查找。
// [失败路径] 到达文件系统根仍未命中就抛错，避免拿错误目录继续解析相对路径。
// 返回绝对路径，后续所有 join 都以它为基准，改错会让产物落到仓库外。
async function findRepoRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);
  while (true) {
    if (await pathExists(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current)
      throw new Error("Unable to locate workspace root (pnpm-workspace.yaml)");
    current = parent;
  }
}

// 子进程 stdout 与 stderr 直接继承，构建与解包日志不会丢失。
// [失败路径] exit code 非零立即 reject，错误信息带上命令与参数便于定位。
// [并发] 每次调用独立 spawn，同一缓存目录的并发写入由调用方的编排顺序约束。
async function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

// 下载是唯一的外网边界，HTTP 非 2xx 或空 body 必须中止而不是写入半截文件。
// [资源] 响应流经 pipeline 落到目标文件，管道异常向上抛并留下待清理的临时目录。
// [契约] fetch 使用 `redirect: "follow"` 跟完镜像跳转；`downloadFile` 的调用方拿到的仍是最终文件。
async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  }
  // DOM fetch 的 ReadableStream 与 node:stream/web 的同名类型在 @types/node 下不兼容，
  // 这里做一次显式桥接；运行时对象本身就是 Node 的 web stream。
  const body = response.body as unknown as NodeWebReadableStream<Uint8Array>;
  await pipeline(Readable.fromWeb(body), createWriteStream(destinationPath, { flags: "w" }));
}

/**
 * 准备目标平台的 Node 二进制（固定 v22.16.0）。查找顺序：
 * 1. 现有远端资产链的 mock-cdn 缓存（避免重复下载）；
 * 2. 本包自有缓存；
 * 3. 从 Node dist 镜像（见 resolveNodeDistBase）下载 tar.xz 并解出 bin/node 后写入自有缓存。
 */
// 固定 v22.16.0 与 SERVER_RUNTIME_NODE_VERSION 同源，版本漂移会让 server 与 agent 运行时不一致。
// 查找顺序是 mock-cdn 缓存、包自有缓存、Node dist 镜像，前两级命中即跳过下载。
// [权衡] 优先复用 mock-cdn 换取离线可跑，代价是可能拿到非目标架构的同名二进制。
async function ensureNodeBinary(repoRoot: string, target: ServerTarget): Promise<string> {
  const mockCdnReleasesDir = join(repoRoot, "packages/desktop/mock-cdn/releases");
  if (await pathExists(mockCdnReleasesDir)) {
    for (const entry of (await readdir(mockCdnReleasesDir)).sort().reverse()) {
      for (const binaryName of target.startsWith("win32-") ? ["node.exe", "node"] : ["node"]) {
        const candidate = join(mockCdnReleasesDir, entry, "node", target, binaryName);
        if (await pathExists(candidate)) {
          log(`reuse mock-cdn node runtime: ${candidate}`);
          return candidate;
        }
      }
    }
  }

  const nodeVersion = `v${SERVER_RUNTIME_NODE_VERSION}`;
  const isWindows = target.startsWith("win32-");
  const nodeTarget = isWindows ? target.replace(/^win32-/u, "win-") : target;
  // 缓存目录键包含版本与目标平台，任一缺失都会让不同平台互相覆盖。
  // [资源] 目录在解包前创建，失败时由临时目录清理兜底，不会留下空壳缓存。
  const cacheDir = join(
    repoRoot,
    "node_modules/.cache/zcode-server-cli",
    `node-${nodeVersion}-${target}`,
  );
  const cachedBinaryPath = join(cacheDir, isWindows ? "node.exe" : "node");
  if (await pathExists(cachedBinaryPath)) {
    log(`reuse cached node runtime: ${cachedBinaryPath}`);
    return cachedBinaryPath;
  }

  const archiveName = `node-${nodeVersion}-${nodeTarget}.${isWindows ? "zip" : "tar.xz"}`;
  const url = `${resolveNodeDistBase()}/${nodeVersion}/${archiveName}`;
  log(`download node runtime: ${url}`);
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-server-node-"));
  try {
    const archivePath = join(tempDir, archiveName);
    await downloadFile(url, archivePath);
    await mkdir(cacheDir, { recursive: true });
    // Windows 分支走 zip 且只抽取 node.exe，strip 层级为 1，与 unix 的层级不同。
    // [失败路径] 层级写错时 tar 可能不报错但目标文件不存在，后续 chmod 会直接失败。
    if (isWindows) {
      await runCommand(
        "tar",
        [
          "-xf",
          archivePath,
          "--strip-components=1",
          "-C",
          cacheDir,
          `node-${nodeVersion}-${nodeTarget}/node.exe`,
        ],
        repoRoot,
      );
    } else {
      await runCommand(
        "tar",
        [
          "-xJf",
          archivePath,
          "--strip-components=2",
          "-C",
          cacheDir,
          `node-${nodeVersion}-${nodeTarget}/bin/node`,
        ],
        repoRoot,
      );
    }
    await chmod(cachedBinaryPath, 0o755);
    return cachedBinaryPath;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

// agent bundle 是目标产物之一，路径固定在 apps/zcode-cli/packages/cli/dist/zcode.cjs。
// [失败路径] skipBuild 且文件缺失立即抛错，提示去掉 --skip-agent-build。
// [权衡] 只有本轮第一目标真实构建，后续目标复用同一 bundle，避免把上一代 dist 复制进所有平台。
async function ensureAgentBundle(repoRoot: string, skipBuild: boolean): Promise<string> {
  const bundlePath = join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (skipBuild) {
    if (await pathExists(bundlePath)) return bundlePath;
    throw new Error(`Agent bundle missing: ${bundlePath} (remove --skip-agent-build to build it)`);
  }
  // Bug 原因：第一目标过去只按 bundle 是否存在决定构建，bootstrap 会把上一代 dist
  // 复制进所有平台 archive。只有本轮第一目标真实构建后，后续目标才允许 skipBuild 复用。
  log("building current agent bundle via scripts/build-desktop-agent-cli.mjs");
  await runCommand(
    process.execPath,
    [join(repoRoot, "scripts/build-desktop-agent-cli.mjs")],
    repoRoot,
  );
  if (!(await pathExists(bundlePath))) {
    throw new Error(`Agent bundle still missing after build: ${bundlePath}`);
  }
  return bundlePath;
}

// 原生检索工具必须按目标 release plan 现做，不能按文件存在复用 mock-cdn 或 bundled-tools。
// [失败路径] 历史问题：复用会让 macOS 的 rg13 顶替 Server 发行包的 rg14，并缺工具许可声明。
// 统一交给 scripts/prepare-native-search-tools.mjs，缓存命中也要过版本、摘要与架构校验。
async function resolveNativeToolsDir(repoRoot: string, target: ServerTarget): Promise<string> {
  // 修复：此前按“文件存在”复用 mock-cdn/releases/*/tools 或 bundled-tools。远端 macOS 资源固定为 rg13，
  // 会被当成独立 Server 发行包的 rg14 复用；这些目录也可能缺少工具许可声明。现在统一交给
  // prepare-native-search-tools.mjs 按目标 release plan 准备到 server-cli 自有缓存：内网依赖源已配置时下载，
  // 未配置时解包仓库归档；缓存命中同样要通过版本、摘要与架构校验，并刷新同目录声明。
  const [platform, arch] = target.split("-");
  const cacheDir = join(repoRoot, "node_modules/.cache/zcode-server-cli", "tools", target);
  log(`prepare native search target assets: ${target}`);
  await runCommand(
    process.execPath,
    [
      join(repoRoot, "scripts/prepare-native-search-tools.mjs"),
      `--platform=${platform}`,
      `--arch=${arch}`,
      `--output-dir=${cacheDir}`,
    ],
    repoRoot,
  );
  if (!(await pathExists(cacheDir)))
    throw new Error(`Native search tools preparation produced no directory for ${target}`);
  return cacheDir;
}

// 扫描 apps/zcode-cli/packages 与 packages 两个根，把 package.json 的 name 映射到目录。
// [失败路径] package.json 解析失败被吞掉，该包不会进入 staging，运行时会缺依赖。
async function resolveWorkspacePackageDirs(repoRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const root of [join(repoRoot, "apps/zcode-cli/packages"), join(repoRoot, "packages")]) {
    if (!(await pathExists(root))) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJsonPath = join(root, entry.name, "package.json");
      if (!(await pathExists(packageJsonPath))) continue;
      try {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
          name?: string;
        };
        if (packageJson.name) map.set(packageJson.name, join(root, entry.name));
      } catch {
        // 非 package 目录不影响其它 workspace 包 staging。
      }
    }
  }
  return map;
}

// 缺省时用 currentServerTarget，显式 --target 必须落在 supportedServerTargets 内。
// [失败路径] 非法值抛错并列出支持列表，避免静默回退到宿主平台。
function parseTarget(argv: readonly string[]): ServerTarget {
  const index = argv.indexOf("--target");
  if (index < 0) return currentServerTarget();
  const value = argv[index + 1];
  if (!value || !supportedServerTargets.includes(value as ServerTarget)) {
    throw new Error(
      `Invalid --target: ${value ?? "<missing>"} (supported: ${supportedServerTargets.join(", ")})`,
    );
  }
  return value as ServerTarget;
}

// 编排顺序固定：定位根目录、解析目标、读声明、校验 dist、准备资源，最后交给 stageRelease。
// [并发] agent bundle 与 node 二进制并行准备，二者互不写同一目录。
// [资源] 原生工具与工作区包映射也并行，任一 reject 都会让整轮打包失败。
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const repoRoot = await findRepoRoot(packageRoot);
  const target = parseTarget(argv);
  // 构建只读取并附带已有声明，校验由显式 licenses 命令负责；运行时 server 不依赖仓库脚本。
  const { readThirdPartyNotices, readNodeNotices } = (await import(
    pathToFileURL(join(repoRoot, "scripts/third-party-notices.mjs")).href
  )) as {
    readThirdPartyNotices: (root: string) => Promise<Buffer>;
    readNodeNotices: (version: string, root: string) => Promise<{ source: unknown; bytes: Buffer }>;
  };
  const [thirdParty, nodeNotice] = await Promise.all([
    readThirdPartyNotices(repoRoot),
    readNodeNotices(SERVER_RUNTIME_NODE_VERSION, repoRoot),
  ]);

  const distDir = join(packageRoot, "dist");
  if (!(await pathExists(join(distDir, "server-cli.js")))) {
    throw new Error(
      `Missing tsup output in ${distDir}; run pnpm --filter @zcode/server-cli build first`,
    );
  }

  const appVersion = (
    JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string }
  ).version;
  const [agentBundlePath, nodeBinaryPath] = await Promise.all([
    ensureAgentBundle(repoRoot, argv.includes("--skip-agent-build")),
    ensureNodeBinary(repoRoot, target),
  ]);
  const [nativeToolsDir, officialPluginsDir, workspacePackageDirs] = await Promise.all([
    resolveNativeToolsDir(repoRoot, target),
    Promise.resolve(join(repoRoot, "apps/zcode-cli/packages")),
    resolveWorkspacePackageDirs(repoRoot),
  ]);

  // stageRelease 是唯一产物出口，输入包含 dist、agent bundle、node 二进制、skills 与 notices。
  // [事务] 输出目录固定为 packageRoot 下的 dist-release，构建失败不应被当作成功归档。
  // archive 与 componentArchives 由命令行开关控制，关掉只影响归档形态不影响目录内容。
  const staged = await stageRelease({
    target,
    appVersion,
    distDir,
    agentBundlePath,
    bundledSkillsDir: join(repoRoot, "apps/zcode-cli/packages/bundled-skills"),
    nodeBinaryPath,
    notices: {
      thirdParty: thirdParty.toString("utf8"),
      node: nodeNotice.bytes.toString("utf8"),
      nodeSource: JSON.stringify(nodeNotice.source, null, 2) + "\n",
    },
    workspaceNodeModulesDir: join(repoRoot, "node_modules"),
    workspacePackageDirs,
    nativeToolsDir,
    officialPluginsDir,
    outputDir: join(packageRoot, "dist-release"),
    archive: !argv.includes("--no-archive"),
    componentArchives: !argv.includes("--skip-component-archives"),
  });

  log(`release dir: ${staged.releaseDir}`);
  if (staged.archivePath) log(`archive: ${staged.archivePath}`);
  log(`packaged dependencies: ${staged.packagedDependencies.join(", ")}`);
}

// 顶层 await 让进程退出码跟随 main 的异常，CI 能据此判定失败。
// [失败路径] 未捕获异常会打印堆栈并以非零码退出，不会留下成功假象。
// 日志最后三行分别给出 release 目录、归档路径与依赖清单，便于人工核对。
await main();
