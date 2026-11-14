import type { DynamicWorkflowMode, RemoteTarget } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";

// 只有 desktop-attached 的 remote Host 需要桌面推送；standalone server 有自己的设置权威。
// 过滤 condition 刻意放在外层：server target 连 onError 都不触发，避免把正常情况记成错误。
// 每个连接独立 try/catch：旧版远端不认识该方法只影响自己，不阻断其他连接建立。
/**
 * 把动态工作流的用户选择推给远程 Host（docs/dynamic-workflow/launch.md「The user's choice」）。
 *
 * desktop-attached remote Host（SSH / WSL / Docker）读不到桌面的设置文件，选择只能由 desktop 推送：
 * 建远程 workspace services 时推一次，本机 Host 收到选择变化信号后再推给本窗口所有在线连接。
 * standalone server 有自己的设置权威，不推。单个连接失败（旧版本不认识该方法、连接已断）只上报，
 * 不影响其它连接，也不阻断远程连接建立。
 */
export async function pushDynamicWorkflowUserModeToRemoteHosts(
  connections: ReadonlyArray<{
    target: RemoteTarget;
    zcodeAgentService: Pick<IZCodeAgentService, "syncDynamicWorkflowUserMode">;
  }>,
  mode: DynamicWorkflowMode | undefined,
  onError: (error: unknown) => void,
): Promise<void> {
  await Promise.all(
    connections
      .filter((connection) => connection.target.kind !== "server")
      .map(async (connection) => {
        try {
          await connection.zcodeAgentService.syncDynamicWorkflowUserMode(mode ? { mode } : {});
        } catch (error) {
          onError(error);
        }
      }),
  );
}
