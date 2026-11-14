// INV-01 订阅在 effect 内建立且必须由返回的清理函数解绑，一次挂载只允许一个解绑句柄；守住位置：useBotBroadcastEffects 的 onMessage 与 return 闭包；改错故障：热更新或切换窗口后同一广播被重复消费，任务状态成倍刷新。
// INV-02 同一 message 只能被 stream 或 refresh 其中一条路径消费，前者命中即提前返回；守住位置：分支末尾的 return 与 refresh 判空；改错故障：一条事件双写 store，运行态被第二次写入覆盖。
// INV-03 每次回调都在函数体内重新读取 store 快照，绝不使用挂载时的闭包变量；守住位置：zcodeSessionStore 的取值位置与 tabStoreApi 的每次重读；改错故障：stale closure 把旧 workspace 状态写成当前任务状态。
// INV-04 stream 镜像受 activeTaskId 与 workspaceIdentity 双重判定，不可仅按 taskId 相等就跳过；守住位置：shouldMirrorBotTaskStreamToStore；改错故障：远端 Bot 的消息要切换任务重拉快照才出现。
// INV-05 事件分支按 type 穷举，未知 type 不写任何 store 字段；守住位置：事件类型 switch 无 default 的设计；改错故障：协议新增事件被误当作完成态，任务提前结束。
// INV-06 task_complete 必须同时把运行态置 completed 并清空权限请求与错误；守住位置：task_complete 分支的三连写；改错故障：任务结束后权限弹窗仍挂着，用户无法继续。
// INV-07 task_error 先归一化为 UI 错误再入库，原始 message 不直接暴露；守住位置：task_error 分支的 normalizeZCodeUiError 调用；改错故障：界面弹出没有 code 与 traceId 的裸错误。
// INV-08 usage_update 必须与上一份 usage 合并而非整体覆盖，缓存的字段按需展开；守住位置：buildTaskContextUsageFromUsageUpdate 与 incomingUsage 字面量；改错故障：缺省 cache 的下一帧把已有缓存清空，比例显示跳水。
// INV-09 usage 记账先写 fallback 记忆再写 store，两次写入使用同一对 size 与 used；守住位置：recordTaskContextUsageUpdate 与 setTaskContextWindow 的相邻调用；改错故障：弹窗比例与落盘记录不一致。
// INV-10 session_info_update 只在 apiRetry 有定义时写状态，undefined 不表示清除；守住位置：该分支的 undefined 判断；改错故障：无关 session 事件把重试状态清掉。
// INV-11 provider 与 configOptions 只在目标是当前 active 任务时绑定，避免改写前台任务；守住位置：shouldSyncVisibleTaskConfig 与 provider 判断；改错故障：后台 Bot 切模型导致前台下拉显示错乱。
// INV-12 配置同步只有一个入口，renderer store 不保留第二份模式状态；守住位置：syncBotTaskConfigOptionsToStore；改错故障：/mode 改动后两份状态互相打架。
// INV-13 有 task meta 时走增量 cache 写入，created 用插入语义，其余用合并语义；守住位置：refresh.task 分支内的两条路径；改错故障：已完成任务被重复插入，侧栏出现两条。
// INV-14 无 task meta 时才允许提升列表版本号整表重查，created 例外保留兜底；守住位置：shouldRefreshBotTaskList；改错故障：高频事件反复重建 queryKey，列表闪烁。
// INV-15 权限与问答的出队必须带 requestId，重复出队视为幂等；守住位置：permission_resolved 与 elicitation_resolved 分支；改错故障：旧请求把新弹窗顶掉，用户看不到最新提问。
// INV-16 completed 与 error 是终态兜底，必须清空权限请求；守住位置：最后一个 else if 分支；改错故障：任务已失败但授权按钮仍可点。
// INV-17 workspacePath 与 workspaceIdentity 必须成对透传，任何 store 写入都带 identity；守住位置：所有 setTask 调用的末尾参数；改错故障：同路径不同远端工作区串状态。
// INV-18 effect 依赖只包含订阅源与 tabStoreApi，卸载后回调不再写状态；守住位置：依赖数组与解绑返回值；改错故障：频繁重渲染导致重复订阅，或卸载后写状态告警。
//
// 本文件把 Bot 广播翻译为 sidebar 与弹窗所需的运行态、权限、用量三类 store 写入。
// 两条通道：task stream 处理运行内容，task 广播处理元数据与列表，二者以提前返回互斥。
// 所有写入都按 workspace 身份隔离，并以增量缓存优先、整表刷新兜底。
import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeConfigOption } from "@zcode/shared";
import {
  buildTaskContextUsageFromUsageUpdate,
  recordTaskContextUsageUpdate,
} from "@/lib/zcodeTaskUsageFallback.js";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  resolveBotTaskBroadcastRefresh,
  resolveBotTaskBroadcastRuntimeStatus,
} from "@/root/botsTaskBroadcast.js";
import { resolveBotTaskStreamBroadcast } from "@/root/botsTaskStreamBroadcast.js";
import {
  insertTaskIntoTaskCaches,
  syncTaskMetaToTaskCaches,
} from "@/lib/taskListMetaSync.js";

// [事务] 配置写入只有一个出口，调用方不得自行拼接 store 的写入参数。
// 同步函数保持无状态，只做转发，避免 UI 维护第二份模式状态。
export function syncBotTaskConfigOptionsToStore(params: {
  zcodeSessionStore: Pick<
    ReturnType<typeof useZCodeSessionStore.getState>,
    "setTaskConfigOptions"
  >;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  configOptions: ZCodeConfigOption[];
}) {
  // Bugfix: Bot /mode 不经过 ChatInputToolbar/useTaskStreamEvents。
  // setTaskConfigOptions 会按 activeTaskId 决定是否同步到 workspace configOptions，
  // 当前 mode 再由 configOptions 派生，避免 UI 维护第二份模式状态。
  // [事务] task 级写入由 store 按 activeTaskId 决定是否同步到 workspace，本层不重复判断。
  // workspaceIdentity 作为可选末位参数透传，缺省时 store 回退到路径维度。
  params.zcodeSessionStore.setTaskConfigOptions(
    params.workspacePath,
    params.taskId,
    params.configOptions,
    params.workspaceIdentity,
  );
}

// 纯函数只回答是否提升列表版本，不负责写缓存，便于单测覆盖。
// [权衡] 高频 updated 事件走增量路径，避免 queryKey 反复变化导致列表闪烁。
export function shouldRefreshBotTaskList(
  event: string,
  hasTaskMeta: boolean,
): boolean {
  // Bugfix: Bot 新建任务时会随 created 广播携带 task meta，当前实现因此跳过整表刷新。
  // 但如果对应 workspace 的 task query cache 还没建立，增量写入没有落点，侧栏列表就不会主动拉到这个新任务。
  // created 事件频率低，保留一次版本 bump 作为兜底；其它高频事件仍优先走增量缓存更新，避免列表闪烁回归。
  // [并发] created 可能先于 workspace 的 task cache 建立，没有落点时必须整表刷新兜底。
  // 其它事件只在缺少 task meta 时才继续往下判定。
  if (event === "created") {
    return true;
  }
  if (hasTaskMeta) {
    return false;
  }
  return event === "created" || event === "updated" || event === "completed" || event === "error";
}

// 决定当前窗口是否消费某条 Bot task stream，是防止跨任务串写的唯一闸门。
// 非当前 active 任务一律镜像，当前任务再看远端身份。
export function shouldMirrorBotTaskStreamToStore(params: {
  activeTaskId: string | null;
  taskId: string;
  workspaceIdentity?: string;
}): boolean {
  if (params.activeTaskId !== params.taskId) {
    return true;
  }

  // Bugfix: 远端 Bot task 的 stream 来自 bot runtime host，不一定会被当前 ChatView 的 ZCode Agent stream 订阅收到。
  // 之前 active task 直接跳过 bot broadcast，导致消息内容要切换任务重新拉 snapshot 后才显示。
  // [权衡] 当前任务若是远端 Bot 任务，本窗口不一定收得到同一条流，因此仍需镜像。
  // 空身份回落为不镜像，本地链路由 pane 自身的订阅负责。
  return Boolean(params.workspaceIdentity?.trim());
}

// hook 只注册一个广播监听，把协议消息翻译成 store 写入，不返回任何值。
// [资源] services 与 tabStoreApi 均由外部注入，hook 内部不构造服务实例。
export function useBotBroadcastEffects(
  services: IServiceAccessor,
  tabStoreApi: ReturnType<typeof useTabStoreApi>,
) {
  // `useEffect` 生命周期与组件挂载对齐，一次挂载只订阅一次广播。
  // 回调内所有 store 读取都发生在事件到达时，避免挂载时的快照过期。
  // [并发] 依赖数组变化会先解绑再重订，必须保证旧句柄被释放。
  useEffect(() => {
    // [资源] 返回值是唯一解绑句柄，丢失它就意味着监听泄漏。
    // 回调同步执行，不排队也不做节流，事件顺序即写入顺序。
    // [失败路径] 回调内不捕获异常，依赖各 store 写入不抛出，否则后续事件会丢失。
    const disposable = services.broadcastService.onMessage((message) => {
      const stream = resolveBotTaskStreamBroadcast(
        message,
        tabStoreApi.getState().tabs,
      );
      // stream 命中后进入运行态镜像分支，并在末尾提前返回，屏蔽 refresh 通道。
      // 未命中说明是任务元数据广播，交给下方的列表同步逻辑。
      if (stream) {
        const zcodeSessionStore = useZCodeSessionStore.getState();
        const workspaceState = zcodeSessionStore.getWorkspaceState(
          stream.workspacePath,
          stream.workspaceIdentity,
        );
        if (
          !shouldMirrorBotTaskStreamToStore({
            activeTaskId: workspaceState.activeTaskId,
            taskId: stream.taskId,
            workspaceIdentity: stream.workspaceIdentity,
          })
        ) {
          return;
        }

        // Bot task 在后台运行或远端 runtime 中运行时，本窗口不一定订阅到同一条流。
        // 消息正文不再回放进 renderer 本地 store——bot 发的 prompt
        // 走 v4 命令后，消息由 conversation 投影（订阅该 session 的 pane）自然呈现；
        // 这里只同步运行态/权限/用量等 A 区状态，供侧栏与弹窗消费。
        // [并发] 事件类型决定唯一写入路径，分支之间互不叠加。
        // 未知类型不匹配任何 case，回调什么都不写。
        const event = stream.event;
        switch (event.type) {
          // 内容类 chunk 与工具调用只把运行态推成 streaming，不回放消息正文。
          // 正文由订阅该 session 的 conversation 投影自然呈现，避免两份消息源。
          case "agent_message_chunk":
          case "agent_thought_chunk":
          case "tool_call":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          // [事务] 先写权限请求再置运行态，保证弹窗出现时任务已标记为进行中。
          // 权限对象整体入库，调用方按 requestId 渲染，本层不做裁剪。
          case "permission_request":
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, event, stream.workspaceIdentity);
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "streaming",
              undefined,
              stream.workspaceIdentity,
            );
            break;
          // 完成态是三连写：运行态完成、权限请求清空、错误清空。
          // [事务] 三步缺一都会让弹窗或错误横幅残留在已完成任务上。
          case "task_complete":
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "completed",
              undefined,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            zcodeSessionStore.setTaskError(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            break;
          // 错误先归一化，补齐 fallbackCode 与 traceId，再作为唯一错误对象写库。
          // 归一化后仍写运行态 failed，权限请求与错误必须同时收敛。
          case "task_error": {
            const normalizedError = normalizeZCodeUiError(
              {
                message: event.error,
                detail: event.detail,
                code: event.code,
              },
              {
                fallbackCode: event.code ?? "UNKNOWN",
                traceId: event.traceId,
                taskId: event.taskId,
              },
            );
            zcodeSessionStore.setTaskRuntimeState(
              stream.workspacePath,
              stream.taskId,
              "failed",
              normalizedError.message,
              stream.workspaceIdentity,
            );
            zcodeSessionStore.setTaskPermissionRequest(stream.workspacePath, stream.taskId, null, stream.workspaceIdentity);
            zcodeSessionStore.setTaskError(stream.workspacePath, stream.taskId, normalizedError, stream.workspaceIdentity);
            break;
          }
          case "task_warning":
            zcodeSessionStore.setTaskError(
              stream.workspacePath,
              stream.taskId,
              normalizeZCodeUiError(
                {
                  message: event.warning,
                  detail: event.detail,
                  code: event.code,
                },
                {
                  fallbackCode: event.code ?? "WARNING",
                  traceId: event.traceId,
                  taskId: event.taskId,
                },
              ),
              stream.workspaceIdentity,
            );
            break;
          // 用量事件先读上一份 usage，再与增量合并，避免缺省字段被清空。
          // [事务] 记账与展示分成两次写入，size 与 used 必须来自同一事件。
          // cache 与 breakdown 仅在存在时展开，保持 store 里的形状最小。
          case "usage_update":
            {
              const workspaceState = zcodeSessionStore.getWorkspaceState(
                stream.workspacePath,
                stream.workspaceIdentity,
              );
              const previousUsage =
                workspaceState.taskRuntimeByTaskId[stream.taskId]?.usage ?? null;
              // taskMessagesByTaskId 已随消息回放一并退役，估算用不到最近一条
              // 用户输入时走 fallback 估算（该分支只影响 usage 弹窗的比例展示兜底）。
              const incomingUsage = {
                size: event.size,
                used: event.used,
                cost: event.cost,
                ...(event.cache ? { cache: event.cache } : {}),
                ...(event.breakdown ? { breakdown: event.breakdown } : {}),
              };
              const nextUsage = buildTaskContextUsageFromUsageUpdate({
                currentUsage: previousUsage,
                incomingUsage,
              });
              recordTaskContextUsageUpdate({
                workspacePath: stream.workspacePath,
                workspaceIdentity: stream.workspaceIdentity,
                taskId: stream.taskId,
                size: event.size,
                used: event.used,
              });
              zcodeSessionStore.setTaskContextWindow(
                stream.workspacePath,
                stream.taskId,
                event.size,
                stream.workspaceIdentity,
              );
              zcodeSessionStore.setTaskUsage(
                stream.workspacePath,
                stream.taskId,
                nextUsage,
                stream.workspaceIdentity,
              );
            }
            break;
          case "session_info_update":
            if (event.apiRetry !== undefined) {
              zcodeSessionStore.setTaskApiRetryStatus(
                stream.workspacePath,
                stream.taskId,
                event.apiRetry ?? null,
                stream.workspaceIdentity,
              );
            }
            break;
        }
        return;
      }

      // refresh 通道处理任务元数据广播，stream 已消费的消息在这里解析为空。
      // 解析不到说明与当前窗口无关，直接返回，不产生任何写入。
      const refresh = resolveBotTaskBroadcastRefresh(
        message,
        tabStoreApi.getState().tabs,
      );
      if (!refresh) {
        return;
      }
      // Bots 在 host 侧创建/推进 task，不会挂载聊天视图里的 stream 订阅。
      // 因此除了刷新列表，还要同步 task 运行态；否则 sidebar 能看到新 task，却不会显示进行中状态。
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const workspaceState = zcodeSessionStore.getWorkspaceState(
        refresh.workspacePath,
        refresh.workspaceIdentity,
      );
      // provider 以 task 自带值为先，缺失才回退到广播顶层字段。
      // [权衡] 只在 active 任务上绑定，后台任务的模型切换不污染前台下拉。
      const provider = refresh.task?.provider ?? refresh.provider;
      const shouldSyncVisibleTaskConfig = workspaceState.activeTaskId === refresh.taskId;
      if (provider && shouldSyncVisibleTaskConfig) {
        // Bugfix: /model、/mode 可以从第三方 Bot 修改当前 task 的真实 ZCode Agent 状态。
        // 这些操作不经过 ChatInputToolbar，本地 store 以前不会同步 provider/configOptions，
        // 导致 Bot 回复已切换但 UI 下拉仍显示旧状态。
        zcodeSessionStore.bindRuntimeProvider(
          refresh.workspacePath,
          provider,
          refresh.workspaceIdentity,
        );
      }
      if (refresh.configOptions) {
        syncBotTaskConfigOptionsToStore({
          zcodeSessionStore,
          workspacePath: refresh.workspacePath,
          workspaceIdentity: refresh.workspaceIdentity,
          taskId: refresh.taskId,
          configOptions: refresh.configOptions,
        });
      }
      zcodeSessionStore.setTaskRuntimeState(
        refresh.workspacePath,
        refresh.taskId,
        resolveBotTaskBroadcastRuntimeStatus(refresh.event),
        undefined,
        refresh.workspaceIdentity,
      );
      // [事务] 有 task meta 时增量写缓存，避免整表重查带来的闪烁。
      // membership 固定为未置顶未归档，真实归属由后续详情加载修正。
      if (refresh.task) {
        // Bugfix: Bot 状态变化以前靠 bumpTaskListVersion 整表重查。
        // prompt_sent / completed 等连续事件会让 sidebar queryKey 反复换新，旧缓存短暂失效导致任务列表闪烁。
        // 这里有 task meta 时直接增量写入 task/query cache，只在缺少 meta 的旧广播上保留整表刷新兜底。
        const membership = { pinned: false, archived: false };
        // created 用插入语义，重复事件按 taskId 去重，不会产生两条。
        // 其余事件走合并语义，并确保任务已存在于 workspace 缓存。
        if (refresh.event === "created") {
          insertTaskIntoTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
          });
        } else {
          syncTaskMetaToTaskCaches({
            workspacePath: refresh.workspacePath,
            workspaceIdentity: refresh.workspaceIdentity,
            task: refresh.task,
            membership,
            ensureInWorkspaceTaskCache: true,
          });
        }
      }
      // prompt_sent 不再向 renderer 本地补写 user message——bot 发的
      // prompt 经 v4 命令进入 session 事件日志，订阅该 session 的 conversation 投影
      // 会自然出现该消息；本地拼装面（zcodeChatMessages）随旧 ChatView 退役。
      if (refresh.event === "permission_request" && refresh.permissionRequest) {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.permissionRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "permission_resolved" && refresh.requestId) {
        zcodeSessionStore.removeTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_request" && refresh.elicitationRequest) {
        // Bugfix: Bot channel 消费 AskUserQuestion 后，下一题只会先到 Bot runtime。
        // 当前 UI 窗口不一定有同一条 ZCode Agent stream 订阅，必须把新的 elicitation_request 显式写回 store。
        zcodeSessionStore.setTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.elicitationRequest,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "elicitation_resolved" && refresh.requestId) {
        // Bugfix: Bot 代用户提交 AskUserQuestion 时，当前 UI 窗口不一定能收到 ZCode Agent stream 的
        // elicitation_response。通过 bots:task 明确同步 requestId 出队，避免问答弹窗一直挂着。
        zcodeSessionStore.removeTaskElicitationRequest(
          refresh.workspacePath,
          refresh.taskId,
          refresh.requestId,
          refresh.workspaceIdentity,
        );
      } else if (refresh.event === "completed" || refresh.event === "error") {
        zcodeSessionStore.setTaskPermissionRequest(
          refresh.workspacePath,
          refresh.taskId,
          null,
          refresh.workspaceIdentity,
        );
      }
      // [权衡] 仅在该判定为真时提升列表版本，其余情况依赖上面的增量写入。
      // 版本提升带 workspace 身份，只失效对应工作区的查询。
      if (shouldRefreshBotTaskList(refresh.event, Boolean(refresh.task))) {
        zcodeSessionStore.bumpTaskListVersion(refresh.workspacePath, refresh.workspaceIdentity);
      }
    });
    // [资源] 清理函数只做一次解绑，句柄在订阅时创建，重复调用不会重复释放。
    // 卸载后事件不再进入回调，因此不存在卸载后写状态。
    return () => disposable.dispose();
  }, [services.broadcastService, tabStoreApi]);
}
