// INV-01 身份稳定：守住位置 对外暴露的实例；改错故障：换代后存量面板持有失效对象。
// INV-02 归属记账：守住位置 订阅标识到代理的映射；改错故障：订阅发到旧代理，新代理收不到帧。
// INV-03 先解后释：守住位置 replace 的顺序；改错故障：旧监听仍在推送，与新代理竞争。
// INV-04 释放不阻塞：守住位置 尽力而为的取消；改错故障：断线往返挂起，换代卡死。
// INV-05 失败只告警：守住位置 取消异常的捕获；改错故障：一次取消失败中断整个换代。
// INV-06 同对象早退：守住位置 相等判断；改错故障：重复换代反复解绑重绑。
// INV-07 迟到确认：守住位置 订阅返回后的核对；改错故障：过期确认写回新代理的归属表。
// INV-08 换代错误：守住位置 迟到确认的抛出；改错故障：调用方拿到已失效的订阅。
// INV-09 命令走当前：守住位置 命令转发目标；改错故障：旧代理丢字段，远端任务归属为空。
// INV-10 订阅走归属：守住位置 激活与重同步的查找；改错故障：订阅被发到错误代理。
// INV-11 映射清理：守住位置 退订与重启分支；改错故障：失效订阅长期占用映射。
// INV-12 能力一次判定：守住位置 构造期判定；改错故障：换代后能力虚报，调用空实现。
// INV-13 抹方法即信号：守住位置 不支持时的删除；改错故障：消费方无法区分回落路径。
// INV-14 监听按需绑：守住位置 空集合判断；改错故障：没有消费者也挂着底层监听。
// INV-15 末位解绑：守住位置 集合清空分支；改错故障：监听被长期持有，页面卸载后仍回调。
// INV-16 重复绑定防护：守住位置 已绑判断；改错故障：同类监听被注册两次，帧被重复消费。
// INV-17 转发齐全：守住位置 全部接口成员；改错故障：新增成员漏转发，面板调用直接抛错。
// INV-18 换代通知：守住位置 重启监听广播；改错故障：存储层不知道连接已换，沿用旧水位。
//
// 模块职责：在远程代理换代期间提供身份稳定的会话传输门面。
// `current`、`transportBySubscriptionId` 与四组监听集合由本实例持有。
// 阅读顺序：辅助函数 → 监听集合 → 生命周期能力 → 换代 → 命令与订阅转发 → 监听绑定。
import { logger } from "@/logger.js";
import type { ConversationTransport } from "@/v4/transport.js";

type FrameListener = Parameters<ConversationTransport["onFrame"]>[0];
type AssemblyFaultListener = Parameters<ConversationTransport["onAssemblyFault"]>[0];
type RuntimeRestartListener = Parameters<ConversationTransport["onRuntimeRestart"]>[0];
type RuntimeLifecycleListener = Parameters<
  NonNullable<ConversationTransport["onRuntimeLifecycle"]>
>[0];

// 取消订阅失败只告警，不向上传播。
// 断线时往返可能永久挂起，不能阻塞换代。
//
async function unsubscribeIgnoringFailure(
  transport: ConversationTransport,
  subscriptionId: string,
): Promise<void> {
  try {
    await transport.unsubscribe(subscriptionId);
  } catch (error) {
    logger.warn(
      `[v4-conversation] unsubscribe ${subscriptionId} 失败（忽略）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 远程 service proxy 换代期间保持 renderer 侧 transport 身份稳定。
 *
 * 同一 workspace 的存量 pane 会继续持有本对象；replace 后命令与订阅统一转发到
 * 最新 proxy，旧 proxy 的监听先同步解除，避免新旧 Store 竞争同一 topic ownership。
 */
// 稳定身份对外不变，内部持有当前代理。
// `transportBySubscriptionId` 以 `subscriptionId` 为键记账，换代后 `activate`/`resync` 仍能找回旧 owner。
//
export class ReplaceableConversationTransport implements ConversationTransport {
  private readonly frameListeners = new Set<FrameListener>();
  private readonly assemblyFaultListeners = new Set<AssemblyFaultListener>();
  private readonly runtimeRestartListeners = new Set<RuntimeRestartListener>();
  private readonly runtimeLifecycleListeners = new Set<RuntimeLifecycleListener>();
  private readonly transportBySubscriptionId = new Map<string, ConversationTransport>();
  private offFrame: (() => void) | null = null;
  private offAssemblyFault: (() => void) | null = null;
  private offRuntimeRestart: (() => void) | null = null;
  private offRuntimeLifecycle: (() => void) | null = null;

  /**
   * 承载方不支持 runtime lifecycle 时本方法在构造期被抹掉，消费方据此回落 onRuntimeRestart。
   * 能力按构造时的 current 判定：同一 workspace 的后续 transport 均由
   * createAgentConversationTransport 产出，支持性只取决于 agentService，换代不会翻转。
   */
  // `current.onRuntimeLifecycle` 缺失时，构造器把 `this.onRuntimeLifecycle` 置为 undefined。
  // 消费方据此回落到重启事件，不会调用空实现。
  //
  onRuntimeLifecycle?: (listener: RuntimeLifecycleListener) => () => void = (listener) => {
    this.runtimeLifecycleListeners.add(listener);
    this.bindRuntimeLifecycleListener();
    return () => {
      this.runtimeLifecycleListeners.delete(listener);
      if (this.runtimeLifecycleListeners.size === 0) {
        this.offRuntimeLifecycle?.();
        this.offRuntimeLifecycle = null;
      }
    };
  };

  // 构造时即判定生命周期能力，换代不会翻转。
  // 抹掉方法是唯一的能力信号，用类型层表达。
  //
  constructor(private current: ConversationTransport) {
    if (!current.onRuntimeLifecycle) {
      this.onRuntimeLifecycle = undefined;
    }
  }

  // 同一对象直接返回，避免无谓解绑与重绑。
  // `replace` 先 `detachCurrentListeners()`，再按 `owner !== previous` 释放旧代理的订阅。
  // `unsubscribeIgnoringFailure` 用 `void` 发起释放，不 await 可能挂起的 `transport.unsubscribe`。
  //
  replace(transport: ConversationTransport): void {
    if (transport === this.current) return;

    const previous = this.current;
    this.detachCurrentListeners();
    // 旧 proxy 上的 active subscription 必须先释放，但断线 RPC 可能永久
    // pending；cleanup 只做 best-effort，不能阻塞新 proxy 的重订阅接管。
    for (const [subscriptionId, owner] of this.transportBySubscriptionId) {
      if (owner !== previous) continue;
      this.transportBySubscriptionId.delete(subscriptionId);
      void unsubscribeIgnoringFailure(previous, subscriptionId);
    }

    this.current = transport;
    this.bindCurrentListeners();
    // proxy 换代只会让 connection ownership 失效，CLI runtime/logEpoch 仍可能连续；
    // 显式携带原因，让 Store 用当前水位 fresh subscribe，由服务端裁决 resume/snapshot。
    for (const listener of this.runtimeRestartListeners) listener("transportReplaced");
  }

  // 先记下发起时的代理，返回后再核对是否换代。
  // 迟到确认要立即释放，并抛出换代错误。
  //
  async subscribe(
    params: Parameters<ConversationTransport["subscribe"]>[0],
  ): ReturnType<ConversationTransport["subscribe"]> {
    const owner = this.current;
    const result = await owner.subscribe(params);
    if (owner !== this.current) {
      // 换代前发起的迟到 ACK 不能重新写入稳定 transport 的 ownership 映射。
      void unsubscribeIgnoringFailure(owner, result.ack.subscriptionId);
      throw new Error("fault.subscription.transportReplaced");
    }
    this.transportBySubscriptionId.set(result.ack.subscriptionId, owner);
    return result;
  }

  // `activate` 先查 `transportBySubscriptionId.get(subscriptionId)`，缺失才回退 `this.current`。
  // `replace` 已删掉 `previous` 名下的映射，回退 `this.current` 只覆盖过渡期。
  //
  activate(subscriptionId: string): void {
    (this.transportBySubscriptionId.get(subscriptionId) ?? this.current).activate(subscriptionId);
  }

  resync(
    params: Parameters<ConversationTransport["resync"]>[0],
  ): ReturnType<ConversationTransport["resync"]> {
    return (this.transportBySubscriptionId.get(params.subscriptionId) ?? this.current).resync(
      params,
    );
  }

  unsubscribe(subscriptionId: string): ReturnType<ConversationTransport["unsubscribe"]> {
    const owner = this.transportBySubscriptionId.get(subscriptionId) ?? this.current;
    this.transportBySubscriptionId.delete(subscriptionId);
    return owner.unsubscribe(subscriptionId);
  }

  // `sendCommand` 直接调 `this.current.sendCommand`，不查 `transportBySubscriptionId`。
  // 旧代理会丢字段，转发必须指向最新实例。
  //
  sendCommand(
    ...params: Parameters<ConversationTransport["sendCommand"]>
  ): ReturnType<ConversationTransport["sendCommand"]> {
    // Bug 原因：旧代理只转发 envelope，丢失 projectId，远端任务因而被预留成空归属。
    return this.current.sendCommand(...params);
  }

  queryCommands(
    params: Parameters<ConversationTransport["queryCommands"]>[0],
  ): ReturnType<ConversationTransport["queryCommands"]> {
    return this.current.queryCommands(params);
  }

  rowsRange(
    params: Parameters<ConversationTransport["rowsRange"]>[0],
  ): ReturnType<ConversationTransport["rowsRange"]> {
    return this.current.rowsRange(params);
  }

  plans(
    params: Parameters<ConversationTransport["plans"]>[0],
  ): ReturnType<ConversationTransport["plans"]> {
    return this.current.plans(params);
  }

  // workflowRunEvents 是后来（workflow run 事件日志的 RPC）加进 ConversationTransport
  // 的成员，加的时候只落到了具体传输实现上，这个稳定身份漏掉了转发。而 pane 持的正是本对象，
  // 于是走 service proxy 的 pane 上 `transport.workflowRunEvents` 是 undefined——run 详情页
  // 的事件日志被静默解除，一打开就抛。接口新增成员时这里必须同步长出一条转发。
  workflowRunEvents(
    params: Parameters<ConversationTransport["workflowRunEvents"]>[0],
  ): ReturnType<ConversationTransport["workflowRunEvents"]> {
    return this.current.workflowRunEvents(params);
  }

  // 同一类漏接的预防：接口新增成员时，这个稳定身份必须同步长出一条转发。
  workflowRuns(
    params: Parameters<ConversationTransport["workflowRuns"]>[0],
  ): ReturnType<ConversationTransport["workflowRuns"]> {
    return this.current.workflowRuns(params);
  }

  // workflow 用户面产物的三条读接口必须在此转发；遗漏时 service proxy 上的方法为
  // undefined，侧板调用就会抛错。
  workflowRunArtifacts(
    params: Parameters<ConversationTransport["workflowRunArtifacts"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifacts"]> {
    return this.current.workflowRunArtifacts(params);
  }

  workflowRunArtifactData(
    params: Parameters<ConversationTransport["workflowRunArtifactData"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifactData"]> {
    return this.current.workflowRunArtifactData(params);
  }

  workflowRunArtifactRead(
    params: Parameters<ConversationTransport["workflowRunArtifactRead"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifactRead"]> {
    return this.current.workflowRunArtifactRead(params);
  }

  // dwf 脚本 transcript 的两条读面。
  workflowRunWorkspace(
    params: Parameters<ConversationTransport["workflowRunWorkspace"]>[0],
  ): ReturnType<ConversationTransport["workflowRunWorkspace"]> {
    return this.current.workflowRunWorkspace(params);
  }

  workflowRunNodeResult(
    params: Parameters<ConversationTransport["workflowRunNodeResult"]>[0],
  ): ReturnType<ConversationTransport["workflowRunNodeResult"]> {
    return this.current.workflowRunNodeResult(params);
  }

  fileChanges(
    params: Parameters<ConversationTransport["fileChanges"]>[0],
  ): ReturnType<ConversationTransport["fileChanges"]> {
    return this.current.fileChanges(params);
  }

  fileRewindPreview(
    params: Parameters<ConversationTransport["fileRewindPreview"]>[0],
  ): ReturnType<ConversationTransport["fileRewindPreview"]> {
    return this.current.fileRewindPreview(params);
  }

  attachmentPut(
    params: Parameters<ConversationTransport["attachmentPut"]>[0],
    options?: Parameters<ConversationTransport["attachmentPut"]>[1],
  ): ReturnType<ConversationTransport["attachmentPut"]> {
    return this.current.attachmentPut(params, options);
  }

  attachmentRead(
    params: Parameters<ConversationTransport["attachmentRead"]>[0],
  ): ReturnType<ConversationTransport["attachmentRead"]> {
    return this.current.attachmentRead(params);
  }

  attachmentReadRange(
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ): ReturnType<ConversationTransport["attachmentReadRange"]> {
    return this.current.attachmentReadRange(params);
  }

  // `onFrame` 先 `frameListeners.add(listener)`，再由 `bindFrameListener` 按需绑定。
  // `frameListeners.size === 0` 时调 `this.offFrame?.()` 并置 null，否则监听引用不会释放。
  // `bindFrameListener` 的回调遍历 `frameListeners`，同一帧分发给全部注册者。
  //
  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    this.bindFrameListener();
    return () => {
      this.frameListeners.delete(listener);
      if (this.frameListeners.size === 0) {
        this.offFrame?.();
        this.offFrame = null;
      }
    };
  }

  onAssemblyFault(listener: AssemblyFaultListener): () => void {
    this.assemblyFaultListeners.add(listener);
    this.bindAssemblyFaultListener();
    return () => {
      this.assemblyFaultListeners.delete(listener);
      if (this.assemblyFaultListeners.size === 0) {
        this.offAssemblyFault?.();
        this.offAssemblyFault = null;
      }
    };
  }

  onRuntimeRestart(listener: RuntimeRestartListener): () => void {
    this.runtimeRestartListeners.add(listener);
    this.bindRuntimeRestartListener();
    return () => {
      this.runtimeRestartListeners.delete(listener);
      if (this.runtimeRestartListeners.size === 0) {
        this.offRuntimeRestart?.();
        this.offRuntimeRestart = null;
      }
    };
  }

  // `bindCurrentListeners` 在 `replace` 末尾重绑 `bindFrameListener` 等四类。
  // 每个 `bind*Listener` 开头都判 `this.off*` 与集合大小，避免重复注册。
  //
  private bindCurrentListeners(): void {
    this.bindFrameListener();
    this.bindAssemblyFaultListener();
    this.bindRuntimeRestartListener();
    this.bindRuntimeLifecycleListener();
  }

  private bindFrameListener(): void {
    if (this.offFrame || this.frameListeners.size === 0) return;
    this.offFrame = this.current.onFrame((frame, context) => {
      for (const listener of this.frameListeners) listener(frame, context);
    });
  }

  private bindAssemblyFaultListener(): void {
    if (this.offAssemblyFault || this.assemblyFaultListeners.size === 0) return;
    this.offAssemblyFault = this.current.onAssemblyFault((fault) => {
      for (const listener of this.assemblyFaultListeners) listener(fault);
    });
  }

  private bindRuntimeRestartListener(): void {
    if (this.offRuntimeRestart || this.runtimeRestartListeners.size === 0) return;
    const owner = this.current;
    this.offRuntimeRestart = owner.onRuntimeRestart(() => {
      for (const [subscriptionId, subscriptionOwner] of this.transportBySubscriptionId) {
        if (subscriptionOwner === owner) {
          this.transportBySubscriptionId.delete(subscriptionId);
        }
      }
      for (const listener of this.runtimeRestartListeners) listener();
    });
  }

  private bindRuntimeLifecycleListener(): void {
    if (this.offRuntimeLifecycle || this.runtimeLifecycleListeners.size === 0) return;
    this.offRuntimeLifecycle =
      this.current.onRuntimeLifecycle?.((state) => {
        for (const listener of this.runtimeLifecycleListeners) listener(state);
      }) ?? null;
  }

  private detachCurrentListeners(): void {
    this.offFrame?.();
    this.offFrame = null;
    this.offAssemblyFault?.();
    this.offAssemblyFault = null;
    this.offRuntimeRestart?.();
    this.offRuntimeRestart = null;
    this.offRuntimeLifecycle?.();
    this.offRuntimeLifecycle = null;
  }
}
