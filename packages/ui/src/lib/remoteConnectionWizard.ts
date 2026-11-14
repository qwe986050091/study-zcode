// 远程连接向导的纯函数层：负责步骤文案、表单校验、目标构造、已保存线路映射与粘贴解析。
// 不发起连接、不读写凭据存储、不持有 React 状态；产物交给向导 hook 与主进程 schema 校验。
// 不负责连接生命周期与重试编排、凭据权威解析（Host Directory）、资源包内容定义（shared 包）。
//
// INV-01 断言：步骤文案只依赖 step 与 kind，不读取连接运行时状态 —— 守住它的位置：getRemoteWizardStepCopy 的 switch —— 改错故障：重连或断开时文案闪烁，用户看到错乱的步骤标题。
// INV-02 断言：connecting 副题优先级固定为 cancelled 高于 updating、updating 高于 hasError、hasError 高于 connectionReady —— 守住它的位置：case "connecting" 的嵌套三元 —— 改错故障：取消后仍显示旧失败原因，用户以为取消失败。
// INV-03 断言：directory 副题优先使用 deviceName，其次 lineName —— 守住它的位置：case "directory" 的 method 取值 —— 改错故障：目录页显示 ssh 别名而非设备名，与原型文案不一致。
// INV-04 断言：已退役线路不参与任何推荐与匹配 —— 守住它的位置：activeProfiles 过滤与 findSourceServerUpgradeProfileId 的 lifecycleState 判断 —— 改错故障：退役线路被自动选中，连接直接失败。
// INV-05 断言：端口校验与端口构造读取同一个 trim 值 —— 守住它的位置：isInvalidPort 调用处与 buildRemoteTarget 的 port 局部量 —— 改错故障：仅填空格时校验放行，数值化为 0，请求被 schema 拒绝。
// INV-06 断言：端口合法区间为 1 到 65535 且只接受纯数字 —— 守住它的位置：isInvalidPort 与 parsePort —— 改错故障：粘贴 70000 或 22a 被接受，握手阶段才报错。
// INV-07 断言：空端口视为未填写，回落 22，而不是错误 —— 守住它的位置：isInvalidPort 的空值短路与 buildRemoteTarget 的 port 三元 —— 改错故障：默认端口场景被拦截，用户无法提交。
// INV-08 断言：表单错误按页面从上到下顺序返回，且不短路 —— 守住它的位置：collectRemoteFormFieldErrors 的 add 调用顺序 —— 改错故障：首个可见错误跳变，用户修正后焦点乱跳。
// INV-09 断言：提交只取第一条错误，展示取全部 —— 守住它的位置：buildRemoteTarget 的解构首元素 —— 改错故障：错误提示被最后一条覆盖，与实际阻断原因不符。
// INV-10 断言：编辑已保存密码时空密码表示沿用旧凭据 —— 守住它的位置：passwordOptional 分支 —— 改错故障：编辑无关字段被迫重输密码。
// INV-11 断言：SSH 凭据字段按认证方式互斥注入 —— 守住它的位置：password 与 privateKeyPath 的条件展开 —— 改错故障：切换认证方式后旧密码随目标下发。
// INV-12 断言：docker 手动输入优先于下拉选择 —— 守住它的位置：buildRemoteTarget 的 dockerContainer 赋值 —— 改错故障：探测列表陈旧时提交了错误容器。
// INV-13 断言：server 目标字段 trim 后为空则不下发 —— 守住它的位置：server 分支的条件展开 —— 改错故障：空字符串覆盖服务端默认工作区。
// INV-14 断言：非 ssh 目标原样返回，不注入资源包 —— 守住它的位置：withDefaultRemoteResourcePackages 的 kind 短路 —— 改错故障：docker 或 wsl 目标带上非法 resourcePackages 字段。
// INV-15 断言：ssh 资源包始终取默认 active 集合，忽略历史选择 —— 守住它的位置：normalizeRemoteResourcePackageSelection 调用 —— 改错故障：旧选择缩小部署范围，Agent 缺件启动。
// INV-16 断言：从已保存线路重建的目标不含任何凭据 —— 守住它的位置：buildRemoteTargetFromProfile 的字段白名单 —— 改错故障：密码进入 UI 层状态或日志。
// INV-17 断言：线路匹配只比较 host、port、username、alias 等身份字段 —— 守住它的位置：profileMatchesRemoteTarget —— 改错故障：仅安装模式不同被判为同一线路，复用错误配置。
// INV-18 断言：仅 required 且 upgradeTarget 为 server 的状态参与升级推荐 —— 守住它的位置：findSourceServerUpgradeProfileId 的 filter —— 改错故障：可选升级弹窗打断正常连接。
// INV-19 断言：粘贴解析只认白名单形态，其余原样交给浏览器 —— 守住它的位置：parseSshPasteTarget 各处 return null —— 改错故障：含 -i、-J 的命令被误拆，连接到了错误主机。
// INV-20 断言：IPv6 方括号在解析结果中去掉，端口单独拆出 —— 守住它的位置：parseUserHostPort 的 host 归一 —— 改错故障：方括号残留导致主机名非法。
//
// 维护提示：新增表单字段需同时登记不变量，并同步 collectRemoteFormFieldErrors 与 buildRemoteTarget 的同名分支。
import type {
  ConnectionProfile,
  RemoteAssetInstallMode,
  RemoteTarget,
  SourceServerManagementSnapshot,
} from "@zcode/shared";
import { isValidWslUser, normalizeRemoteResourcePackageSelection } from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

type WizardIntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

export interface RemoteConnectionFormSnapshot {
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode?: RemoteAssetInstallMode;
  selectedSshConfigAlias?: string | null;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslUser?: string;
  dockerContainer: string;
  manualDockerContainer?: string;
  serverUrl?: string;
  serverName?: string;
  serverToken?: string;
  serverWorkspacePath?: string;
}

// 步骤文案的唯一出口：device、settings、connecting、directory 四步，其余步骤由调用方自行渲染。
// kind 仅用于缺失线路名和设备名时回退 remote.kind 文案，缺翻译时 intl 会原样暴露 key。
// [权衡] settings 步的 description 固定为空串而非缺省，避免头部预览与说明句重叠（RDUX-27）。
// 不要在这里读 store 或连接状态：本函数被连接页与编辑弹窗同时调用，纯函数才能复用。
export function getRemoteWizardStepCopy(
  intl: WizardIntlLike,
  step: RemoteWizardStep,
  kind: RemoteTarget["kind"],
  context?: {
    /** 线路名（SSH alias / 线路 displayName），缺省回退 user@host:port 由调用方拼好传入。 */
    lineName?: string;
    /** 已识别设备名，用于第 4 步成功副题与第 5 步「在 {device} 上选择目录」。 */
    deviceName?: string;
    connectionReady?: boolean;
    hasError?: boolean;
    updating?: boolean;
    cancelled?: boolean;
  },
) {
  switch (step) {
    case "device":
      return {
        title: intl.formatMessage({ id: "remote.deviceStepTitle" }),
        description: intl.formatMessage({ id: "remote.deviceStepDescription" }),
      };
    case "settings":
      // 表单屏不再显示说明句，头部改为实时目标预览（RDUX-27）。
      return {
        title: intl.formatMessage({ id: "remote.settingsStepTitle" }),
        description: "",
      };
    // [契约] 副题优先级 cancelled 高于 updating、高于 hasError、高于 connectionReady，顺序即业务优先级。
    // 取消后恢复升级错误是刻意保留的：cancelled 必须压过 hasError，否则用户取消后仍看到失败原因。
    // 更新期间优先展示当前操作，避免沿用上一轮失败副题造成「正在更新却写着连接失败」。
    // connected 分支的设备名回退链是 deviceName 到 lineName 再到 kind 文案，任一层都不要删。
    case "connecting": {
      // 需升级错误保留供取消后恢复；更新期间优先展示当前操作，避免沿用旧失败副题。
      const description = context?.cancelled
        ? intl.formatMessage({ id: "remote.connectionCancelled" })
        : context?.updating
          ? intl.formatMessage({ id: "remote.connectingSubtitleUpdating" })
          : context?.hasError
            ? intl.formatMessage({ id: "remote.connectingSubtitleFailed" })
            : context?.connectionReady
              ? intl.formatMessage(
                  { id: "remote.connectingSubtitleConnected" },
                  {
                    device:
                      context.deviceName ??
                      context.lineName ??
                      intl.formatMessage({ id: `remote.kind.${kind}` }),
                  },
                )
              : intl.formatMessage(
                  { id: "remote.connectingStepDescription" },
                  {
                    method: context?.lineName ?? intl.formatMessage({ id: `remote.kind.${kind}` }),
                  },
                );
      return {
        title: intl.formatMessage({ id: "remote.connectingStepTitle" }),
        description,
      };
    }
    // [契约] 副题里的占位优先填设备名，其次线路名，最后才是连接方式文案。
    // 原型文案是「在设备上选择一个目录」，填 SSH 别名会被读成在别名主机上，用户会误解目标。
    // deviceName 由第 4 步识别成功后传入，未识别时整条链逐级回退，不要改成空串。
    case "directory":
      return {
        title: intl.formatMessage({ id: "remote.selectDirectoryTitle" }),
        description: intl.formatMessage(
          { id: "remote.selectDirectoryDescription" },
          {
            // 原型副题是「在 dev 上选择一个目录作为工作区」——传设备名而非连接方式名。
            method:
              context?.deviceName ??
              context?.lineName ??
              intl.formatMessage({ id: `remote.kind.${kind}` }),
          },
        ),
      };
  }
}

// 从 source server 的管理快照里挑出推荐线路：优先 server 记录的 preferredProfileId。
// preferredProfileId 指向已退役线路时视为无效，直接回退到第一条 active 线路，不要报错。
// 找不到 server 记录即返回 undefined，由调用方决定是否进入新建流程。
export function findPreferredSourceConnectionProfile(
  snapshot: Pick<SourceServerManagementSnapshot, "servers" | "profiles">,
  sourceServerId: string,
): ConnectionProfile | undefined {
  const server = snapshot.servers.find((candidate) => candidate.sourceServerId === sourceServerId);
  if (!server) return undefined;

  // [契约] retired 过滤必须发生在候选列表上，而不是只在回退处判断。
  // 否则 preferredProfileId 命中退役线路时会被当作有效推荐，用户点进去直接握手失败。
  // 过滤后保持快照原有顺序，activeProfiles 取首项的稳定性依赖源数组顺序。
  const activeProfiles = snapshot.profiles.filter(
    (profile) => profile.sourceServerId === sourceServerId && profile.lifecycleState !== "retired",
  );
  return (
    activeProfiles.find((profile) => profile.profileId === server.preferredProfileId) ??
    activeProfiles[0]
  );
}

/** 表单内可显示内联错误的字段；顺序即页面从上到下的顺序。 */
export type RemoteFormField =
  | "host"
  | "port"
  | "username"
  | "password"
  | "privateKey"
  | "docker"
  | "wslUser"
  | "serverUrl";

export interface RemoteFormFieldError {
  field: RemoteFormField;
  message: string;
}

// 空串不算非法：未填端口由 buildRemoteTarget 回落 22，校验层不要越权拦截。
// [契约] 只接受纯数字且落在 1 到 65535，正则先行避免数值转换对空格、科学计数法的宽松解释。
// 调用方必须先 trim 再传入，这里不重复 trim，保证与构造端读到同一个值。
function isInvalidPort(port: string): boolean {
  return Boolean(port) && (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535);
}

/**
 * 表单校验的唯一规则来源：按页面顺序返回全部字段错误。
 * 新建向导与编辑连接弹窗都用它渲染内联错误，buildRemoteTarget 只取第一条阻止提交。
 */
// 全文件唯一的表单规则来源：新建向导与编辑弹窗都靠它渲染内联错误，不要在别处复制判断。
// [契约] 返回全部错误且顺序即页面自上而下顺序，调用方按序取第一个可见错误定位焦点。
// 各 kind 分支只校验与该连接方式相关的字段，未使用的字段一律不报错，避免隐藏字段阻断提交。
// 规则变更必须同时看 buildRemoteTarget：它只消费第一条，两者不一致会出现无红框却提交失败。
export function collectRemoteFormFieldErrors(
  intl: WizardIntlLike,
  snapshot: RemoteConnectionFormSnapshot,
  options: {
    /** 编辑已保存密码的连接时，空密码表示沿用已保存凭据。 */
    passwordOptional?: boolean;
  } = {},
): RemoteFormFieldError[] {
  const errors: RemoteFormFieldError[] = [];
  // 消息在收集瞬间被格式化为字符串，调用方切换语言后需重新收集，否则残留旧语言文案。
  // field 与 message 成对写入，渲染层只按 field 定位，不解析文案内容。
  // add 只追加不覆盖，同字段可能对应多条错误，展示层自行合并。
  const add = (field: RemoteFormField, id: string) =>
    errors.push({ field, message: intl.formatMessage({ id }) });
  switch (snapshot.kind) {
    // [契约] ssh 的必填项顺序为 host、port、username，随后才是认证方式相关字段。
    // 密码必填仅在 password 认证下生效，编辑态由 passwordOptional 放行空密码沿用旧凭据。
    // 私钥认证只校验路径非空，文件是否可读交给主进程，UI 层不做 IO。
    case "ssh":
      if (!snapshot.host.trim()) add("host", "ssh.validation.hostRequired");
      if (isInvalidPort(snapshot.port.trim())) add("port", "ssh.validation.port");
      if (!snapshot.username.trim()) add("username", "ssh.validation.usernameRequired");
      if (
        snapshot.sshAuthMethod === "password" &&
        !snapshot.password &&
        !options.passwordOptional
      ) {
        add("password", "ssh.validation.passwordRequired");
      }
      if (snapshot.sshAuthMethod === "privateKey" && !snapshot.privateKeyPath.trim()) {
        add("privateKey", "ssh.validation.privateKeyRequired");
      }
      break;
    case "docker":
      if (!(snapshot.manualDockerContainer?.trim() || snapshot.dockerContainer.trim())) {
        add("docker", "docker.validation.required");
      }
      break;
    case "wsl": {
      const wslUser = snapshot.wslUser?.trim();
      if (wslUser && !isValidWslUser(wslUser)) add("wslUser", "wsl.validation.invalidUser");
      break;
    }
    // server 连接只需要一个可解析的 URL，名称、令牌、工作区都是可选项。
    // 用 URL 构造器做语法判定而非正则，兼容带端口的写法，异常即视为非法地址。
    // [失败路径] 只有构造异常才报非法地址，不要吞掉其他错误分支。
    case "server": {
      const url = snapshot.serverUrl?.trim() ?? "";
      if (!url) {
        add("serverUrl", "server.validation.urlRequired");
      } else {
        try {
          // [失败路径] 这里只用构造器做语法校验，不保留实例，也不发任何请求。
          // 构造器对缺协议、空主机等情况抛 TypeError，正是这里需要的拒绝信号。
          // 不要改成返回布尔值的辅助函数再包一层，异常路径就是唯一判定依据。
          new URL(url);
        } catch {
          add("serverUrl", "server.validation.invalidUrl");
        }
      }
      break;
    }
  }
  return errors;
}

/** 表单头部的实时目标预览，与连接页头部的等宽目标同构；缺少关键字段时返回 null。 */
// 表单头部的实时预览，与连接页展示的目标串同构，保证用户提交前后看到同一个东西。
// 缺少关键字段时返回 null 而不是占位串，调用方据此隐藏预览行。
// ssh 预览在用户名或端口为空时回落 user 和 22，仅为可读性，不影响真正的目标构造。
export function formatRemoteDraftPreview(snapshot: RemoteConnectionFormSnapshot): string | null {
  switch (snapshot.kind) {
    case "ssh": {
      const host = snapshot.host.trim();
      if (!host) return null;
      return `${snapshot.username.trim() || "user"}@${host}:${snapshot.port.trim() || 22}`;
    }
    // docker 的预览值就是容器名，手动输入优先，未填则回落到下拉选择。
    // 两者都为空返回 null，不显示空括号或未选择之类的占位。
    case "docker":
      return snapshot.manualDockerContainer?.trim() || snapshot.dockerContainer.trim() || null;
    case "wsl":
      return snapshot.wslDistro.trim() || null;
    case "server":
      return snapshot.serverUrl?.trim() || null;
  }
}

// 把表单快照转成可下发的连接目标，只取第一条校验错误阻断提交。
// [契约] 所有字符串字段都先 trim 再判断是否注入，空串不得作为字段值下发。
// 可选字段用条件展开而不是显式 undefined，避免 IPC 序列化后出现空键影响主进程判定。
// 任何新增字段都要在对应的校验分支里同时加上规则。
export function buildRemoteTarget(
  intl: WizardIntlLike,
  snapshot: RemoteConnectionFormSnapshot,
): { target?: RemoteTarget; errorMessage?: string } {
  const [firstError] = collectRemoteFormFieldErrors(intl, snapshot);
  if (firstError) return { errorMessage: firstError.message };
  switch (snapshot.kind) {
    case "ssh": {
      const sshConfigAlias = snapshot.selectedSshConfigAlias?.trim();
      // Bugfix: 校验读 trim 后的端口，这里曾读原值，只填空格时校验放行而 Number("   ") 得到 0，
      // 请求被主进程 schema 拒绝。构造与校验读取同一个 trim 值，空白等同未填写（默认 22）。
      const port = snapshot.port.trim();

      return {
        target: {
          kind: "ssh",
          host: snapshot.host.trim(),
          port: port ? Number(port) : undefined,
          username: snapshot.username.trim(),
          ...(sshConfigAlias ? { sshConfigAlias } : {}),
          assetInstallMode: snapshot.assetInstallMode,
          ...(snapshot.sshAuthMethod === "password" && snapshot.password
            ? { password: snapshot.password }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPath
            ? { privateKeyPath: snapshot.privateKeyPath }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPassphrase
            ? { privateKeyPassphrase: snapshot.privateKeyPassphrase }
            : {}),
        },
      };
    }
    // 运行中容器列表可能因探测失败或刷新延迟不完整，手动输入必须能独立于下拉生效。
    // [契约] 提交时手动输入优先，只有它为空才回落到下拉选择，顺序不能反。
    // `containerName` 的空值已由收集阶段拦下，构造阶段可直接取用 `settings.containerName`。
    // 不要把两个来源合并成数组或做模糊匹配，容器名是精确标识。
    case "docker": {
      // Docker 运行中列表可能因为探测失败或刷新延迟不完整。
      // 手动输入必须独立于下拉选择，提交时优先使用手动输入，空值再回落到下拉选择。
      const dockerContainer =
        snapshot.manualDockerContainer?.trim() || snapshot.dockerContainer.trim();

      return {
        target: {
          kind: "docker",
          container: dockerContainer,
        },
      };
    }
    case "wsl": {
      const wslUser = snapshot.wslUser?.trim();
      return {
        target: {
          kind: "wsl",
          distro: snapshot.wslDistro || undefined,
          ...(wslUser ? { user: wslUser } : {}),
        },
      };
    }
    case "server": {
      const url = snapshot.serverUrl?.trim() ?? "";
      const name = snapshot.serverName?.trim();
      const token = snapshot.serverToken?.trim();
      const workspacePath = snapshot.serverWorkspacePath?.trim();

      return {
        target: {
          kind: "server",
          url,
          ...(name ? { name } : {}),
          ...(token ? { token } : {}),
          ...(workspacePath ? { workspacePath } : {}),
        },
      };
    }
  }
}

// 只有 ssh 目标需要补资源包，docker、wsl、server 直接原样返回，避免多带无关字段。
// 当前分支只保留一个 ZCode Agent，再让用户挑资源包只会制造无意义分叉。
// [契约] 无论历史重连带过什么选择，都统一覆盖为默认 active 资源集。
// 覆盖而非合并是刻意的：合并旧选择会悄悄缩小部署范围，导致 Agent 缺件启动。
export function withDefaultRemoteResourcePackages(target: RemoteTarget): RemoteTarget {
  if (target.kind !== "ssh") {
    return target;
  }

  return {
    ...target,
    resourcePackages: {
      // 当前分支只保留一个 ZCode Agent，SSH 向导再让用户手动挑资源包会产生无意义分叉。
      // 这里统一走默认 active 资源集，历史重连传入的旧选择不再影响部署范围。
      selectedPackageIds: normalizeRemoteResourcePackageSelection(),
    },
  };
}

/** 将已保存线路转换成不含凭据的连接目标，凭据仍由 Host Directory 权威解析。 */
// 把已保存线路还原成连接目标，用于重连与匹配比对。
// [契约] 这里刻意不带密码、口令等凭据，凭据由 Host Directory 权威解析。
// 返回类型排除了 server，类型层面保证这里不会从线路里重建服务端连接。
export function buildRemoteTargetFromProfile(
  profile: ConnectionProfile,
): Exclude<RemoteTarget, { kind: "server" }> {
  switch (profile.target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: profile.target.host,
        ...(profile.target.port ? { port: profile.target.port } : {}),
        username: profile.target.username,
        ...(profile.target.sshConfigAlias ? { sshConfigAlias: profile.target.sshConfigAlias } : {}),
        ...(profile.target.privateKeyPath ? { privateKeyPath: profile.target.privateKeyPath } : {}),
        ...(profile.target.assetInstallMode
          ? { assetInstallMode: profile.target.assetInstallMode }
          : {}),
      };
    case "wsl":
      return {
        kind: "wsl",
        ...(profile.target.distro ? { distro: profile.target.distro } : {}),
        ...(profile.target.user ? { user: profile.target.user } : {}),
      };
    case "docker":
      return { kind: "docker", container: profile.target.container };
  }
}

// 判断一条已保存线路是否对应用户当前填写的目标，用于复用而不是新建重复线路。
// [契约] 只比较身份字段：host、端口、用户名、alias，或 distro、user，或容器名。
// 端口两侧都按 22 兜底，缺省与显式 22 视为同一条线路；安装模式不参与匹配。
export function profileMatchesRemoteTarget(
  profile: ConnectionProfile,
  target: Exclude<RemoteTarget, { kind: "server" }>,
): boolean {
  if (profile.target.kind !== target.kind) return false;
  switch (target.kind) {
    case "ssh":
      return (
        profile.target.kind === "ssh" &&
        profile.target.host === target.host &&
        (profile.target.port ?? 22) === (target.port ?? 22) &&
        profile.target.username === target.username &&
        (profile.target.sshConfigAlias?.trim() ?? "") === (target.sshConfigAlias?.trim() ?? "")
      );
    case "wsl":
      return (
        profile.target.kind === "wsl" &&
        (profile.target.distro?.trim() ?? "") === (target.distro?.trim() ?? "") &&
        (profile.target.user?.trim() ?? "") === (target.user?.trim() ?? "")
      );
    case "docker":
      return profile.target.kind === "docker" && profile.target.container === target.container;
  }
}

// 在需要强制升级的线路里挑一条可复用的候选，供连接前提示升级服务端。
// [契约] 只认 needs-upgrade、upgradeTarget 为 server、updateAvailability 为 required 三者同时成立的状态。
// 带 failedProfileId 时只看失败的那条线路，避免升级提示串到别的连接上。
// 按更新时间倒序取最新，时间相同则保留原顺序的第一条，结果才是确定的。
export function findSourceServerUpgradeProfileId(
  snapshot: SourceServerManagementSnapshot,
  target: Exclude<RemoteTarget, { kind: "server" }>,
  failedProfileId?: string,
): string | null {
  const requiredByProfileId = new Map(
    snapshot.states
      .filter(
        (state) =>
          state.state === "needs-upgrade" &&
          state.upgradeTarget === "server" &&
          state.updateAvailability === "required",
      )
      .map((state) => [state.profileId, state.updatedAt]),
  );
  return (
    snapshot.profiles
      .filter(
        (profile) =>
          (!failedProfileId || profile.profileId === failedProfileId) &&
          profile.lifecycleState !== "retired" &&
          requiredByProfileId.has(profile.profileId) &&
          profileMatchesRemoteTarget(profile, target),
      )
      .toSorted(
        (left, right) =>
          (requiredByProfileId.get(right.profileId) ?? 0) -
          (requiredByProfileId.get(left.profileId) ?? 0),
      )[0]?.profileId ?? null
  );
}

/** 从主机框粘贴的文本中拆出的 SSH 目标；缺省字段由用户继续填写。 */
export interface SshPasteTarget {
  host: string;
  username?: string;
  port?: string;
}

function parsePort(value: string | undefined): string | undefined | null {
  if (value == null) return undefined;
  if (!/^\d+$/u.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? String(port) : null;
}

// 解析单个 user@host 片段并可选带端口，IPv6 允许写成方括号形式。
// [契约] 用户名排除 @、空白、冒号与斜杠，避免把 ssh 协议前缀或密码吃成用户名。
// 端口非法时整体返回 null 而不是丢弃端口，否则会静默连到 22 端口。
function parseUserHostPort(value: string): SshPasteTarget | null {
  // Bugfix: 用户名曾允许 ":" 和 "/"，`ssh://user@host` 会拆出用户名 `ssh://user`，
  // `user:password@host` 会把密码填进用户名。这两类不在识别范围内，用户名排除这两个字符后原样粘贴。
  const match = /^(?:([^@\s:/]+)@)?(\[[^\]\s]+\]|[^:@\s[\]/]+)(?::([^:\s]+))?$/u.exec(value);
  if (!match) return null;
  const [, username, rawHost = "", rawPort] = match;
  const port = parsePort(rawPort);
  if (port === null) return null;
  const host = rawHost.startsWith("[") ? rawHost.slice(1, -1) : rawHost;
  return {
    host,
    ...(username ? { username } : {}),
    ...(port ? { port } : {}),
  };
}

/**
 * 只识别 `user@host`、`user@host:port`、`ssh [-p N] user@host [-p N]`（含 `[IPv6]:port`）。
 * 其他内容返回 null，由调用方交给浏览器原样粘贴；纯主机名没有可拆分的信息，同样返回 null。
 */
// 粘贴解析的入口：只识别 user@host、user@host:port 与 ssh 命令行两种形态。
// [契约] 其余内容一律返回 null，由调用方交给浏览器原样粘贴，不做猜测性修补。
// 纯主机名没有可拆分信息，同样返回 null，让用户继续手填。
// ssh 形态里遇到未知选项（如 -i、-J）立即放弃，因为这些选项会改变目标语义。
export function parseSshPasteTarget(text: string): SshPasteTarget | null {
  const trimmed = text.trim();
  const sshMatch = /^ssh\s+(.+)$/u.exec(trimmed);
  if (sshMatch) {
    const tokens = sshMatch[1]!.split(/\s+/u);
    let target: string | undefined;
    let portToken: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      // [契约] -p 后面必须紧跟端口值，缺失即整体放弃解析，不要猜端口。
      // 重复出现 -p 时后一个会覆盖前一个，这是有意宽容，真实 ssh 也是后者生效。
      // 已取到 target 后再遇到非选项 token 直接返回 null，命令里出现两个目标主机无法判定。
      if (token === "-p") {
        portToken = tokens[index + 1];
        if (portToken == null) return null;
        index += 1;
      } else if (token.startsWith("-") || target) {
        // 其他 ssh 选项可能改变目标语义（例如 -i、-J），不猜测，原样粘贴。
        return null;
      } else {
        target = token;
      }
    }
    // 只有选项没有目标（例如 ssh -v）时放弃解析，不能退回原始文本当主机。
    // 这里的端口来自 -p，与目标内联端口冲突时以 -p 为准，符合 ssh 行为。
    if (!target) return null;
    const parsed = parseUserHostPort(target);
    const port = parsePort(portToken);
    if (!parsed || port === null) return null;
    return port ? { ...parsed, port } : parsed;
  }
  const parsed = parseUserHostPort(trimmed);
  if (!parsed || (!parsed.username && !parsed.port)) return null;
  return parsed;
}
