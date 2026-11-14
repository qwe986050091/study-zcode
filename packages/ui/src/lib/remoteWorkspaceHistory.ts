// 职责边界：本文件只维护远端 workspace 的持久化投影——session 列表、凭据 key 引用、
// 本机路径映射与 legacy identity 别名迁移；不做网络连接、不写 keychain、不渲染 UI。
// 落盘与 keychain 读写由调用方按返回的 mutation 整批执行。
//
// 不变量（INV）表：
// | 编号 | 断言 | 守住它的位置 | 改错后的故障 |
// | INV-01 | session key 统一为 identity 或路径 | buildWorkspaceSessionKey | 同一 workspace 出现两条历史 |
// | INV-02 | 只清理 remote-workspace: 命名空间 | collectOwnedRemoteWorkspaceCredentialKeys | 误删 Profile 凭据致冷启动认证失败 |
// | INV-03 | 引用不转移所有权 | isOwned 前缀过滤 | 历史清理删掉共享凭据 |
// | INV-04 | 快照只存凭据 key 不存明文 | createRemoteTargetSnapshot | 密码以明文写入 settings |
// | INV-05 | 已有快照的 key 必须复用 | previousSnapshot 分支 | keychain 中堆积孤儿密文 |
// | INV-06 | 仅在本次调用提供明文时写凭据 | credentialsToSave 的三个分支 | 空明文覆盖已有密文 |
// | INV-07 | 连接失败不重建快照 | nextSnapshot 的 failed 分支 | 重试指向未写入的密文 |
// | INV-08 | 换代先剔除 currentEntry 再 upsert | nextRemoteSessions 的计算 | legacy 条目残留并持久化 |
// | INV-09 | 历史容量上限 20 | REMOTE_WORKSPACE_SESSION_LIMIT | 列表与设置文件长度不一致 |
// | INV-10 | 裁剪在按 lastOpenedAt 排序之后 | upsert 的 sort 与 slice | 刚打开的 workspace 被随机丢弃 |
// | INV-11 | 路径归一化先于身份拼接 | normalizeWorkspacePathForIdentity | 同一目录分裂成两条历史 |
// | INV-12 | SSH host 小写化、username 保留原样 | getRemoteWorkspaceAuthorityKey | 大小写敏感账号无法登录 |
// | INV-13 | 缺省端口显式参与 identity | normalizedPort ?? 22 | host 与 host:22 产生双份记录 |
// | INV-14 | 别名只在唯一候选时生效 | mergeIdentityAliases | 路径被绑定到错误 Source |
// | INV-15 | 候选冲突时保持 legacy identity | stableAlias 的三元判断 | 打开错误的远端工作区 |
// | INV-16 | retired Profile 不参与别名 | buildSourceProfileWorkspaceIdentityAliases | 下线设备继续影响身份 |
// | INV-17 | rekey 的旧 identity 保持原文 | identityRekeys 的 previousWorkspaceIdentity | 上层无法定位需改写的条目 |
// | INV-18 | 删除函数只返回数据不落盘 | removeRemoteWorkspaceSessionEntries | 预览与最终结果不一致
/* eslint-disable max-lines -- 远端 workspace 历史集中维护持久化、凭据和 MCP 路径映射元数据，拆分会扩大恢复链路回归面。 */
import type {
  AppSettings,
  PersistedWorkspaceSessionEntry,
  RemoteTarget,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import { buildServerRemoteWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { WindowTabState } from "@/store/tabStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

// [契约] 历史上限为 20，由 upsert 与持久化两侧共同遵守，不要只改一处。
// 裁剪依据 lastOpenedAt 降序，被裁掉条目的自有凭据由 mutation 负责回收。
// 改错故障：只在一侧裁剪会让 UI 列表与设置文件长度不一致，重启后条目复活。
const REMOTE_WORKSPACE_SESSION_LIMIT = 20;

// [事务] 一次 mutation 同时产出新 entry、新列表与凭据增删，三者必须整批提交。
// 只落 sessions 不落 credentials，会出现 key 存在而密文缺失的记录。
// 改错故障：分开提交时中途失败会留下指向空值的凭据引用。
interface RemoteWorkspaceSessionMutation {
  entry: RemoteWorkspaceSessionEntry;
  nextRemoteSessions: RemoteWorkspaceSessionEntry[];
  credentialsToSave: {
    key: string;
    value: string;
  }[];
  credentialKeysToDelete: string[];
}

// [契约] 删除操作只返回剩余 sessions 与待删 key，不直接触碰存储。
// `removeRemoteWorkspaceSessionEntries` 保持纯计算：调用方可预览、撤销或与其他写入合并。
// 改错故障：在函数内直接删凭据会让 UI 预览与最终结果不一致。
interface RemoveRemoteWorkspaceSessionEntriesResult {
  nextRemoteSessions: RemoteWorkspaceSessionEntry[];
  credentialKeysToDelete: string[];
}

// [契约] key 形如 remote-workspace:<workspaceKey>:password，前缀即所有权标记。
// 入参必须是已归一化的 workspace key，不能传原始远端路径。
// 改错故障：用原始路径拼 key 会在 identity 换代后生成第二份密码记录。
function buildRemoteWorkspacePasswordCredentialKey(workspaceKey: string): string {
  return `remote-workspace:${workspaceKey}:password`;
}

// [契约] 私钥口令与登录密码使用不同后缀，绝不能共用同一条记录。
// 后缀字符串同时是 isOwned 前缀判定的依赖，改动需同步 collectOwned。
// 改错故障：共用后缀会让 SSH 密码覆盖口令，连接直接失败。
function buildRemoteWorkspacePrivateKeyPassphraseCredentialKey(workspaceKey: string): string {
  return `remote-workspace:${workspaceKey}:private-key-passphrase`;
}

// [契约] server token 同样落在 remote-workspace: 命名空间，因此会被自有凭据回收覆盖。
// server 重新快照时必须沿用旧 key，否则旧 token 永远无法回收。
// 改错故障：每次生成新 key 会让 keychain 里堆满失效 token。
function buildRemoteWorkspaceServerTokenCredentialKey(workspaceKey: string): string {
  return `remote-workspace:${workspaceKey}:server-token`;
}

// [资源] 只收集本文件命名空间下的 key，Profile 凭据绝不进入删除候选。
// 这条边界是历史 bug 的修复点：引用不转移所有权，清理不得跨命名空间。
// 改错故障：扩大收集范围会删掉 Profile 密码，冷启动后认证失败。
function collectOwnedRemoteWorkspaceCredentialKeys(snapshot: RemoteTargetSnapshot): string[] {
  // 历史快照可引用 Profile 凭据，但引用不转移所有权。此前重投影移除引用时
  // 把 Profile 密码也加入删除列表，导致冷启动后失去认证；所有历史清理只收集自有 key。
  // [契约] 类型守卫同时完成 undefined 过滤与前缀判定，避免各调用点重复实现。
  // startsWith 必须带冒号，防止 remote-workspace-xxx 这类相似前缀被误判。
  // 改错故障：去掉冒号会让其他命名空间的 key 进入删除列表。
  const isOwned = (key: string | undefined): key is string =>
    typeof key === "string" && key.startsWith("remote-workspace:");
  if (snapshot.kind === "ssh") {
    return [snapshot.passwordCredentialKey, snapshot.privateKeyPassphraseCredentialKey].filter(
      isOwned,
    );
  }

  if (snapshot.kind === "server") {
    return [snapshot.tokenCredentialKey].filter(isOwned);
  }

  return [];
}

// [契约] 先兼容 Windows 反斜杠再取最后一段，保证跨平台显示一致。
// filter(Boolean) 处理结尾斜杠；全空路径回退原始入参而不是空串。
// 改错故障：不做归一会在 Windows 上把整条路径当作名称显示。
export function getWorkspaceDisplayLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

// [契约] 三个字段任一存在即视为远端，不能改成 AND 或只认 identity。
// 这是持久化层区分 local 与 remote 的唯一口径，其他位置不得另写判断。
// 改错故障：要求带 workspaceIdentity 会让旧数据中的 remote 项退化成 local。
export function hasRemoteWorkspaceIdentity(entry: {
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
}): boolean {
  return Boolean(entry.remoteSessionId || entry.remoteTarget || entry.workspaceIdentity);
}

// [契约] 只做 remote:ssh: 前缀判定，不解析完整结构，保持廉价且稳定。
// 先 trim 再判断，避免持久化里带首尾空白的 identity 被判为非 SSH。
// 改错故障：改调 parseRemoteWorkspaceIdentity 会随格式演进改变判定结果。
export function isSshRemoteWorkspaceIdentity(workspaceIdentity?: string | null): boolean {
  return workspaceIdentity?.trim().startsWith("remote:ssh:") === true;
}

type WslRemoteTargetLike = Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "wsl" }>;

// [契约] 空串与纯空白统一归一为 undefined，避免快照里出现 user 为空串。
// 该归一与 createRemoteTargetSnapshot 的条件展开互相依赖，必须保持一致。
// 改错故障：返回空串会让 identity 多出一个空 authority 段。
function getWslRemoteTargetUser(target: WslRemoteTargetLike): string | undefined {
  return target.user?.trim() || undefined;
}

// [契约] 无 distro 时用 default 占位，与 getRemoteWorkspaceAuthorityKey 的规则一致。
// 此串只用于展示，不参与身份计算；两者格式相同是约定而非可混用。
// 改错故障：把展示串当成持久化 key 会让 identity 解析失败。
function formatWslRemoteTargetAuthority(target: WslRemoteTargetLike): string {
  const user = getWslRemoteTargetUser(target);
  if (target.distro) {
    return user ? `wsl:${target.distro}:${user}` : `wsl:${target.distro}`;
  }

  return user ? `wsl:default:${user}` : "wsl";
}

// [契约] 名称优先级 name → serverId → host，保证任何配置都有可展示文本。
// 三级兜底与 getServerRemoteTargetIdentityId 顺序相同但用途不同，不要合并。
// 改错故障：直接返回 name 会让未命名服务器显示为空白条目。
function getServerRemoteTargetDisplayName(
  target: Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "server" }>,
): string {
  return target.name?.trim() || target.serverId?.trim() || formatServerRemoteTargetHost(target);
}

// [失败路径] URL 解析失败时退回原始字符串，不抛错（用户可能只填裸主机名）。
// 只取 host，丢掉端口与路径，因为它用于展示与 identity 兜底。
// 改错故障：改成 throw 会让一条坏配置阻断整个历史列表渲染。
function formatServerRemoteTargetHost(
  target: Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "server" }>,
): string {
  try {
    return new URL(target.url.trim()).host;
  } catch {
    return target.url.trim();
  }
}

// [契约] switch 覆盖四种 kind 且刻意不写 default，新增类型时由 TS 报穷尽性错误。
// 每种分支的格式面向 UI，不要在此拼接 identity 或持久化字段。
// 改错故障：加 default 返回空串会让新类型静默显示为空白副标题。
export function formatRemoteWorkspaceTargetSubtitle(
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  switch (target.kind) {
    case "ssh":
      return `SSH · ${target.username}@${target.host}${target.port ? `:${target.port}` : ""}`;
    case "wsl": {
      const user = getWslRemoteTargetUser(target);
      return ["WSL", target.distro, user].filter(Boolean).join(" · ");
    }
    case "docker":
      return `Docker · ${target.container}`;
    case "server":
      return `Server · ${getServerRemoteTargetDisplayName(target)}`;
  }
}

// [契约] SSH 仅在非 22 端口时显示端口，减少标题噪声。
// docker 用 docker:<container>、server 用 host，均为稳定短标识。
// 改错故障：所有 kind 都拼端口会让窄侧栏标题被截断。
export function formatRemoteWorkspaceHeaderHostLabel(
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  switch (target.kind) {
    case "ssh":
      return target.port && target.port !== 22 ? `${target.host}:${target.port}` : target.host;
    case "wsl":
      return formatWslRemoteTargetAuthority(target);
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return formatServerRemoteTargetHost(target);
  }
}

// [契约] 明确不拼接线路信息：设备原子与悬浮详情负责展示 target。
// void target 是刻意的未使用标记，保留参数只为兼容既有调用方。
// 改错故障：把 alias 拼进名称会破坏本地化，并让标题随连接状态抖动。
export function formatRemoteWorkspaceDisplayLabel(
  label: string,
  target?: RemoteTarget | RemoteTargetSnapshot,
): string {
  // 线路信息属于设备原子/悬浮详情，不能把硬编码 SSH alias 拼进项目名称；
  // 这样既避免窄侧栏截断，也让标题可本地化。target 参数保留兼容旧调用方。
  void target;
  return label;
}

// [契约] 反斜杠转斜杠、去尾部斜杠、空串归一为 /，保证同一目录只有一种文本形态。
// 该归一必须先于 identity 拼接，否则同一远端路径会产生两个 session key。
// 改错故障：漏掉尾部斜杠会让 /a 与 /a/ 变成两条历史并各持一份凭据。
function normalizeWorkspacePathForIdentity(path: string): string {
  // 远程目录可能出现符号链接别名（例如 /dev 与 /home/dev）。
  // 身份计算前统一做分隔符归一化与收尾斜杠清理，避免同一路径文本噪声导致身份漂移。
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : "/";
}

// [契约] authority 段顺序固定，改动等于让所有既有 identity 失效。
// SSH 的 host 小写化但 username 保持原样，因为远端用户名大小写敏感。
// 改错故障：把 username 也小写会让大小写敏感账号无法登录。
function getRemoteWorkspaceAuthorityKey(target: RemoteTarget | RemoteTargetSnapshot): string {
  switch (target.kind) {
    // [契约] ssh authority 固定四段，空 username 也保留空段，不做省略。
    // 这与 identity 的历史格式一致，省略空段等于让所有旧 key 集体漂移。
    // 改错故障：省略空段会让解析侧下标错位，身份与其他端不一致。
    case "ssh": {
      const normalizedHost = target.host.trim().toLowerCase();
      const normalizedUsername = target.username.trim();
      const normalizedPort = target.port ?? 22;
      return ["ssh", normalizedHost, normalizedPort, normalizedUsername].join(":");
    }
    case "wsl": {
      // WSL 默认用户与 root/其他显式用户的文件权限边界不同，
      // workspace identity 必须区分显式 user，避免 session、缓存和队列串用。
      const user = getWslRemoteTargetUser(target);
      const base = ["wsl", target.distro ?? "default"];
      return user ? [...base, user].join(":") : base.join(":");
    }
    case "docker":
      return ["docker", target.container].join(":");
    case "server": {
      const identity = buildServerRemoteWorkspaceIdentity({
        serverId: getServerRemoteTargetIdentityId(target),
        workspacePath: "/",
      });
      return identity.slice("remote:".length, -":/".length);
    }
  }
}

// [契约] server 走 buildServerRemoteWorkspaceIdentity，其余走 remote:<authority>:<path>。
// 两种格式互不兼容，分支只能依据 target.kind，不能靠字符串前缀嗅探。
// 改错故障：让 server 也走通用拼接会让 Source 绑定的 stable identity 失效。
export function buildRemoteWorkspaceIdentity(
  workspacePath: string,
  target: RemoteTarget | RemoteTargetSnapshot,
): string {
  if (target.kind === "server") {
    return buildServerRemoteWorkspaceIdentity({
      serverId: getServerRemoteTargetIdentityId(target),
      workspacePath,
    });
  }

  const authority = getRemoteWorkspaceAuthorityKey(target);
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  return `remote:${authority}:${normalizedPath}`;
}

// [契约] serverId → name → host 是 server identity 的唯一来源。
// 与展示名共用优先级，但语义不同：这个值会进入持久化 identity。
// 改错故障：改用 URL 当 id 会让用户改端口后历史全部对不上。
function getServerRemoteTargetIdentityId(
  target: Extract<RemoteTarget | RemoteTargetSnapshot, { kind: "server" }>,
): string {
  return target.serverId?.trim() || target.name?.trim() || formatServerRemoteTargetHost(target);
}

// [契约] 已有 workspaceIdentity 直接采用，缺失才现算，保证旧数据不被重写。
// fallback 只是迁移期兼容路径，新写入必须显式携带 identity。
// 改错故障：总是重算会把 legacy identity 覆盖成 stable，丢失别名映射的输入。
export function resolveRemoteWorkspaceSessionIdentity(
  entry: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "target" | "workspaceIdentity">,
): string {
  return entry.workspaceIdentity || buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target);
}

// [契约] 统一 key = workspaceIdentity?.trim() 否则 workspacePath，全仓库同口径。
// 去重、绑定、缓存、持久化都必须调用本函数，不得内联三元表达式。
// 改错故障：某处只用路径会让同一远端 workspace 出现两条记录。
export function buildWorkspaceSessionKey(entry: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return entry.workspaceIdentity?.trim() || entry.workspacePath;
}

// [契约] 空白路径归一为 undefined，避免持久化里出现空字符串的本机路径。
// undefined 表示「未知」，空串表示「根目录」，语义不同不能合并。
// 改错故障：保留空串会让 MCP 映射把空路径当成有效本机基准。
function normalizeOptionalPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed ? trimmed : undefined;
}

// [契约] 先用显式 preferred identity 加精确路径匹配，再退回 identity 匹配。
// 两段顺序不可交换：preferred 是调用方已确认的换代对象。
// 改错故障：先做 identity 匹配会命中同路径旧条目，重连后产生重复项。
export function findMatchingRemoteWorkspaceSessionEntry(
  sessions: RemoteWorkspaceSessionEntry[],
  workspacePath: string,
  target: RemoteTarget | RemoteTargetSnapshot,
  preferredWorkspaceIdentity?: string,
): RemoteWorkspaceSessionEntry | null {
  // [契约] 空白 identity 视为未提供，直接走 fallback，不能当有效 key 使用。
  // 这里同时要求 workspacePath 相等，防止同一 identity 的不同目录互相污染。
  // 改错故障：只比 identity 会让多个远端目录共用一条会话记录。
  const preferredWorkspaceKey = preferredWorkspaceIdentity?.trim();
  if (preferredWorkspaceKey) {
    const preferred = sessions.find(
      (entry) =>
        entry.workspacePath === workspacePath &&
        buildWorkspaceSessionKey(entry) === preferredWorkspaceKey,
    );
    if (preferred) return preferred;
  }
  const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
  return (
    sessions.find((entry) => resolveRemoteWorkspaceSessionIdentity(entry) === workspaceIdentity) ??
    null
  );
}

// [事务] 快照只保存凭据 key 引用，明文永不落盘，明文由 mutation 单独写 keychain。
// previousSnapshot 存在时复用其 key，保证同一 workspace 更新不产生新 key。
// 改错故障：每次重建 key 会让旧密文成为孤儿，长期占用 keychain。
export function createRemoteTargetSnapshot(
  workspaceKey: string,
  target: RemoteTarget,
  previousSnapshot?: RemoteTargetSnapshot,
): RemoteTargetSnapshot {
  // [契约] server 来源的 workspace 不自建 SSH 凭据 key，避免与 Source 所有权重叠。
  // 标记取自 workspaceKey 的解析结果而非 target，因为 key 才代表归属。
  // 改错故障：忽略该标记会在 Source 工作区里生成第二份密码副本。
  const sourceServerOwnedCredentials =
    parseRemoteWorkspaceIdentity(workspaceKey)?.kind === "server";
  switch (target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
        assetInstallMode: target.assetInstallMode,
        privateKeyPath: target.privateKeyPath,
        passwordCredentialKey:
          !sourceServerOwnedCredentials && target.password && target.password.length > 0
            ? previousSnapshot?.kind === "ssh" && previousSnapshot.passwordCredentialKey
              ? previousSnapshot.passwordCredentialKey
              : buildRemoteWorkspacePasswordCredentialKey(workspaceKey)
            : undefined,
        privateKeyPassphraseCredentialKey:
          !sourceServerOwnedCredentials &&
          target.privateKeyPassphrase &&
          target.privateKeyPassphrase.length > 0
            ? previousSnapshot?.kind === "ssh" && previousSnapshot.privateKeyPassphraseCredentialKey
              ? previousSnapshot.privateKeyPassphraseCredentialKey
              : buildRemoteWorkspacePrivateKeyPassphraseCredentialKey(workspaceKey)
            : undefined,
      };
    case "wsl": {
      const user = target.user?.trim();
      return {
        kind: "wsl",
        distro: target.distro,
        ...(user ? { user } : {}),
      };
    }
    case "docker":
      return {
        kind: "docker",
        container: target.container,
      };
    case "server":
      return {
        kind: "server",
        url: target.url,
        ...(target.name?.trim() ? { name: target.name.trim() } : {}),
        ...(target.workspacePath?.trim() ? { workspacePath: target.workspacePath.trim() } : {}),
        ...(target.serverId?.trim() ? { serverId: target.serverId.trim() } : {}),
        tokenCredentialKey:
          target.token && target.token.length > 0
            ? previousSnapshot?.kind === "server" && previousSnapshot.tokenCredentialKey
              ? previousSnapshot.tokenCredentialKey
              : buildRemoteWorkspaceServerTokenCredentialKey(workspaceKey)
            : undefined,
      };
  }
}

// [契约] 与 createRemoteTargetSnapshot 严格对称，新增字段必须两侧同时补。
// 凭据只在调用方提供非空值时展开，快照里的 key 不参与重建。
// 改错故障：只改一侧会让快照往返丢字段，例如 assetInstallMode。
export function createRemoteTargetFromSnapshot(
  snapshot: RemoteTargetSnapshot,
  credentials: {
    password: string | null;
    privateKeyPassphrase: string | null;
    token?: string | null;
  },
): RemoteTarget {
  switch (snapshot.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: snapshot.host,
        port: snapshot.port,
        username: snapshot.username,
        ...(snapshot.sshConfigAlias ? { sshConfigAlias: snapshot.sshConfigAlias } : {}),
        ...(snapshot.assetInstallMode ? { assetInstallMode: snapshot.assetInstallMode } : {}),
        ...(snapshot.privateKeyPath ? { privateKeyPath: snapshot.privateKeyPath } : {}),
        ...(credentials.password ? { password: credentials.password } : {}),
        ...(credentials.privateKeyPassphrase
          ? { privateKeyPassphrase: credentials.privateKeyPassphrase }
          : {}),
      };
    case "wsl":
      return {
        kind: "wsl",
        distro: snapshot.distro,
        ...(snapshot.user ? { user: snapshot.user } : {}),
      };
    case "docker":
      return {
        kind: "docker",
        container: snapshot.container,
      };
    case "server":
      return {
        kind: "server",
        url: snapshot.url,
        ...(snapshot.name ? { name: snapshot.name } : {}),
        ...(snapshot.workspacePath ? { workspacePath: snapshot.workspacePath } : {}),
        ...(snapshot.serverId ? { serverId: snapshot.serverId } : {}),
        ...(credentials.token ? { token: credentials.token } : {}),
      };
  }
}

// [事务] 先按 key 过滤旧条目，再插入新条目，最后排序并按上限截断。
// 截断必须在排序之后，才能保证被裁掉的一定是最久未打开的条目。
// 改错故障：先截断再排序会随机丢掉刚打开的 workspace。
export function upsertRemoteWorkspaceSessionEntries(
  sessions: RemoteWorkspaceSessionEntry[],
  nextEntry: RemoteWorkspaceSessionEntry,
): RemoteWorkspaceSessionEntry[] {
  const nextWorkspaceKey = buildWorkspaceSessionKey(nextEntry);
  return [
    nextEntry,
    ...sessions.filter((entry) => buildWorkspaceSessionKey(entry) !== nextWorkspaceKey),
  ]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .slice(0, REMOTE_WORKSPACE_SESSION_LIMIT);
}

// [契约] 入参为 readonly，函数不修改原数组，只构造新列表返回。
// 删除凭据前必须先经 collectOwned 过滤，Profile 引用一律跳过。
// 改错故障：直接清空 target 上的所有 key 会连同 Profile 凭据一起删掉。
export function removeRemoteWorkspaceSessionEntries(
  sessions: readonly RemoteWorkspaceSessionEntry[],
  workspaceKeys: readonly string[],
): RemoveRemoteWorkspaceSessionEntriesResult {
  const workspaceKeySet = new Set(
    workspaceKeys.map((workspaceKey) => workspaceKey.trim()).filter(Boolean),
  );
  // [契约] 用 Set 去重：迁移期多个 session 可能引用同一个 key。
  // 返回时转成数组，是调用方按 key 逐个删除的契约形态。
  // 改错故障：用数组收集会让同一 key 被删两次，第二次抛 not-found。
  const credentialKeysToDelete = new Set<string>();
  const nextRemoteSessions: RemoteWorkspaceSessionEntry[] = [];

  for (const session of sessions) {
    const sessionWorkspaceKey = buildWorkspaceSessionKey(session);
    if (!workspaceKeySet.has(sessionWorkspaceKey)) {
      nextRemoteSessions.push(session);
      continue;
    }

    for (const credentialKey of collectOwnedRemoteWorkspaceCredentialKeys(session.target)) {
      credentialKeysToDelete.add(credentialKey);
    }
  }

  return {
    nextRemoteSessions,
    credentialKeysToDelete: [...credentialKeysToDelete],
  };
}

// [事务] 这是唯一同时改 sessions 与 credentials 的入口，必须整批原子提交。
// 所有分支都在内存中算完再返回，函数本身不落盘，便于失败回滚。
// 改错故障：中途写盘会让失败后列表与 keychain 处于不同世代。
export function buildRemoteWorkspaceSessionMutation(params: {
  remoteSessions: RemoteWorkspaceSessionEntry[];
  workspacePath: string;
  localWorkspacePath?: string;
  workspaceIdentity?: string;
  target: RemoteTarget;
  workspacePurpose?: "project" | "conversation";
  lastConnectionStatus: RemoteWorkspaceSessionEntry["lastConnectionStatus"];
  lastConnectionError?: string;
  touchOpenedAt: boolean;
}): RemoteWorkspaceSessionMutation {
  // [契约] currentEntry 可能为 null，后续读取必须判空或走可选链。
  // 它代表「被换代的旧条目」，同时是复用凭据 key 的唯一来源。
  // 改错故障：把 null 当对象用会让首次连接直接抛 TypeError。
  const currentEntry =
    findMatchingRemoteWorkspaceSessionEntry(
      params.remoteSessions,
      params.workspacePath,
      params.target,
      params.workspaceIdentity,
    ) ?? null;
  // [契约] 优先级：调用方显式 identity → 旧条目 identity → 现算 identity。
  // 显式值优先是为了让 Host 绑定后的 stable identity 覆盖 legacy 计算值。
  // 改错故障：让现算值优先会覆盖 stable identity，产生换代重复条目。
  const resolvedWorkspaceIdentity =
    params.workspaceIdentity ??
    currentEntry?.workspaceIdentity ??
    buildRemoteWorkspaceIdentity(params.workspacePath, params.target);
  // [契约] 必须与 buildWorkspaceSessionKey 完全同式，否则 key 与去重口径分叉。
  // workspaceKey 同时决定凭据 key 的命名，是所有持久化记录的主键。
  // 改错故障：漏掉 trim 会让带空白的 identity 生成另一套 key。
  const workspaceKey = resolvedWorkspaceIdentity?.trim() || params.workspacePath;
  // [事务] 连接失败时沿用旧快照，而不是用明文 target 重建，避免密码进快照。
  // 失败状态下不采集新凭据 key，保证重试路径不产生孤儿引用。
  // 改错故障：失败也重建会让 SSH 密码 key 指向从未写入的密文。
  const nextSnapshot =
    params.lastConnectionStatus === "failed" && currentEntry
      ? currentEntry.target
      : createRemoteTargetSnapshot(workspaceKey, params.target, currentEntry?.target);
  // [契约] 本机基准路径可选，但一旦存在必须写回，供 filesystem MCP 映射。
  // 优先取参数、其次取旧条目，避免从 Settings 重连时丢失本机映射。
  // 改错故障：只读参数会让重连后的 MCP 路径映射永久缺失。
  const localWorkspacePath = normalizeOptionalPath(
    params.localWorkspacePath ?? currentEntry?.localWorkspacePath,
  );
  // [契约] kind 固定 remote；workspacePath 保留远端路径原文，不做归一。
  // workspaceIdentity 与 target 必须来自同一轮解析结果，不能交叉复用。
  // 改错故障：混用不同轮的 identity 与 snapshot 会得到无法反解的组合。
  const nextEntry: RemoteWorkspaceSessionEntry = {
    kind: "remote",
    workspacePath: params.workspacePath,
    ...(params.workspacePurpose || currentEntry?.workspacePurpose
      ? {
          workspacePurpose: params.workspacePurpose ?? currentEntry?.workspacePurpose,
        }
      : {}),
    // Bugfix: filesystem MCP 同步需要用“本机 workspace -> 远端 workspace”映射。
    // 远端历史之前只保存远端路径，已连接后的 Settings/Header 入口无法再恢复本机基准路径。
    ...(localWorkspacePath ? { localWorkspacePath } : {}),
    workspaceIdentity: resolvedWorkspaceIdentity,
    target: nextSnapshot,
    lastOpenedAt: params.touchOpenedAt ? Date.now() : (currentEntry?.lastOpenedAt ?? Date.now()),
    lastConnectionStatus: params.lastConnectionStatus,
    lastConnectionError:
      params.lastConnectionStatus === "failed"
        ? (params.lastConnectionError ?? currentEntry?.lastConnectionError)
        : undefined,
  };
  // Bug 原因：Host 绑定 stable identity 后，旧 route entry 与新 entry 的 key 不同，
  // 通用 upsert 会把两条都保留。已经通过 target/alias 证明的 currentEntry 就是被换代对象，
  // 必须先移除再按 stable key 插入。
  // [事务] 先剔除 currentEntry 再 upsert，是修复「换代后双条目」的关键。
  // 剔除按引用相等而非 key 相等，因为换代后两者的 key 本来就不同。
  // 改错故障：只靠 upsert 去重会让 legacy 条目残留并被持久化。
  const nextRemoteSessions = upsertRemoteWorkspaceSessionEntries(
    currentEntry
      ? params.remoteSessions.filter((entry) => entry !== currentEntry)
      : params.remoteSessions,
    nextEntry,
  );
  // [契约] 用新列表的全部 key 判断旧条目是否仍存活，从而决定是否回收凭据。
  // 必须在 upsert 之后计算，否则会误删即将被保留条目的凭据。
  // 改错故障：提前计算会让当前 workspace 的密码在本次调用中被删掉。
  const nextRemoteWorkspaceKeys = new Set(
    nextRemoteSessions.map((entry) => buildWorkspaceSessionKey(entry)),
  );
  const credentialKeysToDelete = new Set<string>();
  // [契约] 只收集 currentEntry 的自有 key，Profile 来源的 key 不在回收范围。
  // 该集合与 nextCredentialKeys 的差集就是本次需要删除的旧凭据。
  // 改错故障：把 Profile key 算进来会在切换 Profile 时删掉共享凭据。
  const previousCredentialKeys = new Set(
    currentEntry ? collectOwnedRemoteWorkspaceCredentialKeys(currentEntry.target) : [],
  );
  // [契约] 新快照的 key 集合来自刚生成的 snapshot，而不是 target 明文。
  // 差集判定保证 key 未变则密文不动，减少不必要的 keychain 写入。
  // 改错故障：用 target 推断会让密码被清空时仍保留旧 key。
  const nextCredentialKeys = new Set(collectOwnedRemoteWorkspaceCredentialKeys(nextSnapshot));
  const sourceServerOwnedCredentials =
    parseRemoteWorkspaceIdentity(workspaceKey)?.kind === "server";
  // [契约] server 来源的 workspace 允许保留 remote:<...> 形式的回滚凭据。
  // 判定刻意排除 :remote:server: 段，避免把服务器 token 当成可回滚项。
  // 改错故障：去掉排除会让 Source 切换后仍能读到旧 server token。
  const preservesRollbackCredential = (credentialKey: string): boolean =>
    sourceServerOwnedCredentials &&
    credentialKey.startsWith("remote-workspace:remote:") &&
    !credentialKey.includes(":remote:server:");

  // [失败路径] 只有既不在新集合、又不可回滚的 key 才进入删除列表。
  // 双重条件缺一不可：前者防泄漏，后者防误删回滚通道。
  // 改错故障：只看差集会让 rollback 凭据在 Source 升级时被清空。
  for (const previousCredentialKey of previousCredentialKeys) {
    if (
      !nextCredentialKeys.has(previousCredentialKey) &&
      !preservesRollbackCredential(previousCredentialKey)
    ) {
      credentialKeysToDelete.add(previousCredentialKey);
    }
  }

  // [契约] 这里处理被容量裁剪的条目，currentEntry 已单独处理必须跳过。
  // 跳过的理由：它的 key 差异已由差集逻辑算过，重复处理会双重删除。
  // 改错故障：不跳过会对同一 key 生成两次删除，其中一次必然失败。
  for (const removedEntry of params.remoteSessions) {
    if (removedEntry === currentEntry) {
      // currentEntry 的凭据差异已在 previousCredentialKeys 分支处理；
      // 无显式 identity 的旧 entry 不能再被当成「被容量裁剪」重复删除凭据。
      continue;
    }
    if (nextRemoteWorkspaceKeys.has(buildWorkspaceSessionKey(removedEntry))) {
      continue;
    }

    for (const credentialKey of collectOwnedRemoteWorkspaceCredentialKeys(removedEntry.target)) {
      if (!preservesRollbackCredential(credentialKey)) {
        credentialKeysToDelete.add(credentialKey);
      }
    }
  }

  // [契约] 只有 target 提供明文且 snapshot 生成了 key 时才写凭据。
  // password / passphrase / token 三个分支互斥，不要合并成通用 key。
  // 改错故障：无明文也 push 会写入空字符串，覆盖已有密文。
  const credentialsToSave: { key: string; value: string }[] = [];

  if (
    // [契约] 明文只在本次调用内传递，返回后不应被任何返回结构引用。
    // 双 kind 判定是类型收窄需要，target 与 snapshot 可能来自不同版本。
    // 改错故障：去掉 snapshot 判定会让类型系统无法收窄凭据 key 字段。
    params.target.kind === "ssh" &&
    nextSnapshot.kind === "ssh" &&
    params.target.password &&
    nextSnapshot.passwordCredentialKey
  ) {
    credentialsToSave.push({
      key: nextSnapshot.passwordCredentialKey,
      value: params.target.password,
    });
  }

  if (
    params.target.kind === "ssh" &&
    nextSnapshot.kind === "ssh" &&
    params.target.privateKeyPassphrase &&
    nextSnapshot.privateKeyPassphraseCredentialKey
  ) {
    credentialsToSave.push({
      key: nextSnapshot.privateKeyPassphraseCredentialKey,
      value: params.target.privateKeyPassphrase,
    });
  }

  if (
    params.target.kind === "server" &&
    nextSnapshot.kind === "server" &&
    params.target.token &&
    nextSnapshot.tokenCredentialKey
  ) {
    credentialsToSave.push({
      key: nextSnapshot.tokenCredentialKey,
      value: params.target.token,
    });
  }

  return {
    entry: nextEntry,
    nextRemoteSessions,
    credentialsToSave,
    credentialKeysToDelete: [...credentialKeysToDelete],
  };
}

// [契约] 只有 isWorkspaceTab 的 tab 参与持久化，其他 tab 直接跳过。
// 远端 tab 必须能查到 remoteEntry 才写回，宁可缺项也不造伪条目。
// 改错故障：为缺失项造假 local 条目会让远端工作区重启后变成本地路径。
export function buildPersistedWorkspaceSessionEntries(
  tabs: WindowTabState[],
  remoteSessionsByWorkspaceKey: ReadonlyMap<string, RemoteWorkspaceSessionEntry>,
): PersistedWorkspaceSessionEntry[] {
  return tabs.reduce<PersistedWorkspaceSessionEntry[]>((entries, tab) => {
    if (!isWorkspaceTab(tab)) {
      return entries;
    }

    if (hasRemoteWorkspaceIdentity(tab)) {
      const workspaceKey = buildWorkspaceSessionKey(tab);
      const remoteEntry = remoteSessionsByWorkspaceKey.get(workspaceKey);

      // lastWorkspaceSession 现在是远端 workspace 的唯一持久化来源。
      // 如果这里因为 tab 断连就把 remote 项漏掉，下次启动会直接丢失“手动重连”的入口。
      // 因此只要当前 tab 具有远端身份，就必须写回完整 remote 条目。
      if (!remoteEntry) {
        return entries;
      }

      entries.push(remoteEntry);
      return entries;
    }

    entries.push({
      kind: "local",
      workspacePath: tab.workspacePath,
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
    });
    return entries;
  }, []);
}

// [契约] lastActiveWorkspace 优先：新版只恢复活动执行目录。
// 旧字段 lastWorkspaceSession 仅用于首次导入与连接旧 Server。
// 改错故障：同时合并两处来源会产生重复历史并互相覆盖。
export function readPersistedWorkspaceSessionEntries(
  settings: Pick<
    AppSettings,
    | "lastWorkspaceSession"
    | "lastActiveWorkspace"
    | "sourceServerWorkspaceHistory"
    | "connectionProfiles"
    | "remoteConversationWorkspaceBySourceServerId"
  >,
): PersistedWorkspaceSessionEntry[] {
  // 新版只恢复活动执行目录；旧字段仅供首次导入或连接旧 Server 使用。
  if (settings.lastActiveWorkspace !== undefined) {
    return settings.lastActiveWorkspace ? [settings.lastActiveWorkspace] : [];
  }
  // [契约] 两类别名必须先合并再按唯一候选裁决，不能各自查表后覆盖。
  // 合并的目的正是让冲突候选退化为 undefined，从而保持 legacy identity。
  // 改错故障：后写覆盖会让同一路径随机绑定到某个 Source。
  const projectAliases = mergeIdentityAliases([
    buildSourceServerWorkspaceIdentityAliases(settings.sourceServerWorkspaceHistory ?? []),
    buildSourceProfileWorkspaceIdentityAliases(
      settings.sourceServerWorkspaceHistory ?? [],
      settings.connectionProfiles ?? [],
    ),
  ]);
  const conversationAliases = buildSourceConversationWorkspaceIdentityAliases(settings);

  const result: PersistedWorkspaceSessionEntry[] = [];
  const remoteIndexByKey = new Map<string, number>();
  for (const entry of settings.lastWorkspaceSession ?? []) {
    if (entry.kind === "local") {
      result.push(entry);
      continue;
    }
    const currentIdentity = resolveRemoteWorkspaceSessionIdentity(entry);
    const aliasKey = `${entry.workspacePath}\0${currentIdentity}`;
    const projectAlias = projectAliases.get(aliasKey);
    const conversationAlias = conversationAliases.get(aliasKey);
    // project history 与 device conversation map 理论上不会声明同一路径；旧数据若冲突，
    // 保持 legacy identity fail-closed，不能把 workspace 猜到任一 Source。
    // [契约] project 与 conversation 冲突时保持 legacy fail-closed，不猜 Source。
    // 唯一命中才迁移，命中两个以上一律放弃，这是数据安全优先的权衡。
    // 改错故障：冲突时任选其一会让用户打开错误的远端工作区。
    const stableAlias =
      projectAlias && conversationAlias && projectAlias !== conversationAlias
        ? undefined
        : (projectAlias ?? conversationAlias);
    const normalized = stableAlias
      ? {
          ...entry,
          workspaceIdentity: stableAlias,
          ...(conversationAlias === stableAlias
            ? { workspacePurpose: "conversation" as const }
            : {}),
        }
      : entry;
    const workspaceKey = buildWorkspaceSessionKey(normalized);
    const existingIndex = remoteIndexByKey.get(workspaceKey);
    if (existingIndex === undefined) {
      remoteIndexByKey.set(workspaceKey, result.length);
      result.push(normalized);
      continue;
    }
    const existing = result[existingIndex];
    if (existing?.kind === "remote" && normalized.lastOpenedAt > existing.lastOpenedAt) {
      result[existingIndex] = {
        ...existing,
        ...normalized,
        localWorkspacePath: normalized.localWorkspacePath ?? existing.localWorkspacePath,
      };
    }
  }
  return result;
}

// [契约] 只为 legacy 与 stable 都存在且不同的记录建立别名。
// 相等时不建别名，否则会产生自我映射并在合并阶段被当作冲突丢弃。
// 改错故障：不过滤相等项会让所有正常记录变成候选，别名表整体失效。
function buildSourceServerWorkspaceIdentityAliases(
  historyEntries: NonNullable<AppSettings["sourceServerWorkspaceHistory"]>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const history of historyEntries) {
    const legacyIdentity = history.legacyWorkspaceIdentity?.trim();
    const stableIdentity = history.workspaceIdentity?.trim();
    if (legacyIdentity && stableIdentity && legacyIdentity !== stableIdentity) {
      aliases.set(`${history.workspacePath}\0${legacyIdentity}`, stableIdentity);
    }
  }
  return aliases;
}

// [契约] conversation 不进 project history，只能从 Profile 与会话映射反推。
// retired 的 Profile 不参与，避免已下线设备继续影响身份判定。
// 改错故障：包含 retired 会让同一路径出现两个候选，映射被整体丢弃。
function buildSourceConversationWorkspaceIdentityAliases(
  settings: Pick<AppSettings, "connectionProfiles" | "remoteConversationWorkspaceBySourceServerId">,
): Map<string, string> {
  const candidatesByAlias = new Map<string, Set<string>>();
  for (const profile of settings.connectionProfiles ?? []) {
    const sourceServerId = profile.sourceServerId?.trim();
    if (!sourceServerId || profile.lifecycleState === "retired") {
      continue;
    }
    const workspacePath =
      settings.remoteConversationWorkspaceBySourceServerId?.[sourceServerId]?.workspacePath;
    if (!workspacePath) continue;

    // Bug 原因：rollback writer 必须为旧 Desktop 写 route identity，但 conversation
    // 按合同不进入 project history，reader 过去没有逆映射来源，重启后只能恢复成 pending tab。
    // 这里同时要求已绑定 Profile 的精确 authority 与设备级 canonical path，且只接受唯一 Source。
    const legacyIdentity = buildRemoteWorkspaceIdentity(workspacePath, profile.target);
    const stableIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath,
    });
    const aliasKey = `${workspacePath}\0${legacyIdentity}`;
    const candidates = candidatesByAlias.get(aliasKey) ?? new Set<string>();
    candidates.add(stableIdentity);
    candidatesByAlias.set(aliasKey, candidates);
  }

  const aliases = new Map<string, string>();
  for (const [aliasKey, candidates] of candidatesByAlias) {
    if (candidates.size !== 1) continue;
    const stableIdentity = candidates.values().next().value;
    if (stableIdentity) aliases.set(aliasKey, stableIdentity);
  }
  return aliases;
}

// [契约] 按 sourceServerId 关联 history 与 Profile，跨 Source 不得混用。
// 要求 profile.sourceServerId 精确相等，仅名称相同不算匹配。
// 改错故障：按 name 关联会让重名设备把身份迁移到错误的 workspace。
function buildSourceProfileWorkspaceIdentityAliases(
  historyEntries: NonNullable<AppSettings["sourceServerWorkspaceHistory"]>,
  profiles: NonNullable<AppSettings["connectionProfiles"]>,
): Map<string, string> {
  const candidatesByAlias = new Map<string, Set<string>>();
  for (const history of historyEntries) {
    const sourceServerId = history.sourceServerId?.trim();
    if (!sourceServerId) continue;
    const stableIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath: history.workspacePath,
    });
    for (const profile of profiles) {
      if (
        profile.lifecycleState === "retired" ||
        profile.sourceServerId?.trim() !== sourceServerId
      ) {
        continue;
      }
      const legacyIdentity = buildRemoteWorkspaceIdentity(history.workspacePath, profile.target);
      if (legacyIdentity === stableIdentity) continue;
      const aliasKey = `${history.workspacePath}\0${legacyIdentity}`;
      const candidates = candidatesByAlias.get(aliasKey) ?? new Set<string>();
      candidates.add(stableIdentity);
      candidatesByAlias.set(aliasKey, candidates);
    }
  }

  const aliases = new Map<string, string>();
  for (const [aliasKey, candidates] of candidatesByAlias) {
    if (candidates.size !== 1) continue;
    const stableIdentity = candidates.values().next().value;
    if (stableIdentity) aliases.set(aliasKey, stableIdentity);
  }
  return aliases;
}

// [契约] 合并后只保留唯一候选的别名，多候选一律丢弃，即 fail-closed。
// `mergeIdentityAliases` 是三张别名表的统一裁决点，调用方不得二次覆盖。
// 改错故障：保留多候选会让同一 legacy identity 指向多个 stable identity。
function mergeIdentityAliases(
  aliasMaps: readonly ReadonlyMap<string, string>[],
): Map<string, string> {
  const candidatesByAlias = new Map<string, Set<string>>();
  for (const aliasMap of aliasMaps) {
    for (const [aliasKey, stableIdentity] of aliasMap) {
      const candidates = candidatesByAlias.get(aliasKey) ?? new Set<string>();
      candidates.add(stableIdentity);
      candidatesByAlias.set(aliasKey, candidates);
    }
  }
  const aliases = new Map<string, string>();
  for (const [aliasKey, candidates] of candidatesByAlias) {
    if (candidates.size !== 1) continue;
    const stableIdentity = candidates.values().next().value;
    if (stableIdentity) aliases.set(aliasKey, stableIdentity);
  }
  return aliases;
}

// [契约] rekey 记录供上层同步改写 tab、队列与缓存中的 key。
// previousWorkspaceIdentity 必须是旧值原文，不能被归一化或 trim。
// 改错故障：归一化旧值会让上层找不到需要改写的既有条目。
export interface RemoteWorkspaceSessionIdentityRekey {
  workspacePath: string;
  previousWorkspaceIdentity: string;
  workspaceIdentity: string;
}

// [契约] 同时返回改写后的 sessions 与 rekey 列表，两者必须出自同一轮计算。
// 入参兼容数组与 settings 两种形态，源于历史调用方并存。
// 改错故障：两次独立计算会让 rekey 与实际写入的 identity 不一致。
export function projectRemoteWorkspaceSessionIdentityAliases(
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
  sourceServerWorkspaceHistoryOrSettings:
    | NonNullable<AppSettings["sourceServerWorkspaceHistory"]>
    | Pick<
        AppSettings,
        | "sourceServerWorkspaceHistory"
        | "connectionProfiles"
        | "remoteConversationWorkspaceBySourceServerId"
      >,
): {
  remoteSessions: RemoteWorkspaceSessionEntry[];
  identityRekeys: RemoteWorkspaceSessionIdentityRekey[];
} {
  const sourceServerWorkspaceHistory = Array.isArray(sourceServerWorkspaceHistoryOrSettings)
    ? sourceServerWorkspaceHistoryOrSettings
    : (sourceServerWorkspaceHistoryOrSettings.sourceServerWorkspaceHistory ?? []);
  const settings: Pick<
    AppSettings,
    | "sourceServerWorkspaceHistory"
    | "connectionProfiles"
    | "remoteConversationWorkspaceBySourceServerId"
  > = Array.isArray(sourceServerWorkspaceHistoryOrSettings)
    ? {}
    : sourceServerWorkspaceHistoryOrSettings;
  // [契约] 三张别名表顺序无关，冲突由 merge 统一裁决为 undefined。
  // 新增表时必须同时评估它与已有表的冲突语义，而不是追加优先级。
  // 改错故障：直接用新表结果覆盖旧表会绕过唯一性裁决。
  const aliases = mergeIdentityAliases([
    buildSourceServerWorkspaceIdentityAliases(sourceServerWorkspaceHistory),
    buildSourceProfileWorkspaceIdentityAliases(
      sourceServerWorkspaceHistory,
      settings.connectionProfiles ?? [],
    ),
    buildSourceConversationWorkspaceIdentityAliases({
      connectionProfiles: settings.connectionProfiles ?? [],
      remoteConversationWorkspaceBySourceServerId:
        settings.remoteConversationWorkspaceBySourceServerId,
    }),
  ]);
  // [契约] 只为真正命中的别名生成 rekey，未命中返回空数组而不是空对象。
  // previousWorkspaceIdentity 取解析值，兼容旧数据缺字段的情况。
  // 改错故障：对未命中项也生成 rekey 会让上层把 key 改写成错误值。
  const identityRekeys = remoteSessions.flatMap((entry) => {
    const previousWorkspaceIdentity = resolveRemoteWorkspaceSessionIdentity(entry);
    const workspaceIdentity = aliases.get(`${entry.workspacePath}\0${previousWorkspaceIdentity}`);
    return workspaceIdentity
      ? [
          {
            workspacePath: entry.workspacePath,
            previousWorkspaceIdentity,
            workspaceIdentity,
          },
        ]
      : [];
  });
  const projectedEntries = readPersistedWorkspaceSessionEntries({
    lastWorkspaceSession: [...remoteSessions],
    sourceServerWorkspaceHistory,
    ...(settings.connectionProfiles ? { connectionProfiles: settings.connectionProfiles } : {}),
    ...(settings.remoteConversationWorkspaceBySourceServerId
      ? {
          remoteConversationWorkspaceBySourceServerId:
            settings.remoteConversationWorkspaceBySourceServerId,
        }
      : {}),
  });
  return {
    remoteSessions: projectedEntries.flatMap((entry) => (entry.kind === "remote" ? [entry] : [])),
    identityRekeys,
  };
}

// [契约] 复用 readPersisted 做投影，不另写一套解析逻辑。
// 过滤掉 local 条目，保证调用方拿到的全部是 remote。
// 改错故障：自行解析会与持久化口径分叉，导致列表与磁盘不一致。
export function getRemoteWorkspaceSessionEntries(
  settings: Pick<
    AppSettings,
    | "lastWorkspaceSession"
    | "sourceServerWorkspaceHistory"
    | "connectionProfiles"
    | "remoteConversationWorkspaceBySourceServerId"
  >,
): RemoteWorkspaceSessionEntry[] {
  return readPersistedWorkspaceSessionEntries(settings).flatMap((entry) =>
    entry.kind === "remote" ? [entry] : [],
  );
}

// [契约] 以 buildWorkspaceSessionKey 为键建 Map，后者覆盖前者。
// 同一 key 出现多条说明上游未去重，本函数不做二次裁决。
// 改错故障：用 workspacePath 当键会让多条远端条目互相覆盖。
export function buildRemoteWorkspaceSessionEntryMap(
  entries: readonly RemoteWorkspaceSessionEntry[],
): Map<string, RemoteWorkspaceSessionEntry> {
  return new Map(entries.map((entry) => [buildWorkspaceSessionKey(entry), entry] as const));
}
