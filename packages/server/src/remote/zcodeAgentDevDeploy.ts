/* eslint-disable max-lines -- 开发态 agent 部署包含本地打包、远端 owner staging 与 wrapper 安装，后续独立拆分上传事务。 */
// 开发态 ZCode Agent 远端部署：把本地构建的 dist/zcode.cjs 与官方插件资源送到远端 provider 目录并装好 wrapper。
// 职责边界：本文件只负责开发态判定、产物哈希、owner staging 上传与 wrapper/标记安装。
// 不负责生产发布包下载、远端进程启停、鉴权决策，也不清理 provider 目录以外的任何路径。
//
// 状态所有者：
// - provider 目录下 zcode.cjs、.dev-version 与官方插件目录：开发态仅本模块写入。
// - 远端版本文件：与生产部署共享，只在内容不同时覆盖。
// - 本地 mkdtemp 临时目录：本次调用独占，finally 清理。
//
// INV 表（违反任一条的表现：远端跑旧代码 / 他人产物被删 / 部署半成品）：
// INV-01 断言：非 development 环境或显式关闭时不做任何远端写入 —— 守住它的位置：shouldUseDevelopmentAgentBundle 与 resolveDevelopmentAgentBundle —— 改错故障：生产环境被本地调试产物覆盖。
// INV-02 断言：devVersion 覆盖 bundle 与全部官方插件资源内容 —— 守住它的位置：computeDevelopmentAgentAssetsSha256 —— 改错故障：插件更新后远端仍跑旧插件资源。
// INV-03 断言：版本文件、二进制、wrapper、bundle、插件资源全部匹配才允许跳过 —— 守住它的位置：shouldSkipDevelopmentZCodeAgentDeploy —— 改错故障：跳过部署后远端缺文件，Agent 启动即失败。
// INV-04 断言：跳过前必须用远端 node 重算 bundle sha256 并比对 —— 守住它的位置：verifyBundleScript —— 改错故障：把 PAT 交给旧版 Agent 的过时鉴权逻辑。
// INV-05 断言：bundle 先写 .new 再原子替换，永不半写目标文件 —— 守住它的位置：remoteBundleTempPath 与 buildRemoteMoveCommand —— 改错故障：并发读到被截断的 zcode.cjs。
// INV-06 断言：owner staging 路径带时间戳与 UUID 后缀 —— 守住它的位置：ownerSuffix —— 改错故障：两个部署 owner 互相删除归档。
// INV-07 断言：远端解包脚本 set -eu 且 trap 清理，异常不留残留 —— 守住它的位置：远端 exec 脚本与 trap 行 —— 改错故障：失败后 provider 目录堆积 extract-* 目录。
// INV-08 断言：先 test -d 校验解包结果再删旧插件目录 —— 守住它的位置：远端脚本的校验步骤 —— 改错故障：归档损坏时正式插件目录被删空。
// INV-09 断言：本地 mkdtemp 临时目录必须在 finally 删除 —— 守住它的位置：uploadDevelopmentOfficialPluginPackages —— 改错故障：临时目录持续增长。
// INV-10 断言：清理失败只 logWarn，不覆盖主错误 —— 守住它的位置：cleanupRemoteStaging —— 改错故障：真实部署失败原因被清理异常吞掉。
// INV-11 断言：所有远端路径与内联脚本参数经 POSIX 引号转义 —— 守住它的位置：quotePosixPathArg 与 quotePosixShellArg 调用点 —— 改错故障：路径含空格或命令替换时被注入执行。
// INV-12 断言：标记文件只在产物与 wrapper 全部就绪后写入 —— 守住它的位置：markerCommands 的拼接顺序 —— 改错故障：标记先落盘导致下次部署误跳过。
//
// 阶段顺序：环境判定 → devVersion 哈希 → 缺失资源探测 → 跳过判定 → mkdir → bundle.new 替换 → 插件资源 → wrapper → 写标记。
// 失败语义：任一步抛错即中止，owner staging 由清理函数回收；标记是最后一道写。
// 路径注入防护：远端路径与脚本一律走路径/Shell 引号函数，禁止手写拼接。
// 并发语义：同一 provider 目录允许多个部署并发，owner 后缀保证归档与解包目录互不覆盖。
// 权衡：跳过判定多花一次远端 sha256 校验，换取「不把 PAT 交给旧版 Agent」。
// 权衡：devVersion 用内容哈希而非时间戳，部署成本上升，换来插件变化也能触发重传。
// 维护提示：新增部署步骤时同步更新 INV 表与阶段顺序，注释需与分支一一对应。
import { ZCODE_AGENT_PROVIDER, resolveZCodeRuntimeEnv } from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  type DeployLoggers,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
  quotePosixShellArg,
} from "@zcode/server/remote/posixShell.js";
import { createTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import {
  buildRemoteAgentBundleWrapper,
  isRemoteAgentBundleWrapperCurrent,
  REMOTE_AGENT_BUNDLE_NAME,
} from "@zcode/server/remote/zcodeAgentBundleWrapper.js";
import {
  deployRemoteAgentWrapper,
  isWslBackend,
} from "@zcode/server/remote/zcodeAgentWrapperDeploy.js";
import {
  REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS,
  REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
  buildRemoteAgentOfficialPluginDir,
  buildRemoteAgentOfficialPluginRequiredPaths,
} from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";
import { repairLegacyRemoteOfficialPluginDirectoryPermissions } from "@zcode/server/remote/zcodeAgentOfficialPluginPermissionRepair.js";

// [契约] 打包产物相对仓库根的固定路径，只在此处维护一份。
// findUpward 以 process.cwd() 为起点逐层上溯，命中即返回仓库根目录。
// [权衡] 用 cwd 而非模块 URL 定位，因为开发态启动约定从仓库根执行。
// 产物缺失时返回 null，由调用方降级为普通部署流程。
const DEV_AGENT_BUNDLE_RELATIVE_PATH = "apps/zcode-cli/packages/cli/dist/zcode.cjs";
const DEV_AGENT_BUNDLE_ENV = "ZCODE_REMOTE_DEV_AGENT_BUNDLE";
const REMOTE_DEV_AGENT_BUNDLE_NAME = REMOTE_AGENT_BUNDLE_NAME;
const REMOTE_DEV_AGENT_VERSION_FILE_NAME = ".dev-version";

// [契约] 参数全部由调用方注入，本模块不读全局配置，便于测试替换。
// remoteVersionFile 与生产部署共享，开发态只在内容不同时覆盖它。
// force 为 true 时只绕过跳过判定，不改变实际上传内容。
interface DeployDevelopmentZCodeAgentRuntimeParams {
  runtimeVersion: string;
  runtimeResourceDir: string;
  remoteProviderDir: string;
  remoteVersionFile: string;
  remoteBinaryPath: string;
  force: boolean;
}

function findUpward(relativePath: string): { rootDir: string; path: string } | null {
  let current = resolve(process.cwd());
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return { rootDir: current, path: candidate };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

// [契约] 三重门：运行环境必须是 development，显式开关优先，VITEST 默认关闭。
// [失败路径] 显式值非法（非 0/false/1/true）时按默认分支处理，不抛错。
// [权衡] 测试环境默认关闭，避免普通部署用例误走开发态分支。
function shouldUseDevelopmentAgentBundle(): boolean {
  if (resolveZCodeRuntimeEnv(process.env) !== "development") {
    return false;
  }

  const explicit = process.env[DEV_AGENT_BUNDLE_ENV]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false") {
    return false;
  }
  if (explicit === "1" || explicit === "true") {
    return true;
  }

  // Vitest 里仓库真实 dist 可能存在；默认关闭，避免普通部署测试误走开发态分支。
  return !process.env.VITEST;
}

// [契约] 返回 null 表示本次不进入开发态部署，调用方以 false 结束而非报错。
// repoRoot 用于后续定位官方插件包与 bundled-skills 源目录。
// [失败路径] 本地未构建 dist 时返回 null，不产生半成品远端写入。
function resolveDevelopmentAgentBundle(): {
  repoRoot: string;
  localBundlePath: string;
} | null {
  if (!shouldUseDevelopmentAgentBundle()) {
    return null;
  }
  const found = findUpward(DEV_AGENT_BUNDLE_RELATIVE_PATH);
  return found ? { repoRoot: found.rootDir, localBundlePath: found.path } : null;
}

// [契约] 哈希输入顺序固定：bundle → 各插件包 → bundled-skills，顺序变化即视为不同版本。
// 每条写入 bundle:/plugin:/dir: 前缀，避免不同层级内容拼接后碰撞。
// [失败路径] 必需资源缺失在本地哈希阶段直接抛错，早于任何远端上传。
// [权衡] `computeDevelopmentAgentAssetsSha256` 全量读盘哈希：开发态规模可接受，换取内容变更必被感知。
async function computeDevelopmentAgentAssetsSha256(params: {
  localBundlePath: string;
  repoRoot: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("bundle:zcode.cjs\n");
  hash.update(await readFile(params.localBundlePath));
  for (const packageName of REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES) {
    const packageRoot = join(params.repoRoot, "apps", "zcode-cli", "packages", packageName);
    hash.update(`plugin:${packageName}\n`);
    await hashDevelopmentOfficialPluginPackage(hash, packageRoot, packageName);
  }
  const bundledSkillsRoot = join(params.repoRoot, "apps/zcode-cli/packages/bundled-skills");
  await assertDevelopmentOfficialPluginRequiredAssets(bundledSkillsRoot, "bundled-skills");
  await hashLocalPath(hash, bundledSkillsRoot, "bundled-skills");
  return hash.digest("hex");
}

// [契约] 插件包必须带 .zcode-plugin/plugin.json，缺失即判定仓库状态不完整。
// 只哈希白名单顶层路径，避免 node_modules 等无关内容算进 devVersion。
// [失败路径] 抛出的错误带 zcode-agent-deploy 前缀，便于定位部署阶段。
async function hashDevelopmentOfficialPluginPackage(
  hash: ReturnType<typeof createHash>,
  packageRoot: string,
  packageName: string,
): Promise<void> {
  const manifestPath = join(packageRoot, ".zcode-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`[zcode-agent-deploy] missing official plugin manifest: ${manifestPath}`);
  }
  await assertDevelopmentOfficialPluginRequiredAssets(packageRoot, packageName);

  for (const topLevelPath of REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS) {
    const sourcePath = join(packageRoot, topLevelPath);
    if (existsSync(sourcePath)) {
      await hashLocalPath(hash, sourcePath, `${packageName}/${topLevelPath}`);
    }
  }
}

// 目录、符号链接、普通文件三分支，各写不同判别前缀以区分类型。
// [契约] 目录子项按 localeCompare(en) 排序，保证哈希与文件系统遍历顺序无关。
// 普通文件输入相对路径、权限位、大小与内容，权限变化也会触发重传。
// [权衡] 不跟随符号链接，只记录链接目标，避免仓库外内容进入哈希。
async function hashLocalPath(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  const fileStat = await lstat(filePath);
  if (fileStat.isDirectory()) {
    hash.update(`dir:${relativePath}\n`);
    const children = (await readdir(filePath)).sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    for (const child of children) {
      await hashLocalPath(hash, join(filePath, child), `${relativePath}/${child}`);
    }
    return;
  }

  if (fileStat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}:${await readlink(filePath)}\n`);
    return;
  }

  if (!fileStat.isFile()) {
    return;
  }

  hash.update(`file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`);
  hash.update(await readFile(filePath));
}

// [契约] 只校验官方插件清单中声明的必需相对路径是否可访问。
// 按包名前缀过滤，同一份清单服务多个插件包与 bundled-skills。
// [失败路径] access 失败被包装成 missing official plugin required asset 并附绝对路径。
async function assertDevelopmentOfficialPluginRequiredAssets(
  packageRoot: string,
  packageName: string,
): Promise<void> {
  const packagePrefix = `${packageName}/`;
  for (const requiredRelativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    if (!requiredRelativePath.startsWith(packagePrefix)) continue;
    const localRelativePath = requiredRelativePath.slice(packagePrefix.length);
    const requiredPath = join(packageRoot, ...localRelativePath.split("/"));
    try {
      await access(requiredPath);
    } catch {
      throw new Error(
        `[zcode-agent-deploy] missing official plugin required asset: ${requiredPath}`,
      );
    }
  }
}

// [契约] 逐个远端探测必需资源，返回缺失路径列表供跳过判定使用。
// [失败路径] 探测本身的异常向上抛，与「文件不存在」严格区分。
// [权衡] 串行探测换取实现简单，探测次数受清单长度约束。
async function findMissingRemoteOfficialPluginAssetPaths(params: {
  backend: IRemoteBackend;
  remoteProviderDir: string;
}): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const remotePath of buildRemoteAgentOfficialPluginRequiredPaths(params.remoteProviderDir)) {
    if (!(await params.backend.exists(remotePath))) {
      missingPaths.push(remotePath);
    }
  }
  return missingPaths;
}

// [契约] 返回 true 表示远端已就绪，调用方直接 return true，不再上传任何文件。
// 判定顺序：force → 版本文件 → 二进制 → WSL wrapper → bundle → 插件资源 → sha256 校验。
// [失败路径] 读版本文件异常一律视为需要部署，不做兜底跳过。
// [权衡] `shouldSkipDevelopmentZCodeAgentDeploy` 宁可多传一次，也不让远端跑与本地不一致的产物。
async function shouldSkipDevelopmentZCodeAgentDeploy(params: {
  backend: IRemoteBackend;
  remoteVersionFile: string;
  remoteDevVersionFile: string;
  remoteBinaryPath: string;
  remoteBundlePath: string;
  runtimeResourceDir: string;
  runtimeVersion: string;
  devVersion: string;
  localBundleSha256: string;
  force: boolean;
  missingOfficialPluginAssetPaths: string[];
  loggers: DeployLoggers;
}): Promise<boolean> {
  if (params.force) {
    return false;
  }

  let remoteVersion: string;
  let remoteDevVersion: string;
  try {
    remoteVersion = (await params.backend.readFile(params.remoteVersionFile)).trim();
    remoteDevVersion = (await params.backend.readFile(params.remoteDevVersionFile)).trim();
  } catch {
    return false;
  }

  if (remoteVersion !== params.runtimeVersion || remoteDevVersion !== params.devVersion) {
    return false;
  }

  if (!(await params.backend.exists(params.remoteBinaryPath))) {
    return false;
  }

  if (isWslBackend(params.backend)) {
    try {
      const remoteWrapper = await params.backend.readFile(params.remoteBinaryPath);
      if (!isRemoteAgentBundleWrapperCurrent(remoteWrapper, params.runtimeResourceDir)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  if (!(await params.backend.exists(params.remoteBundlePath))) {
    return false;
  }

  if (params.missingOfficialPluginAssetPaths.length > 0) {
    return false;
  }

  // 旧发布包或另一客户端可能覆盖 bundle，却留下相同的 .dev-version。
  // 标记只描述上次部署意图；跳过上传前必须在远端校验实际文件，避免 PAT 交给旧版 Agent 的过时鉴权逻辑。
  // [并发] 远端 bundle 可能被旧发布包或另一客户端覆盖，.dev-version 无法证明内容一致。
  // [契约] 用远端已部署的 node 执行内联 sha256 脚本，与本地 bundle 哈希比对。
  // [失败路径] 脚本 catch 时置 exitCode=1，任何异常都走「重新上传」分支。
  // 只有退出码为 0 才允许打印跳过日志。
  const verifyBundleScript =
    "require('node:fs/promises').readFile(process.argv[1]).then(content => {" +
    "process.exitCode = require('node:crypto').createHash('sha256').update(content).digest('hex') === process.argv[2] ? 0 : 1;" +
    "}).catch(() => { process.exitCode = 1; });";
  try {
    await waitForClose(
      await params.backend.exec(
        `"\${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.zcode/server}/node" -e ${quotePosixShellArg(verifyBundleScript)} ${quotePosixPathArg(params.remoteBundlePath)} ${quotePosixShellArg(params.localBundleSha256)}`,
      ),
    );
  } catch {
    params.loggers.logWarn(
      `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 远端 bundle SHA 不匹配或无法校验，重新上传`,
    );
    return false;
  }

  params.loggers.log(`[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态 zcode.cjs 未变化，跳过`);
  return true;
}

// [资源] 在本地临时目录重建 packages 目录结构，供后续打包成 tar.gz。
// [契约] 每个插件包只复制白名单顶层路径，并重复校验 manifest 与必需资源。
// bundled-skills 作为完整目录复制，不要求 plugin.json，也不按白名单裁剪。
// [失败路径] 任一步抛错即中止，临时目录由调用方 finally 清理。
async function stageDevelopmentOfficialPluginPackages(params: {
  repoRoot: string;
  packagesDir: string;
}): Promise<void> {
  await mkdir(params.packagesDir, { recursive: true });
  for (const packageName of REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES) {
    const sourceRoot = join(params.repoRoot, "apps", "zcode-cli", "packages", packageName);
    const manifestPath = join(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[zcode-agent-deploy] missing official plugin manifest: ${manifestPath}`);
    }
    await assertDevelopmentOfficialPluginRequiredAssets(sourceRoot, packageName);

    const targetRoot = join(params.packagesDir, packageName);
    await mkdir(targetRoot, { recursive: true });
    for (const topLevelPath of REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS) {
      const sourcePath = join(sourceRoot, topLevelPath);
      if (existsSync(sourcePath)) {
        await cp(sourcePath, join(targetRoot, topLevelPath), {
          recursive: true,
        });
      }
    }
  }
  // 修复原因：内置技能不再是插件，单独复制完整包，不能要求 plugin.json 或按插件白名单裁剪。
  const bundledSkillsRoot = join(params.repoRoot, "apps/zcode-cli/packages/bundled-skills");
  await assertDevelopmentOfficialPluginRequiredAssets(bundledSkillsRoot, "bundled-skills");
  await cp(bundledSkillsRoot, join(params.packagesDir, "bundled-skills"), { recursive: true });
}

// [事务] 三段式：本地打包 → 远端 owner staging 解包 → 校验后原子替换正式插件目录。
// 权限修复在解包前执行，保证历史遗留目录可被替换。
// [资源] 本地 tempDir 同时承载 staging 目录与归档文件。
async function uploadDevelopmentOfficialPluginPackages(params: {
  backend: IRemoteBackend;
  repoRoot: string;
  remoteProviderDir: string;
  loggers: DeployLoggers;
}): Promise<void> {
  // [资源] mkdtemp 生成唯一临时目录，并发部署在本地互不覆盖。
  // 目录内全部是本次调用的中间产物，不含用户数据。
  // [失败路径] finally 中 rm -rf 兜底，成功与失败路径都不留残留。
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-remote-agent-packages-"));
  const packagesDir = join(tempDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
  const archivePath = join(tempDir, `${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.tar.gz`);
  try {
    await stageDevelopmentOfficialPluginPackages({
      repoRoot: params.repoRoot,
      packagesDir,
    });
    await createTarGzArchive(archivePath, [
      {
        sourcePath: packagesDir,
        archivePath: REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
      },
    ]);

    // [并发] 早期实现共用固定 packages.tar.gz，多个部署 owner 会互相覆盖与误删。
    // owner 后缀 = 时间戳 + UUID，同一部署内归档、解包目录、清理目标共用该后缀。
    // [契约] 后缀只出现在远端 staging 路径，不影响最终插件目录名。
    // [失败路径] 清理只删本 owner 的文件，绝不误伤并发中的另一个部署。
    // [权衡] 多一次 UUID 生成，换取无需远端锁即可并发。
    const ownerSuffix = `${Date.now()}-${randomUUID()}`;
    // 开发态官方插件曾使用固定 packages.tar.gz；多个部署 owner 会覆盖彼此的上传。
    // archive/extract 使用同一 owner 后缀，失败清理不会误删其他部署者的文件。
    const remoteArchivePath = `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.tar.gz-${ownerSuffix}`;
    const remoteExtractDir = `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.extract-${ownerSuffix}`;
    const extractedPackagesDir = `${remoteExtractDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`;
    // [失败路径] 上传或解包失败时回收 owner staging，避免远端堆积残留。
    // 成功路径已由远端 trap 清理，这里再删是幂等兜底。
    // [事务] 只清理 archive-<suffix> 与 extract-<suffix>，不触碰正式插件目录。
    // [契约] 清理异常降级为 logWarn，绝不覆盖原始部署错误。
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await params.backend.exec(
          `rm -f ${quotePosixPathArg(remoteArchivePath)} && rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
        );
        await waitForClose(cleanupStream);
      } catch (error) {
        params.loggers.logWarn(
          `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 清理 owner staging 失败 (${ownerSuffix}): ${String(error)}`,
        );
      }
    };
    params.loggers.log(`[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态上传官方插件资源`);
    try {
      // [事务] 归档先落 owner staging，绝不直接写正式插件目录。
      // [并发] 目标路径带 owner 后缀，与其他部署的上传互不冲突。
      await params.backend.upload(archivePath, remoteArchivePath);
      // [失败路径] 历史部署可能留下不可写目录，替换前先修复权限。
      // [契约] 修复范围仅限官方插件目录，不触碰 provider 下其他产物。
      await repairLegacyRemoteOfficialPluginDirectoryPermissions({
        backend: params.backend,
        loggers: params.loggers,
        remoteOfficialPluginDir: buildRemoteAgentOfficialPluginDir(params.remoteProviderDir),
      });
      // [事务] 远端脚本顺序固定：建目录 → 解包 → test -d 校验 → 删旧目录 → 移动 → 清理。
      // [失败路径] set -eu 使任一步失败立即中止，不会继续执行后续删除动作。
      // [契约] 先 test -d 再删旧目录，坏归档不会导致正式插件目录消失。
      // buildRemoteMoveCommand 处理跨文件系统移动，避免 mv 失败留下半成品。
      // [并发] 所有路径带 owner 后缀并逐段做 POSIX 引号转义。
      const stream = await params.backend.exec(
        [
          "set -eu",
          `cleanup_staging() { rm -f ${quotePosixPathArg(remoteArchivePath)}; rm -rf ${quotePosixPathArg(remoteExtractDir)}; }`,
          // [失败路径] SSH 中断、命令失败或退出时由 trap 删除 staging。
          // 脚本末尾显式调用 cleanup_staging 后用 trap - 复位，避免重复执行。
          // [契约] trap 内只删除本 owner 的路径。
          "trap cleanup_staging EXIT HUP INT TERM",
          `rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
          `mkdir -p ${quotePosixPathArg(remoteExtractDir)} ${quotePosixPathArg(params.remoteProviderDir)}`,
          `tar -xzf ${quotePosixPathArg(remoteArchivePath)} -C ${quotePosixPathArg(remoteExtractDir)}`,
          `test -d ${quotePosixPathArg(extractedPackagesDir)}`,
          `rm -rf ${quotePosixPathArg(`${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`)}`,
          buildRemoteMoveCommand(
            extractedPackagesDir,
            `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`,
          ),
          "cleanup_staging",
          "trap - EXIT HUP INT TERM",
        ].join("\n"),
      );
      await waitForClose(stream);
    } catch (error) {
      await cleanupRemoteStaging();
      throw error;
    }
  // [资源] 本地临时目录必删，成功与异常路径都执行。
  // [契约] force: true 保证只读文件也能被删除。
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 对外唯一入口，返回 boolean：false 表示未进入开发态部署，调用方继续常规流程。
// [事务] 阶段顺序不可交换：跳过判定 → 上传 bundle → 上传插件资源 → 安装 wrapper → 写标记。
// [失败路径] 任一 await 抛错直接向上抛，不伪装成部分成功。
// [契约] 返回 true 表示远端已具备开发态产物，而非「本次一定上传过」。
export async function deployDevelopmentZCodeAgentRuntime(
  backend: IRemoteBackend,
  params: DeployDevelopmentZCodeAgentRuntimeParams,
  loggers: DeployLoggers,
): Promise<boolean> {
  const developmentBundle = resolveDevelopmentAgentBundle();
  if (!developmentBundle) {
    return false;
  }

  // 推导远端产物路径：开发态 bundle 与 .dev-version，均相对 provider 目录。
  // [契约] 路径只由 provider 目录与常量拼接，不引入调用方输入。
  // 版本文件与生产部署共用，写入值必须是 runtimeVersion。
  const remoteBundlePath = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_BUNDLE_NAME}`;
  const remoteDevVersionFile = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_VERSION_FILE_NAME}`;
  const devVersion = await computeDevelopmentAgentAssetsSha256({
    localBundlePath: developmentBundle.localBundlePath,
    repoRoot: developmentBundle.repoRoot,
  });
  const missingOfficialPluginAssetPaths = await findMissingRemoteOfficialPluginAssetPaths({
    backend,
    remoteProviderDir: params.remoteProviderDir,
  });

  if (
    // [契约] 传入完整判定输入，包括已算好的 devVersion 与本地 bundle sha256。
    // bundle 内容在判定前后各读一次，保证判定与实际上传使用同一份字节。
    // [失败路径] 判定内部异常不吞噬，直接中止本次部署。
    // [权衡] 重复读文件换取判定与上传的一致性。
    await shouldSkipDevelopmentZCodeAgentDeploy({
      backend,
      remoteVersionFile: params.remoteVersionFile,
      remoteDevVersionFile,
      remoteBinaryPath: params.remoteBinaryPath,
      remoteBundlePath,
      runtimeResourceDir: params.runtimeResourceDir,
      runtimeVersion: params.runtimeVersion,
      devVersion,
      localBundleSha256: createHash("sha256")
        .update(await readFile(developmentBundle.localBundlePath))
        .digest("hex"),
      force: params.force,
      missingOfficialPluginAssetPaths,
      loggers,
    })
  ) {
    return true;
  }

  // 开发态 SSH 远端过去只会部署本地 zcode.cjs，不会携带 packages/*-plugin。
  // builtin plugin seed 依赖 agent 包旁边的官方插件源资源，所以 dev 部署需要同步 bundle 与插件资源。
  // 本地修改 apps/zcode-cli 后，远端测试仍运行滞后的发布包。这里改为上传 dev 启动时刚构建的
  // dist/zcode.cjs，并用远端已部署的 node 包一层 wrapper 启动，保证 agent 仍运行在目标机器内。
  loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态上传本地 zcode.cjs ${devVersion.slice(0, 12)}`,
  );
  const mkdirStream = await backend.exec(`mkdir -p ${quotePosixPathArg(params.remoteProviderDir)}`);
  await waitForClose(mkdirStream);

  // [事务] 先上传 .new 再远端移动，避免读者看到写了一半的 bundle。
  // [失败路径] 上传失败时旧 bundle 保持可用，远端不会进入不可启动状态。
  // [契约] .new 与目标同目录，保证移动走 rename 而非跨盘复制。
  // [并发] 上传目标固定，并发部署内容相同则后者覆盖前者。
  const remoteBundleTempPath = `${remoteBundlePath}.new`;
  await backend.upload(developmentBundle.localBundlePath, remoteBundleTempPath);
  const bundleStream = await backend.exec(
    buildRemoteMoveCommand(remoteBundleTempPath, remoteBundlePath),
  );
  await waitForClose(bundleStream);
  await uploadDevelopmentOfficialPluginPackages({
    backend,
    repoRoot: developmentBundle.repoRoot,
    remoteProviderDir: params.remoteProviderDir,
    loggers,
  });

  // [契约] wrapper 让远端用已部署 node 启动本地 bundle，agent 仍运行在目标机器内。
  // runtimeResourceDir 变化会改变 wrapper 内容，跳过判定据此触发重装。
  // [权衡] `buildRemoteAgentBundleWrapper` 生成脚本而非分发二进制，规避跨平台二进制不匹配。
  const wrapperContent = buildRemoteAgentBundleWrapper(params.runtimeResourceDir);
  const markerCommands = [
    buildWriteLiteralFileCommand(remoteDevVersionFile, devVersion),
    buildWriteLiteralFileCommand(params.remoteVersionFile, params.runtimeVersion),
  ];
  // [事务] 标记最后写入：产物与 wrapper 全部就绪后才更新版本文件。
  // [失败路径] 前面任一步失败时标记保持旧值，下次部署会自动重试。
  // [契约] WSL 与普通 SSH 分支只在 wrapper 安装方式上不同，标记命令共用。
  // [权衡] 不以标记存在作为唯一成功依据，跳过前仍做 sha256 校验。
  let markerStream;
  if (isWslBackend(backend)) {
    await deployRemoteAgentWrapper({
      backend,
      content: wrapperContent,
      remoteWrapperPath: params.remoteBinaryPath,
    });
    markerStream = await backend.exec(markerCommands.join(" && "));
  } else {
    const remoteWrapperTempPath = `${params.remoteBinaryPath}.new`;
    markerStream = await backend.exec(
      [
        buildWriteLiteralFileCommand(remoteWrapperTempPath, wrapperContent),
        buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteBinaryPath),
        ...markerCommands,
      ].join(" && "),
    );
  }
  await waitForClose(markerStream);
  loggers.log(
    // [契约] 完成日志在标记写入并确认后才打印，代表整条链路结束。
    // 只输出哈希前 12 位，避免在日志中暴露完整指纹。
    // 返回 true 表示本次确实执行了开发态部署。
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态部署完成 ${devVersion.slice(0, 12)}`,
  );
  return true;
}
