// INV-01 组件选择提前返回。守住位置：进入任何远端探测之前的 selectedResourcePackageIds 判断。改错故障：未选中的组件仍会发起 SSH 探测，并在日志里刷出误导性的「开始部署」。
// INV-02 入口名解析失败必须直接返回。守住位置：runtime.resolveEntrySegments 取末段后的空值分支。改错故障：写成非空断言会拼出 undefined 远端路径，直到远端执行阶段才失败，定位成本极高。
// INV-03 开发态短路优先于制品身份判定。守住位置：deployDevelopmentZCodeAgentRuntime 返回真即提前结束。改错故障：继续走生产安装会用发布制品覆盖开发态 runtime，本地调试行为被静默改变。
// INV-04 manifest SHA 读取失败只降级不中断。守住位置：只包住 resolveComponentSha256 的最小捕获范围。改错故障：异常上抛会让 manifest 临时抖动升级为整条远端连接失败。
// INV-05 跳过判定只认 SHA，不认语义版本。守住位置：shouldSkipZCodeAgentDeploy 的身份入参。改错故障：改用 runtime.version 会把「版本没变但制品变了」误判为已部署，远端长期停在旧包。
// INV-06 force 必须先短路。守住位置：shouldSkip 函数体的第一个分支。改错故障：force 仍去读远端状态，会在远端不可达或 marker 损坏时被跳过，用户点了重装却没装。
// INV-07 WSL 的 wrapper 内容校验带后端条件。守住位置：isWslBackend 包住 readFile 比对。改错故障：对非 WSL 后端也读文件会多一次远端 IO，并把编码差异误判成 stale。
// INV-08 wrapper 存在不等于部署完整。守住位置：remoteBundlePath 的 exists 分支。改错故障：只看 wrapper 会保留旧原生二进制残留，运行时缺 zcode.cjs 却在启动时才报错。
// INV-09 官方插件资源缺失即重部署。守住位置：missingOfficialPluginAssetPaths 非空判定。改错故障：忽略缺失会让远端 bootstrap 找不到内建插件，agent 起来即降级。
// INV-10 默认安装顺序不可调换。守住位置：permissionRepairSucceeded 为真时的 bundle 再 plugin。改错故障：反过来会让插件资源落在旧 packages 上，出现版本错配。
// INV-11 权限修复失败时反转安装顺序。守住位置：else 分支先装 plugin 再装 bundle。改错故障：仍先装 bundle 会在旧目录删除失败时留下半新半旧的混合状态，且更难回滚。
// INV-12 wrapper 必须最后写入。守住位置：deployRemoteAgentWrapper 位于资源安装之后。改错故障：先写 wrapper 会让远端在资源未就绪时就被判定为可执行，探测与实态不一致。
// INV-13 强制刷新只由 options.force 决定。守住位置：forceRefreshRuntimeAsset 的取值来源。改错故障：把 plugin 缺失当成制品变更，会让同版本重复下载整包，放大带宽与耗时。
// INV-14 版本文件写入后必须等待流关闭。守住位置：waitForClose 对 versionStream 的等待。改错故障：不等就继续会与 live marker 写入竞争，留下被截断的 .version。
// INV-15 live marker 只在有 SHA 时写。守住位置：expectedArtifactSha256 的真值判断。改错故障：写入空 SHA 会让下一次连接永远判定需要重部署，跳过判定彻底失效。
// INV-16 制品身份包含 platformArch。守住位置：writeRemoteAssetComponentMeta 的 platformArch 字段。改错故障：擦除该维度会让 arm64 与 x64 共用同一 marker 并互相覆盖判定结论。
// INV-17 失败即抛出不就地吞掉。守住位置：install、wrapper、exec 三个 await 点均无本地 catch。改错故障：静默吞异常会让上层误认为部署成功，问题推迟到启动阶段才暴露。
// INV-18 版本文件用 literal 命令写入。守住位置：buildWriteLiteralFileCommand 的使用点。改错故障：手工拼命令会让含特殊字符的版本被远端 shell 展开或截断。
//
// 模块职责：把 ZCode Agent runtime 的 wrapper、zcode.cjs bundle 与官方插件资源落到远端，并依据制品 SHA 与 live marker 决定是否跳过。
// 状态所有权：远端目录布局与 .version 由本模块写；制品身份（SHA 与 platformArch）由 remoteAssetLiveIdentity 的 live marker 承载；installer 只负责取制品与落盘。
// 阅读顺序：先看 deployZCodeAgentRuntime 的早返回，再看 shouldSkipZCodeAgentDeploy 的判定链，最后看安装顺序与 marker 写入。
import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_AGENT_PROVIDER,
  type RemoteResourcePackageId,
} from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import type { RemoteAssetInstaller } from "@zcode/server/remote/remoteAssetInstaller.js";
import { buildWriteLiteralFileCommand } from "@zcode/server/remote/posixShell.js";
import { deployDevelopmentZCodeAgentRuntime } from "@zcode/server/remote/zcodeAgentDevDeploy.js";
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
  buildRemoteAgentOfficialPluginDir,
  buildRemoteAgentOfficialPluginRequiredPaths,
  buildRemoteAgentOfficialPluginSourceRelativePath,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
} from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";
import { repairLegacyRemoteOfficialPluginDirectoryPermissions } from "@zcode/server/remote/zcodeAgentOfficialPluginPermissionRepair.js";
import {
  checkRemoteAssetComponentIdentity,
  writeRemoteAssetComponentMeta,
} from "@zcode/server/remote/remoteAssetLiveIdentity.js";

// 远端 agent 资源统一挂在 REMOTE_BASE/agents 之下，路径拼接只依赖这一个前缀。
// 改错风险：在调用点各写一段拼接，会让不同后端落到不同目录，跳过判定随之失真。
// 这里只做字符串前缀，不做路径规范化；远端是 POSIX 语义，反斜杠不能当分隔符。
// 目录层级的其余部分由 runtime.bundledResourceDir 提供，避免本文件重复编码版本布局。
// 若前缀被改成带尾斜杠，模板会拼出双斜杠，exists 判定在不同后端上结果不一致。
const REMOTE_AGENT_RUNTIME_BASE = `${REMOTE_BASE}/agents`;

export interface DeployZCodeAgentRuntimeOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  installer: RemoteAssetInstaller;
  selectedResourcePackageIds?: RemoteResourcePackageId[];
  force?: boolean;
}

function isSelectedZCodeAgentComponent(
  componentId: string,
  selectedResourcePackageIds: readonly RemoteResourcePackageId[] | undefined,
): boolean {
  return (
    !selectedResourcePackageIds ||
    selectedResourcePackageIds.includes(componentId as RemoteResourcePackageId)
  );
}

async function shouldSkipZCodeAgentDeploy(params: {
  backend: IRemoteBackend;
  remoteBinaryPath: string;
  remoteBundlePath: string;
  runtimeResourceDir: string;
  expectedArtifactSha256: string | null;
  componentId: string;
  platformArch: string;
  force: boolean;
  missingOfficialPluginAssetPaths: string[];
  installer: RemoteAssetInstaller;
  loggers: DeployLoggers;
}): Promise<boolean> {
  // force 是唯一无条件重装入口：为真时连远端状态都不读，直接进入部署流程。
  // 这样即使远端不可达、marker 损坏或 SHA 相同，强制部署也不会被跳过判定拦下。
  // 改错风险：把 force 判断挪到后面，会让「用户点了重装但没重装」难以复现与归因。
  // 注意 force 同时决定后续的 forceRefreshRuntimeAsset，两者共用同一开关，不能各自取反。
  // 返回 false 的语义是「不要跳过」，与返回 true 必须严格区分，写反会让部署永不发生。
  if (params.force) {
    return false;
  }

  if (!params.expectedArtifactSha256) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=manifest SHA unavailable`,
    );
    return false;
  }

  const identityDecision = await checkRemoteAssetComponentIdentity(params.backend, {
    componentId: params.componentId,
    platformArch: params.platformArch,
    expectedIdentity: { sha256: params.expectedArtifactSha256 },
  });
  if (identityDecision.shouldDeploy) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=${identityDecision.reason}`,
    );
    return false;
  }

  if (!(await params.backend.exists(params.remoteBinaryPath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=remote wrapper missing path=${params.remoteBinaryPath}`,
    );
    return false;
  }

  if (isWslBackend(params.backend)) {
    try {
      const remoteWrapper = await params.backend.readFile(params.remoteBinaryPath);
      if (!isRemoteAgentBundleWrapperCurrent(remoteWrapper, params.runtimeResourceDir)) {
        params.loggers.logWarn(
          `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=wsl wrapper stale path=${params.remoteBinaryPath}`,
        );
        return false;
      }
    } catch {
      return false;
    }
  }

  // wrapper 在、但 zcode.cjs 缺失（被清理 / 旧原生二进制部署残留）时也要重新部署。
  if (!(await params.backend.exists(params.remoteBundlePath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=remote bundle missing path=${params.remoteBundlePath}`,
    );
    return false;
  }

  if (params.missingOfficialPluginAssetPaths.length > 0) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=official plugin assets missing paths=${params.missingOfficialPluginAssetPaths.join(",")}`,
    );
    return false;
  }

  params.loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 制品 SHA ${params.expectedArtifactSha256} 已部署，跳过`,
  );
  return true;
}

// 逐个 exists 探测必需路径，收集缺失清单，而不是遇到第一个缺口就返回。
// [契约] requiredRelativePaths 保留完整清单而非首个缺口：跳过判定处能一次列出所有缺失文件，避免逐个重试。
// 改错风险：改成短路返回会让运维反复重连多次，才能把缺失项补齐。
// 探测发生在部署决策之前，因此这里的远端 IO 次数与必需路径数量线性相关。
// 必需路径由 buildRemoteAgentOfficialPluginRequiredPaths 统一推导，不在本文件硬编码。
async function findMissingRemoteOfficialPluginAssetPaths(
  backend: IRemoteBackend,
  remoteProviderDir: string,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const remotePath of buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir)) {
    if (!(await backend.exists(remotePath))) {
      missingPaths.push(remotePath);
    }
  }
  return missingPaths;
}

/**
 * 部署 ZCode Agent runtime 到远程机器。
 *
 * 生产态只用 manifest SHA 判断制品是否变化；语义版本不参与跳过决策。
 */
// 对外契约：成功返回后远端一定具备可执行 wrapper、zcode.cjs、官方插件资源与 .version。
// 四类提前返回都算成功：未选组件、入口名解析失败、开发态短路、制品身份命中。
// 调用方不需要区分「新装」与「跳过」，日志是唯一可用的区分手段。
// 改错风险：把跳过改成抛错，会让连接流程把正常的幂等命中当成故障处理。
// 任何安装步骤失败都必须向上抛出，由连接层统一提示，不能在这里降级成警告。
export async function deployZCodeAgentRuntime(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployZCodeAgentRuntimeOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const provider = ZCODE_AGENT_PROVIDER;
  const runtime = ZCODE_AGENT_RUNTIME;
  const componentId = provider;
  if (!isSelectedZCodeAgentComponent(componentId, options.selectedResourcePackageIds)) {
    loggers.log(`[zcode-agent-deploy] ${provider}: 未选择资源包 ${componentId}，跳过检查和部署`);
    return;
  }

  // binaryName 指 wrapper 可执行文件名（如 zcode-agent / zcode-agent.exe）——
  // 一个调用远端 node 执行 zcode.cjs 的壳脚本。
  const binaryName = runtime.resolveEntrySegments(env.platform).at(-1);
  if (!binaryName) {
    loggers.logWarn(`[zcode-agent-deploy] ${provider}: 无法解析 agent 入口名称，跳过部署`);
    return;
  }

  // 这里一次性推导远端全部落点：版本文件、wrapper、bundle 与插件目录。
  // 后续安装与探测都复用这些变量，避免同一条路径被拼出两种写法。
  // 改错风险：某个调用点自行拼路径，会让写入位置与校验位置错开，跳过永远不命中。
  // 插件目录与 bundle 同属 provider 目录，清理或迁移时只需移动一个根。
  // 缺失清单必须在本轮部署前取快照；部署中途再探测会得到与实态不符的结论。
  const remoteProviderDir = `${REMOTE_AGENT_RUNTIME_BASE}/${runtime.bundledResourceDir}`;
  const remoteVersionFile = `${remoteProviderDir}/.version`;
  const remoteBinaryPath = `${remoteProviderDir}/${binaryName}`;
  const remoteBundlePath = `${remoteProviderDir}/${REMOTE_AGENT_BUNDLE_NAME}`;
  const remoteOfficialPluginDir = buildRemoteAgentOfficialPluginDir(remoteProviderDir);
  const missingOfficialPluginAssetPaths = await findMissingRemoteOfficialPluginAssetPaths(
    backend,
    remoteProviderDir,
  );

  if (
    await deployDevelopmentZCodeAgentRuntime(
      backend,
      {
        runtimeVersion: runtime.version,
        runtimeResourceDir: runtime.bundledResourceDir,
        remoteProviderDir,
        remoteVersionFile,
        remoteBinaryPath,
        force: Boolean(options.force),
      },
      loggers,
    )
  ) {
    return;
  }

  // SHA 解析失败只降级为 null，打一条 warn 后继续部署，不阻断连接。
  // null 的语义是「身份未知」，会同时导致不跳过、也不写 live marker 两个后果。
  // 改错风险：把 null 当成空字符串传入身份校验，会让每次连接都判定制品已变化。
  // 这里的 try 只包住 manifest 读取，不覆盖后续部署步骤，异常边界保持最小。
  // 只有强制刷新时才会重新取包，正常修复路径复用已校验的组件 cache。
  let expectedArtifactSha256: string | null = null;
  try {
    expectedArtifactSha256 =
      (await options.installer.resolveComponentSha256?.(componentId)) ?? null;
  } catch (error) {
    loggers.logWarn(
      `[zcode-agent-deploy] ${provider}: 读取 manifest SHA 失败，将重新部署: ${String(error)}`,
    );
  }

  if (
    await shouldSkipZCodeAgentDeploy({
      backend,
      remoteBinaryPath,
      remoteBundlePath,
      runtimeResourceDir: runtime.bundledResourceDir,
      expectedArtifactSha256,
      componentId,
      platformArch: options.platformArch,
      force: Boolean(options.force),
      missingOfficialPluginAssetPaths,
      installer: options.installer,
      loggers,
    })
  ) {
    return;
  }

  loggers.log(`[zcode-agent-deploy] ${provider}: 开始部署 v${runtime.version}...`);
  // 缺少远端 plugin 只表示安装不完整，不等于 App 版本变化。
  // 同 App 版本修复 plugin 时应复用已校验的组件 cache；只有强制部署边界才重新下载制品。
  const forceRefreshRuntimeAsset = Boolean(options.force);
  const permissionRepairSucceeded = await repairLegacyRemoteOfficialPluginDirectoryPermissions({
    backend,
    loggers,
    remoteOfficialPluginDir,
  });
  const installBundle = () =>
    options.installer.installFile({
      componentId,
      sourceRelativePath: `${runtime.bundledResourceDir}/${options.platformArch}/${REMOTE_AGENT_BUNDLE_NAME}`,
      remotePath: remoteBundlePath,
      executable: false,
      forceRefresh: forceRefreshRuntimeAsset,
    });
  const installOfficialPluginPackages = () =>
    options.installer.installDirectory({
      componentId,
      sourceRelativePath: buildRemoteAgentOfficialPluginSourceRelativePath({
        runtimeResourceDir: runtime.bundledResourceDir,
        platformArch: options.platformArch,
      }),
      remoteDir: remoteOfficialPluginDir,
      requiredRelativePaths: [...REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS],
      forceRefresh: forceRefreshRuntimeAsset,
    });

  // 权限修复成功才走「先 bundle 后 plugin」的健康路径，保持既有 SSH、Docker、WSL 时序。
  // 修复失败时目录可能不可替换，因此先验证 plugin 目录可替换，再更新 bundle。
  // 改错风险：两条分支合并成一条，会让旧 packages 删除失败时远端停在半更新状态。
  // 两条分支的最终产物必须完全一致，差异只在写入顺序；新增步骤要同时加到两边。
  // 顺序差异只服务于失败恢复，不代表两种部署模式，日志不应据此区分后端类型。
  if (permissionRepairSucceeded) {
    // 1) 正常路径保持原部署顺序，避免改变健康 SSH / Docker / WSL 的时序语义。
    await installBundle();
    // 2) 安装随 agent bundle 发布的官方插件源资源，供远端 agent bootstrap seed builtin plugin。
    await installOfficialPluginPackages();
  } else {
    // 1) chmod 失败时先验证 packages 可替换，避免 bundle 已更新但旧 packages 删除失败。
    await installOfficialPluginPackages();
    // 2) packages 替换成功后再安装编译产物 zcode.cjs（跨平台同一份，glm 组件里就是它）。
    await installBundle();
  }
  // 3) 写入 wrapper（即 resolver 期望的 zcode-agent），用远端已部署的 node 执行 zcode.cjs。
  await deployRemoteAgentWrapper({
    backend,
    content: buildRemoteAgentBundleWrapper(runtime.bundledResourceDir),
    remoteWrapperPath: remoteBinaryPath,
  });

  // 版本文件通过 literal 写入命令落盘，避免版本串被远端 shell 解释。
  // 必须等到流关闭才算写完，否则 live marker 可能与仍在写入的版本文件竞争。
  // 改错风险：不等待就返回，清理阶段可能在流未结束时删除临时文件，留下截断内容。
  // 版本文件供人查看，真正参与跳过判定的是 live marker 中的 SHA 与 platformArch。
  // 因此版本写入失败不能视为部署成功的充分条件，异常仍需继续上抛。
  const versionStream = await backend.exec(
    buildWriteLiteralFileCommand(remoteVersionFile, runtime.version),
  );
  await waitForClose(versionStream);
  if (expectedArtifactSha256) {
    // GLM 的语义版本可能不变但制品内容已更新，必须把 manifest SHA
    // 写入远端 live marker，下一次连接才能按真实制品身份决定是否重部署。
    await writeRemoteAssetComponentMeta(backend, {
      id: componentId,
      version: runtime.version,
      sha256: expectedArtifactSha256,
      platformArch: options.platformArch,
    });
  }
  loggers.log(`[zcode-agent-deploy] ${provider}: 部署完成 v${runtime.version}`);
}
