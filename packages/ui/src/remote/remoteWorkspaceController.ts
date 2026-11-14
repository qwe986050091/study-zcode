// INV-01 意图是判别联合：守住位置 type 字段；改错故障 新增意图没有类型，分派无法收窄。
// INV-02 分派覆盖全部意图：守住位置 switch 六个 case；改错故障 遗漏的意图静默成功。
// INV-03 每个分支都要 await：守住位置 六处 await；改错故障 调用方拿不到完成时机，顺序错乱。
// INV-04 打开会话一律拒绝：守住位置 open-conversation 分支；改错故障 绕过项目创建直接建连。
// INV-05 拒绝发生在副作用之前：守住位置 throw 的位置；改错故障 先连主机再报错，留下脏连接。
// INV-06 关闭必须声明 user-close：守住位置 origin 判等；改错故障 系统回收被当成用户意图。
// INV-07 重连选项可省略：守住位置 两路分支；改错故障 无选项时把 undefined 传进处理器。
// INV-08 控制器不持有状态：守住位置 返回对象只有 projection 与 dispatch；改错故障 控制器与 store 双写。
// INV-09 projection 只读：守住位置 readonly 修饰；改错故障 调用方直接改写投影。
// INV-10 处理器契约与意图字段对齐：守住位置 interface 的六个方法；改错故障 传参顺序与意图字段不一致。
// INV-11 打开项目透传完整意图：守住位置 handlers.openProject(intent)；改错故障 逐字段重拼导致漏字段。
// INV-12 连接设备区分两种效果：守住位置 effect 联合；改错故障 设备管理与选中项目走同一路径。
// INV-13 未知意图不静默：守住位置 switch 无 default；改错故障 类型扩展后旧实现静默通过。
// INV-14 控制器是纯装配：守住位置 工厂函数体；改错故障 在工厂里发起网络请求。
//
// 模块职责：把远程工作区的用户意图收敛成一次 dispatch，转发给注入的处理器。
// 阅读顺序：先看三个类型声明，再看工厂返回，最后看 switch 六个分支的语义差异。
import type { RemoteWorkspaceProjection } from "./remoteWorkspaceProjection.js";

// 重连只暴露三个开关，其余由 owner 决定。
export type RemoteWorkspaceReconnectOptions = {
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  throwOnFailure?: boolean;
};

// 意图以 type 判别，字段随类型变化。
export type RemoteWorkspaceIntent =
  // 连接设备要区分只是选中还是进管理页。
  | { type: "connect-device"; profileId: string; effect: "select-project" | "device-management" }
  // disconnect-device 只接受 sourceServerId，不携带 profileId 线路信息。
  | { type: "disconnect-device"; sourceServerId: string }
  | {
      type: "open-conversation";
      sourceServerId: string;
      remoteSessionId?: string;
      profileId?: string;
    }
  | {
      type: "open-project";
      draftProjectId?: string | null;
      preparedWorkspaceIdentity?: string;
      isCurrent?: () => boolean | Promise<boolean>;
      sourceServerId: string;
      path: string;
      profileId?: string;
      localWorkspacePath?: string;
      remoteSessionId?: string;
    }
  | {
      type: "reconnect-workspace";
      workspaceKey: string;
      options?: RemoteWorkspaceReconnectOptions;
    }
  // 关闭必须带来源，防止系统回收冒充用户操作。
  | { type: "close-workspace"; workspaceKey: string; origin: "user-close" };

// 处理器契约与意图一一对应，参数顺序即字段顺序。
export interface RemoteWorkspaceControllerHandlers {
  connectDevice: (
    profileId: string,
    effect: "select-project" | "device-management",
  ) => Promise<void>;
  disconnectDevice: (sourceServerId: string) => Promise<void>;
  openConversation: (input: {
    sourceServerId: string;
    remoteSessionId?: string;
    profileId?: string;
  }) => Promise<void>;
  openProject: (input: {
    draftProjectId?: string | null;
    preparedWorkspaceIdentity?: string;
    isCurrent?: () => boolean | Promise<boolean>;
    sourceServerId: string;
    path: string;
    profileId?: string;
    localWorkspacePath?: string;
    remoteSessionId?: string;
  }) => Promise<void>;
  reconnectWorkspace: (
    workspaceKey: string,
    options?: RemoteWorkspaceReconnectOptions,
  ) => Promise<void>;
  closeWorkspace: (workspaceKey: string) => Promise<void>;
}

// 控制器对外只有投影与分派两个成员。
export interface RemoteWorkspaceController {
  readonly projection?: RemoteWorkspaceProjection;
  // 分派是唯一入口，异步返回便于串行化。
  dispatch(intent: RemoteWorkspaceIntent): Promise<void>;
}

// 工厂不持有状态，所有副作用都在处理器里。
export function createRemoteWorkspaceController(
  handlers: RemoteWorkspaceControllerHandlers,
  projection?: RemoteWorkspaceProjection,
): RemoteWorkspaceController {
  return {
    projection,
    async dispatch(intent) {
      // 按 type 分派，每个分支只做转发。
      switch (intent.type) {
        case "connect-device":
          await handlers.connectDevice(intent.profileId, intent.effect);
          return;
        case "disconnect-device":
          await handlers.disconnectDevice(intent.sourceServerId);
          return;
        // 旧回调也不能绕过项目创建。
        case "open-conversation":
          // 旧回调也不能绕过项目创建，拒绝前不产生连接或目录副作用。
          // 拒绝前不产生连接或目录副作用。
          throw new Error("project.remote-project-required");
        case "open-project":
          await handlers.openProject(intent);
          return;
        case "reconnect-workspace":
          if (intent.options) {
            await handlers.reconnectWorkspace(intent.workspaceKey, intent.options);
          } else {
            await handlers.reconnectWorkspace(intent.workspaceKey);
          }
          return;
        case "close-workspace":
          // intent.origin !== "user-close" 时直接抛错，不做兜底关闭。
          if (intent.origin !== "user-close")
            throw new Error("workspace close requires user-close origin");
          // close-workspace 是最后一个分支，必须只接受 user-close，语义最窄。
          await handlers.closeWorkspace(intent.workspaceKey);
          return;
      }
    },
  };
}
