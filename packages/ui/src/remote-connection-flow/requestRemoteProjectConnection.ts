// INV-01 过期调用直接返回：守住位置 入口与 catch 内的 isCurrent；改错故障 已切走的项目被旧请求继续推进。
// INV-02 交接只认等待前目标：守住位置 failedTarget 的三重判定；改错故障 升级失败后按新 Profile 重新选址。
// INV-03 WSL 目标需 distro 与 user 双齐：守住位置 括号内的两段 trim；改错故障 半配置目标被当成可升级。
// INV-04 server 目标不参与升级：守住位置 kind 不等于 server；改错故障 本机服务器被要求走 Source 升级。
// INV-05 失败与待处理都交给向导：守住位置 status 的双等值；改错故障 待安装状态被静默重连。
// INV-06 等待动作到错误码的映射固定：守住位置 waitingCode 五键；改错故障 向导打开时没有初始原因。
// INV-07 显式错误码优先于推导：守住位置 failure 的 code 短路；改错故障 上游给出的具体原因被泛化覆盖。
// INV-08 升级类失败携带失败目标：守住位置 failedTarget 的展开；改错故障 用户看不出是哪台主机升级失败。
// INV-09 重连选项集中在此：守住位置 reconnect 实参；改错故障 各调用方各自决定是否抛错，行为漂移。
// INV-10 失败后按错误码重新归类：守住位置 catch 内的 resolveRemoteConnectionPresentation；改错故障 需交互的失败被当成普通失败吞掉。
// INV-11 只有 pending 才升级为向导：守住位置 status 等值判断；改错故障 所有错误都弹窗，或该弹的都不弹。
// INV-12 profileId 必须过类型判断：守住位置 in 与 typeof 双检；改错故障 任意字段被当作线路 id 透传。
// INV-13 WSL 解析结果先校验再采用：守住位置 safeParse；改错故障 畸形的 resolvedWslTarget 进入向导。
// INV-14 普通失败不重复提示：守住位置 末尾无 else 分支；改错故障 项目行与弹窗各报一次错。
//
// 模块职责：把一次远程项目连接请求分派到重连或连接向导，并保留失败上下文。
// 阅读顺序：先看入口与目标判定，再看 pending 与 failed 的向导分支，最后看 catch 内的二次归类。
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import type { ReconnectRemoteWorkspaceOptions } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  getSourceServerUpdateTarget,
  hostRemoteWorkspaceConnectFailedResponseSchema,
} from "@zcode/shared";

/** 只分派用户意图；连接状态、失败和日志仍归 Root/Host，向导仅接管需要交互的流程。 */
// 入口先做一次 `preference` 时效检查，过期即弃。
export async function requestRemoteProjectConnection({
  preference,
  presentation,
  failure,
  reconnect,
  openWizard,
  isCurrent = () => true,
}: {
  preference: RemoteConnectionOpenPreference;
  presentation: RemoteConnectionPresentation;
  failure?: RemoteConnectionOpenPreference["initialFailure"];
  reconnect: (options: ReconnectRemoteWorkspaceOptions) => Promise<void>;
  openWizard: (preference: RemoteConnectionOpenPreference) => void;
  isCurrent?: () => boolean;
}) {
  // 同一检查在异步失败后还要再执行一次。
  if (!isCurrent()) return;
  const target = preference.preferredTarget;
  // 原项目等待 reconnect 期间 Profile 可被编辑；交接必须携带等待前的目标，不能重新选址。
  // 升级失败要带回的目标，需同时满足类型与完整度。
  const failedTarget =
    target &&
    target.kind !== "server" &&
    (target.kind !== "wsl" || (target.distro?.trim() && target.user?.trim()))
      ? getSourceServerUpdateTarget(target)
      : undefined;
  // 失败与待处理都需要用户交互，统一交给向导。
  if (presentation.status === "failed" || presentation.status === "pending") {
    const waitingCode: Partial<Record<RemoteConnectionPresentation["primaryAction"], string>> = {
      // 每种主操作对应一个初始错误码。
      install: "source-server-install-required",
      "update-server": "source-server-upgrade-required",
      "update-desktop": "source-server-upgrade-required",
      "confirm-identity": "source-server-identity-change-pending",
      credentials: "credentials-required",
    };
    // 显式错误码优先，缺省才用推导值。
    const code = failure?.code ?? waitingCode[presentation.primaryAction];
    openWizard({
      ...preference,
      initialFailure: {
        message: failure?.message ?? "",
        ...(code === "source-server-upgrade-required" && failedTarget ? { failedTarget } : {}),
        ...failure,
        code,
      },
    });
    return;
  }
  try {
    // 重连选项写死在此，避免调用方漂移。
    await reconnect({
      activateWorkspaceAfterReconnect: false,
      showErrorToast: false,
      throwOnFailure: true,
      requireStoredCredentials: true,
    });
  // 其余失败由重连 owner 负责写回项目行。
  } catch (error) {
    if (!isCurrent()) return;
    const code =
      // 从错误对象里提取机器可读的 code。
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (
      resolveRemoteConnectionPresentation({ errorCode: code, error: getErrorMessage(error) })
        // 按 `errorCode` 重新归类，判断是否仍需交互。
        .status === "pending"
    ) {
      // 线路 id 要类型收窄后才能透传。
      const profileId =
        error &&
        typeof error === "object" &&
        "profileId" in error &&
        typeof error.profileId === "string"
          ? error.profileId
          : undefined;
      const resolvedWslTarget =
        // WSL 解析结果来自宿主机，必须先校验。
        hostRemoteWorkspaceConnectFailedResponseSchema.shape.resolvedWslTarget.safeParse(
          (code === "source-server-install-required" ||
            code === "source-server-upgrade-required") &&
            error &&
            typeof error === "object" &&
            "resolvedWslTarget" in error
            ? error.resolvedWslTarget
            : undefined,
        );
      openWizard({
        ...preference,
        initialFailure: {
          code,
          message: getErrorMessage(error),
          ...(profileId ? { profileId } : {}),
          ...(code === "source-server-upgrade-required" && failedTarget ? { failedTarget } : {}),
          // 成功解析后，升级失败目标改由解析结果推导。
          ...(resolvedWslTarget.success && resolvedWslTarget.data
            ? {
                resolvedWslTarget: resolvedWslTarget.data,
                ...(code === "source-server-upgrade-required"
                  ? { failedTarget: getSourceServerUpdateTarget(resolvedWslTarget.data) }
                  : {}),
              }
            : {}),
        },
      });
    }
    // 普通失败已由重连 owner 写回项目行；用户查看前不弹窗，也不再发起请求。
  }
}
