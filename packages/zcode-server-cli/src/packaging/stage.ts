// INV-01 声明文本必须非空；守住位置：stageRelease 开头遍历 options.notices 三项的 trim 判空；改错故障：空许可被写进 runtime 与组件归档，合规问题拖到发布后才暴露。
// INV-02 [事务] 发行目录是整体重建而非增量覆盖；守住位置：stageRelease 对 releaseDir 的 rm 递归强制删除；改错故障：上一次构建的残留文件混入新包，组件哈希与 manifest 记录的路径集合不一致。
// INV-03 [资源] 旧组件归档必须随重建一起清掉；守住位置：stageRelease 删除 components/<target> 与 .components 的两次 rm；改错故障：上一轮按旧 manifest 算出的组件目录仍在，CDN 上传后 catalog 指向与本次产物不符的组件。
// INV-04 [顺序] 许可文件先落盘再算哈希；守住位置：mkdir runtime 之后的三次 writeFile 与 licenses 子目录写入；改错故障：哈希先于写入，组件内容不含许可文件，安装侧校验与合规审计同时失败。
// INV-05 入口 bundle 与 sourcemap 同名双写；守住位置：stageRelease 对 server-cli.js 与 server-core.js 的循环；改错故障：改名或只写一份，launcher 与 cli.ts 的相对路径解析都指不到入口。
// INV-06 [权衡] 依赖闭包以产物扫描为事实源；守住位置：bundleSources 聚合后用 collectBareModuleSpecifiers 提取的 referencedPackages；改错故障：改回 tsup external 清单，声明与实际引用漂移，运行时才报模块缺失。
// INV-07 [事务] 闭包必须按目标平台裁剪；守住位置：closure 构建时对 rawClosure 的 isTargetSpecificPackage 过滤；改错故障：别平台原生包被打进发行包，体积膨胀且安装后加载原生模块失败。
// INV-08 [资源] node-pty 只带目标平台预编译；守住位置：packageName 为 node-pty 分支的 isNodePtyRuntimePath 过滤与 ensureNodePtyPrebuild 调用；改错故障：多平台预编译全量复制，或取错平台二进制导致伪终端启动失败。
// INV-09 [权衡] 只有已知 peer 冲突包保留嵌套 node_modules；守住位置：copyPackageDir 第四个参数仅在 ajv-formats 与 ajv-keywords 为真；改错故障：全量置真会复制整棵开发依赖树，全部置假则 ajv 双版本互相覆盖。
// INV-10 [资源] koffi 依赖需要裁剪运行时；守住位置：packageName 为 koffi 分支的 pruneKoffiRuntime 调用；改错故障：无关平台的原生库随包发布，组件体积超限并可能与系统库冲突。
// INV-11 [失败路径] 官方插件 manifest 读取失败即中止；守住位置：assertOfficialPluginRuntime 中 readFile 与 JSON 解析的 try/catch 抛错；改错故障：跳过无 manifest 的目录，残缺插件被打包，远端启用时才报错。
// INV-12 [失败路径] MCP 引用的运行时文件必须真实存在；守住位置：assertOfficialPluginRuntime 对 ${ZCODE_PLUGIN_ROOT}/ 前缀引用的 access 检查与 missing 汇总；改错故障：只带 plugin.json 不带 dist，MCP server 启动时找不到入口文件。
// INV-13 插件目录归属以 package.json 判定；守住位置：copyDirectoryIfPresent 第二个循环对 join(sourceDir, name, package.json) 的 access；改错故障：CI 跨 job 残留的 node_modules-only 目录被当成官方插件复制进包。
// INV-14 superpowers-plugin 不得按官方插件复制；守住位置：candidates 的 filter 中排除该名字；改错故障：内部插件被重复打包，与 Agent 组件里的同名插件形成两份来源。
// INV-15 [契约] native 二进制必须随带第三方声明；守住位置：copyNativeTools 中 THIRD-PARTY-NOTICES.txt 与 SOURCES.json 的读取及空内容抛错；改错故障：native-search-tools 组件缺声明，合规校验覆盖不到该组件。
// INV-16 [资源] 非 Windows 目标要补执行位；守住位置：copyNativeTools 末尾、node 二进制与 launcher 写入后的 chmod 0o755；改错故障：解包后二进制与启动脚本不可执行，用户侧直接报权限不足。
// INV-17 [失败路径] 内置技能必需资产要先校验；守住位置：stageRelease 对 skills/dynamic-workflows 下三个文件的 access；改错故障：Agent 组件缺工作流资产，启用技能时读不到模式与示例。
// INV-18 [事务] manifest 与组件元数据必须同源；守住位置：createRuntimeManifest 接收 componentMeta，随后 writeFile manifest.json 再覆盖一次 components；改错故障：两处各自计算哈希与大小，manifest 与实际归档无法对齐。
//
// 模块职责：把 dist 产物、Agent bundle、随包 Node、依赖闭包、native tools、官方插件与内置技能组装成 zcode-server 发行目录，计算组件身份并按需生成归档。
// 状态所有权：全部写入都落在 outputDir 指定的目标目录下，函数不保留跨调用状态，返回的 releaseDir、archivePath 与组件归档路径是唯一事实。
// 阅读顺序：先读 StageOptions 与 StagedRelease 契约，再看两个拷贝助手与插件 fail-closed 校验，随后按清理、许可、入口、依赖、组件、归档的顺序读 stageRelease。
import { access, chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRuntimeManifest, type ServerTarget } from "../runtime/manifest.js";
import {
  collectBareModuleSpecifiers,
  copyPackageDir,
  ensureNodePtyPrebuild,
  isNodePtyRuntimePath,
  isTargetSpecificPackage,
  pruneKoffiRuntime,
  resolveProductionPackageClosure,
} from "./stageDependencies.js";
import { createComponentArchive, hashPaths, runPackagingCommand } from "./stageArchives.js";

export { collectBareModuleSpecifiers, isNodePtyRuntimePath, resolveProductionPackageClosure };

// [契约] StageOptions 是 staging 的唯一输入面，路径与许可见此项，函数内部不再读环境变量或仓库约定。
// [契约] target 决定 release 目录名、node 文件名、launcher 扩展名与 native tools 集合，四处判断必须一致。
// [来源] notices 由构建入口从第三方合规 owner 读取后传入，staging 只消费不自行拼凑。
// [契约] workspacePackageDirs 覆盖未被 pnpm 链接的 workspace 包，缺失时闭包解析会漏掉这类依赖。
// [权衡] archive 与 componentArchives 默认开启，SSH 验证可只关归档生成而保留哈希，省去重复压缩。
export interface StageOptions {
  target: ServerTarget;
  appVersion: string;
  /** tsup 产物目录（server-cli.js / server-core.js） */
  distDir: string;
  /** 既有 CLI/Agent bundle（zcode.cjs，自包含 CJS） */
  agentBundlePath: string;
  /** CLI 内置技能包；不依赖官方插件缓存。 */
  bundledSkillsDir: string;
  /** 已准备好的目标平台 Node 二进制 */
  nodeBinaryPath: string;
  /** 构建入口从统一合规 owner（scripts/third-party-notices.mjs）读取后传入；组件组装不能自行拼凑许可。 */
  notices: { thirdParty: string; node: string; nodeSource: string };
  /** 依赖闭包解析与复制的来源 node_modules */
  workspaceNodeModulesDir: string;
  /** 未被 pnpm 链接到 node_modules 的 workspace 包（例如 @zcode/tui）。 */
  workspacePackageDirs?: ReadonlyMap<string, string>;
  /** 发行目录的输出父目录 */
  outputDir: string;
  /** 已准备好的 native search tools 根目录（tools/<id>/<binary>）。 */
  nativeToolsDir?: string;
  /** 官方插件源码或已 seed 的 packages 目录。 */
  officialPluginsDir?: string;
  /** 是否同时产出 tar.gz（默认 true） */
  archive?: boolean;
  /** 是否生成独立组件归档（默认 true）；关闭时仍保留组件内容哈希和大小。 */
  componentArchives?: boolean;
}

export interface StagedRelease {
  releaseDir: string;
  archivePath: string | null;
  componentArchivePaths: string[];
  packagedDependencies: string[];
}

// [契约] 两个 launcher 常量都以发行根为基准定位 runtime，一条走 sh、一条走 cmd，行为必须对齐。
// [顺序] POSIX 脚本先把 CDPATH 置空再 cd，避免调用方环境污染定位结果。
// [顺序] Windows 脚本用 %~dp0.. 回到发行根，再以 %* 透传全部参数，不二次解析参数。
// [失败路径] 两个脚本都假定自己位于发行根下一层，launcherPath 挪位后相对上跳会指错目录。
// [权衡] 脚本内联为常量而不是从模板文件读取，避免发布时还要额外携带模板资产。
const POSIX_LAUNCHER = `#!/bin/sh
# 由 zcode-server staging 生成：定位发行根后用随包 Node 启动 Server CLI。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$DIR/runtime/node" "$DIR/runtime/server-cli.js" "$@"
`;

const WINDOWS_LAUNCHER = [
  "@echo off",
  'set "DIR=%~dp0.."',
  '"%DIR%\\runtime\\node.exe" "%DIR%\\runtime\\server-cli.js" %*',
  "",
].join("\r\n");

// [失败路径] 源目录为空或不存在时返回空数组，调用方据此跳过 official-plugins 组件，而不是让 staging 失败。
// [契约] 只认以 -plugin 结尾的目录并按名排序，排序保证同一次构建的组件哈希稳定。
// [资源] 目录存在但缺 package.json 时逐个跳过，源目录访问失败的错误在这里被吞掉。
// [顺序] 先按 package.json 判定归属，再复制并校验，两步分开可避免把残缺目录先拷进 release。
// [事务] 每个插件先 copyPackageDir 到 staged 目录，再立即 assertOfficialPluginRuntime，校验失败即中断整次 staging。
// [契约] 返回名去掉 -plugin 后缀，与 manifest 的 plugins 字段和 catalog 命名保持一致。
// [权衡] 排除 superpowers-plugin 是因为它随 Agent 组件交付，重复打包会出现两份同名插件。
async function copyDirectoryIfPresent(
  sourceDir: string | undefined,
  targetDir: string,
): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const candidates = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-plugin"))
    .map((entry) => entry.name)
    .filter((name) => name !== "superpowers-plugin")
    .sort();
  // Bug 原因：只按 "-plugin" 后缀识别官方插件，会把 checkout 残留的僵尸目录也算进去。CI 用
  // GIT_CLEAN_FLAGS "-e node_modules/" 跨 job 保留 node_modules，别的分支（例如把 zcode-cua-plugin
  // 改名为 computer-use-plugin 的分支）install 过的插件目录切回来后只剩 node_modules；tracked 文件
  // 全没了，但目录还在。官方插件的 package.json 都是 tracked 文件，以它是否存在判定"该目录属于
  // 当前 checkout"；通过判定的插件仍走下方 fail-closed 校验，不放松对残缺插件的拒绝。
  const names: string[] = [];
  for (const name of candidates) {
    try {
      await access(join(sourceDir, name, "package.json"));
      names.push(name);
    } catch {
      // 无 package.json ⇒ 不是当前 checkout 的 workspace 包，跳过。
    }
  }
  for (const name of names) {
    const stagedDir = join(targetDir, name);
    await copyPackageDir(join(sourceDir, name), stagedDir);
    await assertOfficialPluginRuntime(stagedDir, name);
  }
  return names.map((name) => name.replace(/-plugin$/u, ""));
}

const PLUGIN_ROOT_PLACEHOLDER_PREFIX = "${ZCODE_PLUGIN_ROOT}/";

/**
 * Bug 原因：legacy prepare-prebuilds.mjs 曾显式构建并断言 android-emulator / ios-simulator /
 * browser-use 的 `dist/mcp/server.js`；切到 stageRelease 后只剩整目录复制，而插件 dist 被
 * gitignore，干净 CI 工作区会把只有 plugin.json 与 skills、却没有 MCP 入口的插件静默打进
 * archive，远端启用插件后 MCP server 启动时才报找不到文件。这里以 plugin.json 声明为事实源做
 * fail-closed 校验：manifest 缺失，或 mcpServers 的 command/args 引用的 `${ZCODE_PLUGIN_ROOT}/...`
 * 文件不在 staged 目录里，staging 直接失败，而不是产出残缺 archive。
 */
// [失败路径] manifest 读取或解析失败直接抛出带 cause 的错误，并带上插件名与路径，便于定位是哪个插件没构建。
// [契约] 事实源是 .zcode-plugin 下的 plugin.json 的 mcpServers，不扫描 dist 目录猜测入口。
// [契约] 只校验以 ${ZCODE_PLUGIN_ROOT}/ 开头的 command 与 args 引用，其余绝对路径不归 staging 管。
// [事务] 缺失项先累积到 missing 再统一抛出，一次报全所有缺失文件，避免逐个修复重跑。
// [资源] 校验只做 access 不复制文件，因此不会改变 staged 目录内容与后续哈希结果。
// [失败路径] 缺失非空即抛错，让 staging 提前失败，而不是产出远端才暴露的残缺 archive。
async function assertOfficialPluginRuntime(stagedDir: string, name: string): Promise<void> {
  const manifestPath = join(stagedDir, ".zcode-plugin", "plugin.json");
  let manifest: {
    mcpServers?: Record<string, { command?: unknown; args?: unknown } | undefined>;
  };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
  } catch (error) {
    throw new Error(`Official plugin ${name} has no readable manifest: ${manifestPath}`, {
      cause: error,
    });
  }
  const missing: string[] = [];
  for (const server of Object.values(manifest.mcpServers ?? {})) {
    if (!server) continue;
    const references = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
    for (const reference of references) {
      if (typeof reference !== "string" || !reference.startsWith(PLUGIN_ROOT_PLACEHOLDER_PREFIX))
        continue;
      const relativePath = reference.slice(PLUGIN_ROOT_PLACEHOLDER_PREFIX.length);
      try {
        await access(join(stagedDir, ...relativePath.split("/")));
      } catch {
        missing.push(relativePath);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Official plugin ${name} manifest references MCP runtime files missing from the staged package: ${missing.join(", ")} (build the plugin before staging)`,
    );
  }
}

const BUNDLED_SKILL_PACK_TOP_LEVEL_PATHS: readonly string[] = ["README.md", "skills"];

// [契约] Windows 只带 ripgrep 与 ugrep，其余平台带 bfs、ripgrep、ugrep，与 native-search-tools 组件范围一致。
// [失败路径] 单个工具源文件缺失时继续下一个，不让某个可选工具拖垮整次构建。
// [顺序] 目标路径保留源文件名（rg 或 rg.exe），先递归建父目录再复制。
// [资源] 复制时解开符号链接，避免发行包里出现指向工作区的悬空链接。
// [契约] 每个工具必须同时带上 THIRD-PARTY-NOTICES.txt 与 SOURCES.json，内容为空即抛错。
// [资源] 非 win32 目标复制后补 chmod 0o755，否则解包后二进制没有执行位。
async function copyNativeTools(
  sourceDir: string | undefined,
  targetDir: string,
  target: ServerTarget,
): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const ids = target.startsWith("win32-") ? ["ripgrep", "ugrep"] : ["bfs", "ripgrep", "ugrep"];
  const copied: string[] = [];
  for (const id of ids) {
    const source = join(
      sourceDir,
      id,
      id === "ripgrep"
        ? target.startsWith("win32-")
          ? "rg.exe"
          : "rg"
        : id + (target.startsWith("win32-") ? ".exe" : ""),
    );
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(targetDir, id, source.split(sep).pop() ?? id);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { dereference: true });
    // 修复：只复制可执行文件会让独立 native-search-tools 组件丢失已准备的声明。
    for (const notice of ["THIRD-PARTY-NOTICES.txt", "SOURCES.json"]) {
      const bytes = await readFile(join(dirname(source), notice));
      if (!bytes.length) throw new Error(`Empty native notice: ${notice}`);
      await writeFile(join(dirname(targetPath), notice), bytes);
    }
    if (!target.startsWith("win32-")) await chmod(targetPath, 0o755);
    copied.push(id);
  }
  return copied;
}

/** 组装 `zcode-server-<os>-<arch>/` 发行目录（spec §7.1）；只做本地组装，不上传、不发布。 */
// [事务] 先遍历 notices 判空，再删旧目录；校验必须早于删除，避免删完才发现缺许可。
// [事务] 删除 releaseDir、components/<target> 与 .components 是重建语义，旧产物一律不参与本次发布。
// [顺序] 目录建好后立即写入三份 runtime 许可与两个组件许可，时间点必须早于组件哈希。
// [契约] 入口 bundle 与 sourcemap 用同名写入 runtime，名字与 cli.ts 的相对解析路径绑定。
// [资源] 随包 Node 复制后按平台补执行位，Windows 目标改名为 node.exe。
// [事务] 依赖闭包以 bundleSources 的扫描结果为起点，逐个包复制到 runtime/node_modules 对应层级。
// [顺序] native tools 与官方插件先复制再算组件，两者结果同时进入 manifest。
// [顺序] launcher 最后写入并补执行位，Windows 目标用 cmd 版本覆盖同一路径。
export async function stageRelease(options: StageOptions): Promise<StagedRelease> {
  for (const [name, value] of Object.entries(options.notices)) {
    if (!value.trim()) throw new Error(`Missing distribution notice: ${name}`);
  }
  const releaseName = `zcode-server-${options.target}`;
  const outputRoot = resolve(options.outputDir);
  const releaseDir = join(outputRoot, releaseName);
  const runtimeDir = join(releaseDir, "runtime");
  await rm(releaseDir, { force: true, recursive: true });
  // staging 是发布目录的重建操作：删除同 target 的旧组件归档，避免上一次构建的
  // hash 仍被误上传到 CDN，导致 catalog 暴露无法与本次 manifest 对齐的组件。
  await rm(join(outputRoot, "components", options.target), {
    force: true,
    recursive: true,
  });
  await rm(join(outputRoot, ".components"), { force: true, recursive: true });
  await mkdir(join(releaseDir, "bin"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  // 每个可独立下载的组件都要带适用声明，并在计算组件哈希前写入。
  await writeFile(join(runtimeDir, "THIRD-PARTY-NOTICES.md"), options.notices.thirdParty);
  await writeFile(join(runtimeDir, "LICENSE.node.txt"), options.notices.node);
  await writeFile(join(runtimeDir, "NODE-SOURCES.json"), options.notices.nodeSource);
  for (const component of ["agent", "official-plugins"]) {
    await mkdir(join(runtimeDir, "licenses", component), { recursive: true });
    await writeFile(
      join(runtimeDir, "licenses", component, "THIRD-PARTY-NOTICES.md"),
      options.notices.thirdParty,
    );
  }

  // 入口 bundle 与 sourcemap 同名复制，文件名必须与 cli.ts 的相对路径解析保持一致。
  const bundleSources: string[] = [];
  for (const entryName of ["server-cli.js", "server-core.js"]) {
    const sourcePath = join(options.distDir, entryName);
    const contents = await readFile(sourcePath, "utf8");
    bundleSources.push(contents);
    await writeFile(join(runtimeDir, entryName), contents, "utf8");
  }
  await writeFile(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: releaseName, private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await cp(options.agentBundlePath, join(runtimeDir, "zcode.cjs"), {
    dereference: true,
  });
  // 修复原因：dynamic-workflows 已迁出插件，按 -plugin 复制会漏带工作流的必需技能。
  // 随 Agent 组件独立交付并参与内容哈希，不能依赖服务器旧版本的插件缓存。
  for (const file of ["SKILL.md", "patterns.md", "examples.md"]) {
    const skillPath = join(options.bundledSkillsDir, "skills/dynamic-workflows", file);
    try {
      await access(skillPath);
    } catch (cause) {
      throw new Error(`Missing bundled skill required asset: ${skillPath}`, { cause });
    }
  }
  // 插件缓存可能缺包或过期；只复制 Agent 源中的发布资产，避免二次复制覆盖。
  await copyPackageDir(
    options.bundledSkillsDir,
    join(runtimeDir, "packages/bundled-skills"),
    (relativePath) => BUNDLED_SKILL_PACK_TOP_LEVEL_PATHS.includes(relativePath.split(sep)[0] ?? ""),
  );
  // Agent bundle 是第三个实际运行入口；只扫描 Server bundle 会漏掉外置的 TUI/Playwright。
  bundleSources.push(await readFile(options.agentBundlePath, "utf8"));

  const nodeTargetPath = join(
    runtimeDir,
    options.target.startsWith("win32-") ? "node.exe" : "node",
  );
  await cp(options.nodeBinaryPath, nodeTargetPath, { dereference: true });
  if (!options.target.startsWith("win32-")) await chmod(nodeTargetPath, 0o755);

  // runtime/node_modules 以产物扫描为事实源：bundle 引用什么就装什么（含传递依赖），
  // 不使用 tsup external 声明列表，避免声明与实际引用漂移。
  const referencedPackages = new Set<string>();
  for (const source of bundleSources) {
    for (const name of collectBareModuleSpecifiers(source)) referencedPackages.add(name);
  }
  const rawClosure = await resolveProductionPackageClosure(
    [...referencedPackages],
    options.workspaceNodeModulesDir,
    options.workspacePackageDirs,
  );
  const closure = new Map(
    [...rawClosure].filter(([packageName]) => isTargetSpecificPackage(packageName, options.target)),
  );
  const nodeModulesTargetDir = join(runtimeDir, "node_modules");
  for (const [packageName, packageDir] of closure) {
    const targetDir = join(nodeModulesTargetDir, ...packageName.split("/"));
    await mkdir(dirname(targetDir), { recursive: true });
    if (packageName === "node-pty") {
      await copyPackageDir(packageDir, targetDir, (relativePath) =>
        isNodePtyRuntimePath(relativePath, options.target),
      );
    } else {
      // Agent 的外置依赖存在 peer 版本并存（例如 ajv6 + ajv8）。只为已知 peer
      // 冲突包保留 nested node_modules，避免把 pnpm 的整棵开发依赖树复制进发行包。
      await copyPackageDir(
        packageDir,
        targetDir,
        undefined,
        packageName === "ajv-formats" || packageName === "ajv-keywords",
      );
      if (packageName === "koffi") await pruneKoffiRuntime(packageDir, targetDir, options.target);
    }
  }

  if (closure.has("node-pty")) {
    await ensureNodePtyPrebuild(options, nodeModulesTargetDir);
  }

  const tools = await copyNativeTools(
    options.nativeToolsDir,
    join(runtimeDir, "tools"),
    options.target,
  );
  const plugins = await copyDirectoryIfPresent(
    options.officialPluginsDir,
    join(runtimeDir, "packages"),
  );

  const launcherPath = join(
    releaseDir,
    "bin",
    options.target.startsWith("win32-") ? "zcode.cmd" : "zcode",
  );
  await writeFile(launcherPath, POSIX_LAUNCHER, "utf8");
  if (options.target.startsWith("win32-")) {
    await writeFile(launcherPath, WINDOWS_LAUNCHER, "utf8");
  } else {
    await chmod(launcherPath, 0o755);
  }

  // [契约] 组件清单是发布的身份边界，node-runtime、server-runtime、agent-runtime 三项固定存在。
  // [事务] official-plugins 与 native-search-tools 按实际复制结果条件加入，空数组时不留空组件。
  // [契约] 每个组件的 paths 用 releaseDir 相对路径书写，hashPaths 以此为输入计算内容哈希。
  // [顺序] 先算全部组件哈希汇总 componentMeta，再按需生成独立归档，归档相对路径回填到同一对象。
  // [权衡] 关闭独立归档只跳过压缩与复制，`componentSpecs` 的组件身份与大小校验保持完整。
  const componentSpecs = [
    {
      id: "node-runtime",
      paths: [
        options.target.startsWith("win32-") ? "runtime/node.exe" : "runtime/node",
        "runtime/LICENSE.node.txt",
        "runtime/NODE-SOURCES.json",
      ],
    },
    {
      id: "server-runtime",
      paths: [
        "runtime/server-cli.js",
        "runtime/server-core.js",
        "runtime/package.json",
        "runtime/node_modules",
        "runtime/THIRD-PARTY-NOTICES.md",
      ],
    },
    {
      id: "agent-runtime",
      paths: ["runtime/zcode.cjs", "runtime/packages/bundled-skills", "runtime/licenses/agent"],
    },
    ...(plugins.length > 0
      ? [
          {
            id: "official-plugins",
            paths: [
              ...plugins.map((name) => `runtime/packages/${name}-plugin`),
              "runtime/licenses/official-plugins",
            ],
          },
        ]
      : []),
    ...(tools.length > 0 ? [{ id: "native-search-tools", paths: ["runtime/tools"] }] : []),
  ];
  const componentMeta: Array<{
    id: string;
    sha256: string;
    paths: string[];
    sizeBytes: number;
    archivePath?: string;
  }> = [];
  const componentArchivePaths: string[] = [];
  for (const component of componentSpecs) {
    const info = await hashPaths(releaseDir, component.paths);
    componentMeta.push({ ...component, ...info });
  }
  const manifest = createRuntimeManifest(options.target, options.appVersion, {
    tools,
    plugins,
    components: componentMeta,
  });
  // SSH 开发验证只安装整包；独立组件归档会重复哈希、复制和压缩同一批内容。
  // 仅跳过归档生成，保留上方组件身份计算和完整资源校验；默认发布链仍生成组件包。
  if (options.componentArchives !== false) {
    for (const component of componentMeta) {
      const archive = await createComponentArchive(
        releaseDir,
        outputRoot,
        options.target,
        component.id,
        component.paths,
      );
      component.archivePath = relative(outputRoot, archive.archivePath).split(sep).join("/");
      componentArchivePaths.push(archive.archivePath);
    }
  }
  await writeFile(
    join(releaseDir, "manifest.json"),
    `${JSON.stringify({ ...manifest, components: componentMeta }, null, 2)}\n`,
    "utf8",
  );

  // [顺序] 整包归档在 manifest 写盘之后生成，压缩的是已含 manifest 的完整 release 目录。
  // [契约] 扩展名按平台取 zip 或 tar.gz，命令在 outputRoot 下执行，归档内顶层即 release 名。
  // [资源] 生成前先删同名归档，避免追加写入产出上一次构建的残留内容。
  // [契约] 返回值汇总 releaseDir、整包归档路径、组件归档路径与按名排序的依赖清单，调用方不再回读目录。
  let archivePath: string | null = null;
  if (options.archive !== false) {
    const extension = options.target.startsWith("win32-") ? "zip" : "tar.gz";
    archivePath = join(outputRoot, `${releaseName}.${extension}`);
    await rm(archivePath, { force: true });
    if (extension === "zip")
      await runPackagingCommand("zip", ["-qr", archivePath, releaseName], outputRoot);
    else await runPackagingCommand("tar", ["-czf", archivePath, releaseName], outputRoot);
  }

  return {
    releaseDir,
    archivePath,
    componentArchivePaths,
    packagedDependencies: [...closure.keys()].sort(),
  };
}
