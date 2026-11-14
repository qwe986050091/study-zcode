// 远程 workspace 历史条目的手动重连编排：身份解析、凭据重取、连接、绑定、落库。
// 仅消费 Host 返回的权威 scope，不在 Renderer 侧自行推导 workspaceIdentity。
// 失败必须落库为 failed 并回收资源，成功后才可以激活 tab 与提交历史。
// INV-01 身份键统一取 identity 去空格后回退 path；守住位置：reconnectWorkspaceKey 计算；改错故障：同一远端出现两条重连进度或去重失效导致 tab 重复。
// INV-02 重连进度键必须在 finally 中按值移除而非整体清空；守住位置：setReconnectingRemoteWorkspaceKeys 收尾；改错故障：并行重连的其他条目进度被抹掉，按钮提前恢复可点。
// INV-03 进入重连先登记进度键，重复登记时返回原数组引用；守住位置：setReconnectingRemoteWorkspaceKeys 头部；改错故障：每次渲染产生新数组，订阅方无限重渲染。
// INV-04 目标快照与凭据必须来自同一份配置来源；守住位置：resolveSshReconnectSnapshot 与凭据加载；改错故障：编辑线路后连回旧端口，Host 注册出第二条 Profile。
// INV-05 历史快照按 path 与 identity 双键匹配，缺一不可；守住位置：sourceServerWorkspaceHistory 查找；改错故障：同名不同身份的远端互相串用地址与凭据。
// INV-06 仅当 Profile 无凭据引用且私钥路径未变时继承旧引用；守住位置：resolveSshReconnectSnapshot 尾部分支；改错故障：换私钥后仍用旧口令，认证失败且无法定位原因。
// INV-07 非 ssh 目标的快照原样透传，不做字段重写；守住位置：resolveSshReconnectSnapshot 早退；改错故障：server 目标被误清 token 引用，重连必然鉴权失败。
// INV-08 共享 Host 凭据由 options 覆盖优先，不得再各自读取历史凭据；守住位置：sshCredentials 构造；改错故障：sibling 重复读取凭据，SSH 侧出现并发认证竞争。
// INV-09 凭据缺失必须抛出结构化 credentials-required 而非静默降级；守住位置：requireStoredCredentials 校验；改错故障：无凭据直接连接，用户只看到泛化失败而无交接向导。
// INV-10 目录不可用错误只放行 sibling 共用凭据，不吞掉本条目失败；守住位置：connectRemoteWorkspaceTarget 的 catch；改错故障：项目被删被当作 SSH 故障，所有 sibling 一起失败。
// INV-11 Host ready 必须在 connect 成功后通知一次，且与 workspace 初始化解耦；守住位置：onSshHostReady 调用点；改错故障：sibling 等待整轮初始化才附着，重连耗时线性叠加。
// INV-12 canonical path 必须取 Host 解析结果回填，不用本地路径猜测；守住位置：resolveRemoteWorkspaceCanonicalPath 调用；改错故障：symlink 或大小写差异导致绑定到错误 workspace。
// INV-13 先完成 Host bind 再读取权威 scope，顺序不可颠倒；守住位置：bindRemoteWorkspaceScope 调用；改错故障：手机远控桥接按三元比对失配并拒绝连接。
// INV-14 bind 与保留校验、upsertWorkspaceTab 之间不得插入 await；守住位置：bind 之后到 upsert 的直线段；改错故障：用户等待期间移除的 tab 被过期结果重新加回。
// INV-15 保留校验失败必须回收 session 并直接返回，不落库 connected；守住位置：shouldKeepReconnectedWorkspace 分支；改错故障：留下无 tab 的僵尸远程会话，占用 Host 连接名额。
// INV-16 失败路径必须写入 lastConnectionError 且不刷新 openedAt；守住位置：catch 中的 mutation 构造；改错故障：历史排序被失败重连污染，用户找不到最近使用的项目。
// INV-17 失败是否上抛由 throwOnFailure 决定，toast 与落库不依赖该开关；守住位置：catch 尾部；改错故障：手机端 RPC 无法感知失败，界面停在假连接态。
// INV-18 tab 元数据必须在激活前回填 remoteSessionId，激活顺序不可提前；守住位置：activateWorkspaceAfterReconnect 分支；改错故障：conversation provider 返回 null，右侧整块黑屏。
import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BindRemoteWorkspaceSessionContextResult,
  ConnectionProfile,
  IPlatformService,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import {
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  createRemoteTargetFromSnapshot,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { shouldShowStandaloneRemoteErrorToast } from "@/lib/remoteConnectionPresentation.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
} from "@/store/remoteWorkspaceSessionStore.js";

type ManualReconnectRemoteWorkspaceParams = {
  sessionEntry: RemoteWorkspaceSessionEntry;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  getSettings?: IServiceAccessor["settingService"]["get"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<
    Pick<BindRemoteWorkspaceSessionContextResult, "workspacePath" | "workspaceIdentity">
  >;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspacePath: typeof bindRemoteWorkspacePath;
  bindRemoteWorkspaceIdentity: typeof bindRemoteWorkspaceIdentity;
  upsertWorkspaceTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  logger: Pick<typeof logger, "warn">;
  toast: typeof toast;
  shouldKeepReconnectedWorkspace?: (
    context: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
  }) => void;
  formatError?: (error: unknown) => string;
  options?: ReconnectRemoteWorkspaceOptions;
};

export interface SshReconnectCredentials {
  password: string | null;
  privateKeyPassphrase: string | null;
}

export interface ReconnectRemoteWorkspaceOptions {
  /** 用户原地重连先检查已有凭据，缺失交接向导；自动恢复保留 Host admission。 */
  requireStoredCredentials?: boolean;
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  requestId?: string;
  throwOnFailure?: boolean;
  recoveryMode?: "automatic" | "manual";
  /** 共享 Host ready 后，sibling 复用 initiator 凭据附着，禁止再次读取各自历史凭据。 */
  sshCredentialsOverride?: SshReconnectCredentials;
  /** logical connect 已返回，表示共享 SSH Host ready；workspace 初始化仍可能继续或失败。 */
  onSshHostReady?: (credentials: SshReconnectCredentials) => void;
}

// 凭据读取的唯一入口：仅 ssh 目标有凭据语义，其余目标返回空值免去上层分支判断。
// 未配置任何凭据引用时返回显式空对象，与读取失败区分，调用方据此决定是否要求重填。
export async function loadConnectionProfileCredentials(params: {
  profile: ConnectionProfile;
  loadCredential: IServiceAccessor["credentialService"]["load"];
}): Promise<SshReconnectCredentials | null> {
  if (params.profile.target.kind !== "ssh") return null;
  const target = params.profile.target;
  if (!target.passwordCredentialKey && !target.privateKeyPassphraseCredentialKey) {
    return { password: null, privateKeyPassphrase: null };
  }
  return {
    password: target.passwordCredentialKey
      ? await params.loadCredential(target.passwordCredentialKey)
      : null,
    privateKeyPassphrase: target.privateKeyPassphraseCredentialKey
      ? await params.loadCredential(target.privateKeyPassphraseCredentialKey)
      : null,
  };
}

// 输入是历史条目与 settings 快照，输出可直接用于连接的目标快照，全程不做 IO。
// 查找历史先按 path 再按 identity 收敛，二者都相等才认为是同一条远端记录。
// 找不到历史或 Profile 已删除时回退到条目自带 target，保证旧记录仍可尝试重连。
function resolveSshReconnectSnapshot(params: {
  sessionEntry: RemoteWorkspaceSessionEntry;
  settings?: Pick<AppSettings, "connectionProfiles" | "sourceServerWorkspaceHistory">;
}): RemoteTargetSnapshot {
  const previous = params.sessionEntry.target;
  if (previous.kind !== "ssh") return previous;
  const history = params.settings?.sourceServerWorkspaceHistory?.find(
    (entry) =>
      entry.workspacePath === params.sessionEntry.workspacePath &&
      entry.workspaceIdentity === params.sessionEntry.workspaceIdentity,
  );
  if (!history) return previous;
  const profile = params.settings?.connectionProfiles?.find(
    (candidate) => candidate.profileId === history.profileId && candidate.target.kind === "ssh",
  );
  if (!profile || profile.target.kind !== "ssh") return previous;
  const target = profile.target;
  // 旧历史可能只有 session 凭据引用；仅相同认证配置且 Profile 没有新引用时兼容。
  // 更换私钥后不能把旧密码/口令带给新密钥，也不能把旧口令引用误判成仍需凭据。
  if (
    !target.passwordCredentialKey &&
    !target.privateKeyPassphraseCredentialKey &&
    target.privateKeyPath === previous.privateKeyPath
  ) {
    return {
      ...target,
      passwordCredentialKey: previous.passwordCredentialKey,
      privateKeyPassphraseCredentialKey: previous.privateKeyPassphraseCredentialKey,
    };
  }
  return target;
}

// 编排顺序固定：取配置、取凭据、连接、解析路径、绑定 scope、记保留、写 tab、激活、落库。
// 每一步的失败都汇聚到同一个 catch，由它统一写失败状态、提示与是否上抛。
// 进度键与激活开关等选项在函数入口一次求值，回调内不再重新读取 options。
export async function reconnectRemoteWorkspaceHistoryEntry({
  sessionEntry,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  getSettings,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  bindRemoteWorkspaceScope,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  upsertWorkspaceTab,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  logger,
  toast,
  shouldKeepReconnectedWorkspace,
  onWorkspaceActivated,
  formatError,
  options,
}: ManualReconnectRemoteWorkspaceParams): Promise<void> {
  const activateWorkspaceAfterReconnect = options?.activateWorkspaceAfterReconnect ?? true;
  const showErrorToast = options?.showErrorToast ?? true;
  const fallbackWorkspaceIdentity = resolveRemoteWorkspaceSessionIdentity(sessionEntry);
  // 身份键格式与全仓一致：先去空格，空串时退回路径，避免空 identity 与路径键冲突。
  // 同一远端在连接期间只允许一个进度键，重复点击不会产生第二次连接请求。
  // 该键同时用于登记与移除，两处必须复用同一变量，不能各自重新计算。
  const reconnectWorkspaceKey = fallbackWorkspaceIdentity?.trim() || sessionEntry.workspacePath;

  // 采用函数式更新读取最新数组，避免闭包捕获旧值覆盖并发加入的其他进度键。
  // 已存在时返回原引用，让订阅方按引用相等跳过重渲染，削减重连期间的重绘次数。
  setReconnectingRemoteWorkspaceKeys((currentKeys) =>
    currentKeys.includes(reconnectWorkspaceKey)
      ? currentKeys
      : [...currentKeys, reconnectWorkspaceKey],
  );

  // 先以条目自带 target 去掉密钥类字段作为兜底，确保 catch 分支也能落库一条可用的失败记录。
  // 密钥字段一律置空后再注入已读取的凭据，防止历史快照里的残留引用被带进连接。
  let reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, {
    password: null,
    privateKeyPassphrase: null,
    token: null,
  });
  let resolvedWorkspacePath = sessionEntry.workspacePath;
  let resolvedWorkspaceIdentity = fallbackWorkspaceIdentity;
  try {
    const settings = getSettings ? await getSettings() : undefined;
    // 根因：原项目重连只取 Profile 的新凭据，却继续用 session 的旧地址，
    // 编辑线路后会连回旧端口并被 Host 注册成第二条 Profile。目标与凭据须来自同一份配置。
    // 根因：旧实现只换 Profile 凭据却沿用 session 地址，编辑线路后仍连回旧端口。
    // 目标地址与凭据必须出自同一份配置，否则 Host 会把同一项目注册成两条 Profile。
    // settings 读取失败时按无 settings 处理并继续，历史快照缺失不应阻断重连。
    const targetSnapshot = resolveSshReconnectSnapshot({ sessionEntry, settings });
    // 共享 Host 场景下 sibling 必须复用 initiator 凭据，禁止再次读取各自历史凭据。
    // 覆盖值优先于按 target 引用重新读取，避免同一 Host 出现多路并发认证。
    // 非 ssh 目标不读取任何 SSH 凭据，防止把无关凭据写入错误 profile。
    const sshCredentials = options?.sshCredentialsOverride ?? {
      password:
        targetSnapshot.kind === "ssh" && targetSnapshot.passwordCredentialKey
          ? await loadCredential(targetSnapshot.passwordCredentialKey)
          : null,
      privateKeyPassphrase:
        targetSnapshot.kind === "ssh" && targetSnapshot.privateKeyPassphraseCredentialKey
          ? await loadCredential(targetSnapshot.privateKeyPassphraseCredentialKey)
          : null,
    };
    const token =
      sessionEntry.target.kind === "server" && sessionEntry.target.tokenCredentialKey
        ? await loadCredential(sessionEntry.target.tokenCredentialKey)
        : null;
    reconnectTarget = createRemoteTargetFromSnapshot(targetSnapshot, {
      ...sshCredentials,
      token,
    });
    // 原地重连先检查凭据完备性，缺失即抛出结构化错误交由上层交接唯一向导。
    // 是否要求口令由 profile 是否配置口令引用决定，不能用口令为空代替该判断。
    // 只有密码与私钥都不可用时才判定缺失，密码认证的 profile 不应要求口令。
    if (options?.requireStoredCredentials && reconnectTarget.kind === "ssh") {
      const expectsPassphrase =
        targetSnapshot.kind === "ssh" && targetSnapshot.privateKeyPassphraseCredentialKey;
      if (
        !sshCredentials.password &&
        (!reconnectTarget.privateKeyPath ||
          (expectsPassphrase && !sshCredentials.privateKeyPassphrase))
      ) {
        throw Object.assign(new Error("credentials-required"), { code: "credentials-required" });
      }
    }
    let sessionId: string;
    try {
      // 请求携带 connectTrigger 为 reconnect，Host 据此区分首次连接与恢复的准入策略。
      // workspaceIdentity 用回退身份传入，让 Host 在 bind 前就能完成身份级隔离。
      // requestId 透传自调用方，使手机远控与桌面入口的失败能在同一链路内归因。
      sessionId = await connectRemoteWorkspaceTarget(reconnectTarget, options?.requestId, {
      workspacePath: sessionEntry.workspacePath,
      workspaceIdentity: fallbackWorkspaceIdentity,
      connectTrigger: "reconnect",
    });
    } catch (error) {
      // 该结构化错误只由 Host 在 Source 已上线后的目录 admission 发出。发起项目被删
      // 不代表 SSH 凭据失败；先放行复用同一凭据的 siblings，再按原路径记录该项目失败。
      if (
        reconnectTarget.kind === "ssh" &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE
      ) {
        options?.onSshHostReady?.(sshCredentials);
      }
      throw error;
    }
    if (reconnectTarget.kind === "ssh") {
      // Host ready 与 provider/task 等 workspace 初始化必须分阶段通知。
      // sibling 从此刻即可复用 initiator credential 创建 attachment，无需等待或重复读取凭据。
      // Host ready 与 workspace 初始化分阶段通知，sibling 从此可复用凭据创建 attachment。
      // 此处只通知不落库，workspace 初始化仍可能在此后失败，历史状态以最终结果为准。
      options?.onSshHostReady?.(sshCredentials);
    }
    // 解析结果以 Host 的规范路径为准，symlink 与大小写差异都在 Host 侧收敛。
    // 请求仍以条目原路径发起，保留 Host 侧的相对路径与别名语义。
    // 回填后所有后续绑定、tab 与历史键一律使用规范路径，不再混用两个值。
    resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
      sessionId,
      sessionEntry.workspacePath,
    );
    // Bug 原因：Renderer 过去用 transport target 本地推导 identity，与 Host 绑定的 remote:server:*
    // 权威 identity 分裂。这里和首次连接保持一致：先完成 Host bind，再只消费返回的权威 scope。
    // 这次 bind 也是手机远控桥接能通过的前提：bridge 按 tab 的 path/identity 三元比对 main descriptor，
    // 缺少 bind 或 bind 落后于 tab 回填会被 REMOTE_WORKSPACE_IDENTITY_MISMATCH 拒绝（3.12.0 曾因此连不上远程项目）。
    // bind 必须位于下方保留校验之前：校验与 upsertWorkspaceTab 之间不能再有 await，否则用户在等待
    // ready ACK 期间移除 tab 后，过期的校验结果会把 workspace 重新加回。
    // bug 根因：Renderer 曾用 transport target 本地推导 identity，与 Host 权威值分裂。
    // 此处与首次连接保持同一顺序：先完成 Host bind，再只消费返回的权威 scope。
    // 这次 bind 也是手机远控桥接的前提，桥接按 tab 的 path 与 identity 三元比对 main descriptor。
    // 缺少 bind 或 bind 落后于 tab 回填会被身份失配拒绝，3.12.0 曾因此连不上远程项目。
    const boundScope = await bindRemoteWorkspaceScope(
      sessionId,
      resolvedWorkspacePath,
      undefined,
      sessionEntry.workspacePurpose ?? "project",
    );
    resolvedWorkspacePath = boundScope.workspacePath;
    // 身份以 bind 返回值为唯一来源，不再回落到入口解析的 fallback。
    // 后续 upsert 用此身份作为目标态，同时把 fallback 作为 previous 传给 tab 做迁移。
    resolvedWorkspaceIdentity = boundScope.workspaceIdentity;
    // Bugfix: 手动重连过程中，用户可能先点重连再立即把该远端 tab 移除。
    // 如果这里不在成功落库前再做一次保留校验，会把用户刚移除的 workspace 又重新加回来。
    if (
      shouldKeepReconnectedWorkspace &&
      !shouldKeepReconnectedWorkspace({
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      })
    ) {
      logger.warn("[Root] 远程 workspace 在重连过程中已被移除，跳过恢复并回收 session", {
        workspacePath: resolvedWorkspacePath,
      });
      // tab 已被用户移除时立即回收刚建立的会话，避免留下无归属的远程连接。
      // 回收放在 return 之前完成，保证函数退出后不再持有 Host 侧资源。
      await disposeRemoteWorkspaceSession(sessionId);
      return;
    }
    // 先写路径到 session 的映射，再做身份映射，供 services 按路径查找同一连接。
    // 两次绑定都在 upsert 之前完成，保证 tab 出现时 services 已能解析该会话。
    bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
    bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
    // remoteTarget 写入前剥离密钥类字段，历史与 tab 中不得留存凭据明文。
    // 身份变化时附带 previousWorkspaceIdentity，让 tab 按旧键迁移而非新增一条。
    // localWorkspacePath 与 purpose 沿用条目原值，重连不得改变条目的归属与用途。
    upsertWorkspaceTab(resolvedWorkspacePath, {
      remoteSessionId: sessionId,
      remoteTarget: stripRemoteTargetSecrets(reconnectTarget),
      workspaceIdentity: resolvedWorkspaceIdentity,
      ...(fallbackWorkspaceIdentity !== resolvedWorkspaceIdentity
        ? { previousWorkspaceIdentity: fallbackWorkspaceIdentity }
        : {}),
      localWorkspacePath: sessionEntry.localWorkspacePath,
      workspacePurpose: sessionEntry.workspacePurpose,
    });
    if (activateWorkspaceAfterReconnect) {
      // 侧栏重连过去会先激活只有 identity、尚无 remoteSessionId 的断连 tab，
      // conversation provider 因 remote-waiting 返回 null，导致连接期间右侧整块黑屏。
      // 必须先绑定 services 并静默回填 tab 的 session 元数据，再一次性激活 tab 与草稿。
      // 激活前 services 与 tab 会话元数据均已就绪，避免 provider 在等待态返回空。
      // 过去先激活无 session 的断连 tab，导致连接期间右侧整块黑屏。
      // 返回 false 表示 tab 已不存在，此时跳过选中态回调，不再复活已关闭的界面。
      const activated = activateTabByPath(resolvedWorkspacePath, {
        workspaceIdentity: resolvedWorkspaceIdentity,
      });
      if (activated) {
        onWorkspaceActivated?.({
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
          restoreSelection: true,
        });
      }
    }
    // 成功落库放在激活之后，历史里的 connected 状态与用户可见界面在同一次重连内一致。
    // touchOpenedAt 置真刷新最近使用排序，重连成功应等同一次打开行为。
    // remoteSessions 取当前全量而非增量，构造函数据此去重并覆盖同身份旧记录。
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        localWorkspacePath: sessionEntry.localWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        workspacePurpose: sessionEntry.workspacePurpose,
        lastConnectionStatus: "connected",
        touchOpenedAt: true,
      }),
    );
  } catch (error) {
    const message =
      formatError?.(error) ?? (error instanceof Error ? error.message : String(error));
    logger.warn("[Root] 手动重连远程 workspace 失败", {
      workspacePath: resolvedWorkspacePath,
      error: message,
    });
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "failed",
        lastConnectionError: message,
        touchOpenedAt: false,
      }),
    );
    // 失败事实只在此写回；手动入口收到结构化异常后决定是否交接唯一向导。
    const reasonCode =
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    // 提示由错误码决定是否独立弹出，避免在已有向导承接时重复打扰用户。
    // toast 只做展示，不改变失败落库结果，也不参与是否上抛的判断。
    if (showErrorToast && shouldShowStandaloneRemoteErrorToast(reasonCode)) {
      toast(message);
    }
    // 桌面按钮需要吞掉异常并靠 toast 与落库反馈，异常不该穿透到渲染层。
    // 手机 Web 远控是 RPC 语义，必须把失败原样回传，否则界面停在假连接态。
    if (options?.throwOnFailure) {
      // 桌面端重连按钮需要吞掉异常并通过 toast/状态落库反馈，
      // 但手机端 Web 远控是 RPC 语义，必须把失败明确回传给手机端。
      throw error;
    }
  } finally {
    // 无论成功、失败还是提前返回，进度键都在 finally 移除，避免按钮永久处于重连中。
    // 按值过滤而非清空数组，保证并行重连的其他条目状态不被牵连。
    setReconnectingRemoteWorkspaceKeys((currentKeys) =>
      currentKeys.filter((key) => key !== reconnectWorkspaceKey),
    );
  }
}
