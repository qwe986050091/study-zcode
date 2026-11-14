/* oxlint-disable eslint(max-lines) -- draft prewarm 的创建、复用、回收和首帧 ModelSelection 必须共享同一 owner 状态机；拆到多文件会让 StrictMode/transport 换代清理时序更难审计。 */
// 草稿态 v4 draft session 预热。
//
// 背景：草稿态没有任何 session 在册时，配置面被迫走 workspace-default 旧 RPC，
// 其回包 buildWorkspaceState 每次临建完整 app（140-798ms/次）；首发也要现场
// createSession。v4 协议本就保留 phase=draft 会话实体（「pane 绑 draft
// session 则服务端已有会话实体」）——本模块在 pane 未绑定会话时后台建一个
// draft session 作预热载体：配置写走 v4 CAS 命令直达会话、首发 sendText 复用、
// 未使用则清理。纯内存不落盘，CLI 重启即消失；gateway isDraftSession 过滤保证
// 它不会以「新任务」漏进 sessions-index 侧栏。
//
// 结构：生命周期收敛在纯控制器 startDraftSessionPrewarm（可单测，无 React 依赖），
// useDraftSessionPrewarm 只做 effect 接线与 owner-scoped binding 暴露。
// 模块：草稿态 v4 draft session 预热的创建、复用、回收与单飞协调。
// 所有者：DraftSessionPrewarmCoordinator 按 transport、workspace、pane 三元组唯一持有当前代。
// 不落盘：预热会话纯内存存在，CLI 退出即消失，gateway 的 isDraftSession 过滤阻止其进侧栏。
// 约束：effect cleanup 无法取消已发出的 createSession，故回收只能先登记意图、等 ACK 再删除。
// INV-01 预热仅在 pane 未绑定会话时启动；守住位置：useDraftSessionPrewarm 的 enabled 分支；改错故障：已绑定会话被二次创建，侧栏出现重复任务。
// INV-02 同一 transport、workspace、pane 只有一个 coordinator；守住位置：getDraftSessionPrewarmCoordinator 的 ownerKey 查表；改错故障：并发等待者各建会话，Agent 全局 FIFO 被慢创建占满。
// INV-03 创建入口只有一次 startDraftSessionPrewarm 调用；守住位置：startCurrent 的 controller 构造；改错故障：重挂后出现两条在飞 createSession，回收互相踩踏。
// INV-04 disposed 一旦置真不再复位；守住位置：dispose 的首行幂等判断；改错故障：cleanup 后仍派发 createSession，遗留无人认领的内存会话。
// INV-05 创建在飞时 dispose 不删除结果未知的会话；守住位置：dispose 的 promotionState 收窄；改错故障：ACK 到达前删掉已成功会话，首发 sendText 命中不存在的会话。
// INV-06 ACK 晚于 dispose 时就地删除；守住位置：createSessionAck 的 then 分支；改错故障：极快切 workspace 遗留内存会话，长期占用 Agent 资源。
// INV-07 仅 draft 态可自动回收；守住位置：dispose 对 promotionState 等于 draft 的判断；改错故障：pending 会话被关闭，已运行的 execution adapter 连带中断。
// INV-08 pending 必须等原命令收口；守住位置：markPromotionPending 与 dispose 的先后约束；改错故障：已发出的 admission 命令目标会话被删，用户首发丢消息。
// INV-09 promoted 后 dispose 不得删除；守住位置：markPromoted 直接写终态；改错故障：正常会话在切 pane 时被当作预热垃圾清理。
// INV-10 discarded 后不再发 deleteSession；守住位置：markDiscarded 的终态判断；改错故障：对已消失会话重复删除，产生无意义的拒绝日志。
// INV-11 状态迁移单向，draft 可到 pending 或 discarded，pending 只到 promoted 或 discarded；守住位置：三个 mark 方法的守卫；改错故障：promoted 被 discarded 覆盖，正常会话被误删。
// INV-12 首帧 config 同步解析后才发创建；守住位置：createPayload 的 resolveInitialConfig 调用；改错故障：首帧闪 workspace 缺省模型，随后跳变。
// INV-13 初始 config 为空对象时不写 payload；守住位置：createPayload 的键数量判断；改错故障：服务端把空 config 当显式覆盖，首帧无模型可选。
// INV-14 每个 createSession 无论成败只调用一次 onSettled；守住位置：finally 分支；改错故障：single-flight 闸永不释放，后续代无法创建。
// INV-15 createSession 失败静默降级不抛出；守住位置：catch 里的 warn 记录；改错故障：未捕获拒绝冒泡进 React，预热失败拖垮整棵组件树。
// INV-16 同一代 completion 只 resolve 一次；守住位置：startCurrent 的 complete 闭包；改错故障：并发等待者被提前唤醒，读到半初始化的 binding。
// INV-17 retire 后 binding 立即置空；守住位置：retireCurrent 的 emitBindings 调用；改错故障：UI 仍显示可用预热会话，首发拿到已失效 binding。
// INV-18 新一代启动前旧代必须收口；守住位置：reconcile 的 retiring 早返回；改错故障：两代 createSession 交错，删除顺序颠倒误删新会话。
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { CommandAck, CommandType, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

type DispatchCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string | null,
) => Promise<CommandAck>;

export interface DraftPrewarmController {
  /** 首条 admission 命令已发出、ACK 未收口；dispose 不得删除结果未知的会话。 */
  markPromotionPending(): void;
  /** 首发成功后标记（dispose 不再删除已提升的会话）。 */
  markPromoted(): void;
  /** 会话失效（订阅错误/sendText 被拒）后标记（dispose 不发 deleteSession——会话多半已不存在）。 */
  markDiscarded(): void;
  /**
   * 生命周期终点（effect cleanup / 切 workspace / 绑定真实会话）：
   * 已建且未提升未失效 → deleteSession 清理；创建仍在飞 → ack 到达时就地删除。
   */
  dispose(): void;
}

/** 预热生命周期纯控制器：创建 → onReady 上抛 → dispose 决策清理。 */
export function startDraftSessionPrewarm(params: {
  workspaceKey: string;
  dispatchCommand: DispatchCommand;
  onReady: (sessionId: string) => void;
  /** single-flight owner 用于等待不可取消的 createSession 收口；无论成功失败都只调用一次。 */
  onSettled?: () => void;
  /** 预热会话初始 config（全局「上次选择」，同步解析）；让投影首帧即全局、不闪。 */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftPrewarmController {
  const { workspaceKey, dispatchCommand, onReady, onSettled, resolveInitialConfig } = params;
  let disposed = false;
  let promotionState: "draft" | "pending" | "promoted" | "discarded" = "draft";
  let createdSessionId: string | null = null;

  // 失败路径：清理被拒只记 warn，不重试也不阻塞 dispose 返回。
  // 权衡：deleteSession 结果只用于诊断，内存会话随 CLI 退出自然消失。
  // 并发：删除请求 fire-and-forget，与后续创建无顺序依赖，故不 await。
  // 资源：sessionId 来自 ack.result，天然限定在本次 owner 创建的会话上。
  const deleteCreatedSession = (sessionId: string) => {
    void dispatchCommand("deleteSession", {}, sessionId)
      .then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn("[v4-draft-prewarm] 清理预热会话被拒", {
            sessionId,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
        }
      })
      .catch(() => {
        // 清理失败无碍：内存会话随 CLI 退出消失。
      });
  };

  // 触发：config 只在创建时快照一次，后续全局选择变化由命令通道下发。
  // 不变量：空 config 不进 payload，避免服务端把空对象当显式覆盖。
  // 权衡：同步读取全局上次选择会阻塞首帧一瞬，换来首帧不闪 workspace 缺省。
  const createPayload = () => {
    const createPayload: Record<string, unknown> = { workspaceId: workspaceKey };
    const initialConfig = resolveInitialConfig?.();
    if (initialConfig && Object.keys(initialConfig).length > 0) {
      // 预热会话首帧即用全局模型（CLI 归并 createSession.config），不闪 workspace 缺省。
      createPayload.config = initialConfig;
    }
    return createPayload;
  };
  // 并发：disposed 检查在发送前同步完成，dispose 与创建不会交错。
  // 不变量：已 dispose 时返回已决 null，调用方按失败路径收口而非再发请求。
  // 失败路径：返回 null 让上层跳过 ack 解析，避免把取消当协议错误记 warn。
  const dispatchCreateSession = () => {
    const createSessionPayload = createPayload();
    if (disposed) {
      return Promise.resolve(null);
    }
    return dispatchCommand("createSession", createSessionPayload, null);
  };
  // 资源：ACK 携带的 sessionId 是唯一句柄，写入 createdSessionId 后才可被 dispose 使用。
  // 并发：ACK 晚于 dispose 时走就地删除分支，覆盖创建不可取消的窗口。
  // 失败路径：status 非 accepted 只 warn 并 return，不把拒绝升级为异常。
  // 去重：onReady 仅在未 dispose 分支调用，避免 UI 拿到已回收会话。
  const createSessionAck = dispatchCreateSession();
  void createSessionAck
    .then((ack) => {
      if (!ack) {
        return;
      }
      if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
        logger.warn("[v4-draft-prewarm] createSession 被拒", {
          status: ack.status,
          reasonCode: ack.reasonCode ?? null,
          workspaceKey,
        });
        return;
      }
      createdSessionId = ack.result.sessionId;
      if (disposed) {
        // 极快切走时创建无法取消：ACK 到达后就地删除，避免遗留内存会话。
        deleteCreatedSession(createdSessionId);
        return;
      }
      logger.info("[v4-draft-prewarm] draft session 预热就绪", {
        sessionId: createdSessionId,
        workspaceKey,
      });
      onReady(createdSessionId);
    })
    .catch((error) => {
      logger.warn("[v4-draft-prewarm] createSession 失败", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    })
    .finally(() => {
      onSettled?.();
    });

  return {
    // 不变量：仅 draft 可迁到 pending，重复调用幂等，不覆盖 promoted。
    // 并发：admission 首发前同步占位，先于任何 cleanup 生效。
    // 失败路径：非 draft 调用被忽略，说明已有更强终态，不降级。
    markPromotionPending() {
      if (promotionState === "draft") {
        promotionState = "pending";
      }
    },
    markPromoted() {
      promotionState = "promoted";
    },
    markDiscarded() {
      if (promotionState !== "promoted") {
        promotionState = "discarded";
      }
    },
    // 生命周期：disposed 置真是唯一入口，重复 cleanup 直接返回。
    // 不变量：只有 createdSessionId 存在且仍为 draft 时才触发自动删除。
    // 失败路径：pending 态不删，等待原命令收口后再由 promote 或 discard 决定。
    // 资源：controller 不持有定时器与订阅，dispose 后无残留回调。
    dispose() {
      if (disposed) return;
      disposed = true;
      // Agent 可在 MCP 初始化期间先 admission 首发，而 renderer 仍等待 ACK；
      // 此时 owner cleanup 若按普通 draft 删除，会关闭已经运行的 execution adapter。
      // 只有从未开始 promotion 的 draft 才能安全自动回收，pending 必须等待原命令收口。
      if (createdSessionId && promotionState === "draft") {
        deleteCreatedSession(createdSessionId);
      }
    },
  };
}

export interface DraftSessionPrewarm {
  /** 当前 workspace/transport generation 已就绪的预热 binding。 */
  binding: DraftPrewarmBinding | null;
  /** 首发等待本 owner 当前创建任务；失败或换代即拒绝，不在发送路径另建会话。 */
  waitForSession(): Promise<DraftPrewarmBinding>;
}

export interface DraftPrewarmBinding {
  workspaceKey: string;
  sessionId: string;
  /** 首条 admission 命令发出前同步占住生命周期；false 表示 binding 已不是当前 owner。 */
  beginPromotion(): boolean;
  /** 首发成功后标记（阻止清理路径 deleteSession 已提升的会话）。 */
  promote(): void;
  /** 订阅错误 / sendText 被拒后丢弃；只影响创建本 binding 的 controller。 */
  discard(): void;
}

interface DraftPrewarmSubscriber {
  generation: object;
  invalidationVersion: number;
  onBinding: (binding: DraftPrewarmBinding | null) => void;
}

interface DraftPrewarmCurrent {
  invalidationVersion: number;
  controller: DraftPrewarmController;
  binding: DraftPrewarmBinding | null;
  settled: boolean;
  completion: Promise<void>;
  retiring: boolean;
  /** 本代是第几次退避重试的产物；0 表示首发。 */
  retryAttempt: number;
}

/**
 * createSession 失败后的退避重试节奏。
 *
 * CUA Helper ready 会触发 workspace-dispose 回收，正在飞的 createSession 被
 * client disposed 打断；只 warn 一次会永久「回落无预热路径」，草稿态从此拿不到
 * sessionId，粘贴的图片永远停在 waitingSession（进度 0%）。回收是瞬态的，隔一会儿重试即可
 * 成功，所以这里做有界退避而不是放弃。
 */
const PREWARM_RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * 同一逻辑 draft pane 的预热协调器。
 *
 * createSession 不能直接绑在 React effect 实例上。effect cleanup 无法取消已经
 * 发出的协议请求，新 effect 却会立刻再发一个 createSession；Agent 的全局 FIFO 因而被同一草稿
 * 的多个慢创建占满。协调器跨同步重挂保留 owner，并在旧创建 ACK 前阻止下一代创建入队。
 */
class DraftSessionPrewarmCoordinator {
  private readonly subscribers = new Map<symbol, DraftPrewarmSubscriber>();
  private current: DraftPrewarmCurrent | null = null;
  private blockedInvalidationVersion: number | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatchCommand: DispatchCommand;
  private resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;

  constructor(
    private readonly workspaceKey: string,
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
    private readonly onEmpty: () => void,
  ) {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  update(
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
  ): void {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  async waitForSession(
    invalidationVersion: number,
    generation: object,
  ): Promise<DraftPrewarmBinding> {
    const assertCurrentSubscriber = () => {
      if (
        this.requestedInvalidationVersion() !== invalidationVersion ||
        !Array.from(this.subscribers.values()).some(
          (subscriber) => subscriber.generation === generation,
        )
      )
        throw new Error("草稿会话已切换，请重新发送");
    };
    assertCurrentSubscriber();
    // 新草稿已接管时，旧创建仍可能在回收；这是等待窗口，不是用户再次切换。
    // 资格绑定本次订阅，防止相同版本的离开/重进让旧提交借新草稿继续发送。
    if (this.current?.retiring) {
      await this.current.completion;
      assertCurrentSubscriber();
    }
    // 已确定失败/失效后，用户再次点击可以重试；仍由 owner 创建并合并并发等待者，
    // 不能因后台重试耗尽就让当前草稿永久无法发送。
    if (this.current?.settled && !this.current.binding) {
      this.clearRetryTimer();
      this.blockedInvalidationVersion = null;
      this.current = null;
      this.startCurrent(invalidationVersion);
    }
    const current = this.current;
    if (!current) throw new Error("草稿会话尚未开始创建");
    // Bug 根因：binding=null 同时表示创建在途和失败，首发据此另建会话会与预热并发。
    // 创建只归此 owner；等待捕获的一代，不能在 await 后悄悄换成另一个会话发送。
    await current.completion;
    assertCurrentSubscriber();
    if (
      this.current !== current ||
      current.retiring ||
      current.invalidationVersion !== invalidationVersion ||
      this.requestedInvalidationVersion() !== invalidationVersion
    )
      throw new Error("草稿会话已切换，请重新发送");
    if (!current.binding) throw new Error("草稿会话创建失败，请重试");
    return current.binding;
  }

  acquire(params: {
    generation: object;
    invalidationVersion: number;
    onBinding: (binding: DraftPrewarmBinding | null) => void;
  }): () => void {
    if (this.cleanupTimer !== null) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const token = Symbol("draft-prewarm-subscriber");
    this.subscribers.set(token, params);
    this.reconcile();
    this.emitBindingTo(params);

    return () => {
      if (!this.subscribers.delete(token) || this.subscribers.size > 0) {
        return;
      }
      // React StrictMode 和同 key 同步重挂会先 cleanup 再重新执行 effect。延迟到下一任务确认
      // 是否真的离开，避免“create → cleanup delete → create”的协议 churn。
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = null;
        if (this.subscribers.size > 0) {
          return;
        }
        this.retireCurrent();
        if (!this.current) {
          this.onEmpty();
        }
      }, 0);
    };
  }

  // 去重：所有订阅者取版本最大值，多个 pane 订阅收敛到同一代。
  // 不变量：空订阅返回 null，reconcile 据此判定无人需要预热。
  // 失败路径：版本回退不触发重建，只有版本提升才使当前代失效。
  private requestedInvalidationVersion(): number | null {
    let latest: number | null = null;
    for (const subscriber of this.subscribers.values()) {
      latest =
        latest === null
          ? subscriber.invalidationVersion
          : Math.max(latest, subscriber.invalidationVersion);
    }
    return latest;
  }

  // 并发：单飞闸在这里收口，同一时刻最多一个 current 存活。
  // 不变量：版本相同且未 retire 时直接返回，避免无谓重建。
  // 失败路径：旧代未收口则先 retire，再等 onSettled 释放后进行下一轮。
  // 取消：blockedInvalidationVersion 挡住已失效代，直到用户显式重试。
  private reconcile(): void {
    const requestedVersion = this.requestedInvalidationVersion();
    if (requestedVersion === null) {
      return;
    }
    if (
      this.blockedInvalidationVersion !== null &&
      this.blockedInvalidationVersion !== requestedVersion
    ) {
      this.blockedInvalidationVersion = null;
    }
    if (this.current) {
      if (!this.current.retiring && this.current.invalidationVersion === requestedVersion) {
        return;
      }
      this.retireCurrent();
      // createSession 已经发出时不可取消；onSettled 会在 ACK 后先排 delete，再只启动最新代。
      if (this.current) {
        return;
      }
    }
    if (this.blockedInvalidationVersion === requestedVersion) {
      return;
    }
    this.startCurrent(requestedVersion);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * createSession 收口却没拿到 binding = 失败（被拒或异常）。回收导致的 client disposed 是
   * 瞬态的，按退避重排一次创建；用尽后保留失败态，由下一次生命周期失效重新创建。
   */
  // 触发：仅未被 retire 且无 binding 的失败代才排退避，成功与失效不重试。
  // 资源：重试表有界三段，用尽后保留失败态等下一次生命周期失效。
  // 并发：定时器触发时重校验 current 身份，旧代已被替换则放弃本次重试。
  private scheduleRetryAfterFailure(failed: DraftPrewarmCurrent): void {
    const delay = PREWARM_RETRY_DELAYS_MS[failed.retryAttempt];
    if (delay === undefined) return;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.current !== failed || failed.retiring || failed.binding !== null) return;
      if (this.subscribers.size === 0) return;
      const requestedVersion = this.requestedInvalidationVersion();
      if (requestedVersion === null || this.blockedInvalidationVersion === requestedVersion) return;
      // 释放失败的一代，让下一代能通过 reconcile 的单飞闸。
      this.current = null;
      this.startCurrent(requestedVersion, failed.retryAttempt + 1);
    }, delay);
  }

  // 生命周期：completion 与 current 同一批构造，等待者不会读到半初始化状态。
  // 去重：dispatchCommand 每次透传到实例字段，热更新后无需重建 coordinator。
  // 失败路径：onSettled 区分 retire 与自发失败，前者收口换代，后者走退避。
  private startCurrent(invalidationVersion: number, retryAttempt = 0): void {
    let current!: DraftPrewarmCurrent;
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const controller = startDraftSessionPrewarm({
      workspaceKey: this.workspaceKey,
      dispatchCommand: (type, payload, targetSessionId) =>
        this.dispatchCommand(type, payload, targetSessionId),
      resolveInitialConfig: () => this.resolveInitialConfig?.(),
      onReady: (sessionId) => {
        if (this.current !== current || current.retiring) {
          return;
        }
        let binding!: DraftPrewarmBinding;
        binding = {
          workspaceKey: this.workspaceKey,
          sessionId,
          beginPromotion: () => {
            if (this.current !== current || current.binding !== binding) {
              return false;
            }
            current.controller.markPromotionPending();
            return true;
          },
          promote: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markPromoted();
          },
          discard: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markDiscarded();
            current.binding = null;
            this.blockedInvalidationVersion = current.invalidationVersion;
            this.emitBindings();
          },
        };
        current.binding = binding;
        this.emitBindings();
      },
      onSettled: () => {
        current.settled = true;
        complete();
        if (this.current !== current || !current.retiring) {
          // 未被 retire 却没拿到 binding = createSession 失败；瞬态回收可退避重试。
          if (this.current === current && !current.retiring && current.binding === null) {
            this.scheduleRetryAfterFailure(current);
          }
          return;
        }
        this.current = null;
        if (this.subscribers.size > 0) {
          this.reconcile();
        } else {
          this.onEmpty();
        }
      },
    });
    current = {
      invalidationVersion,
      controller,
      binding: null,
      settled: false,
      completion,
      retiring: false,
      retryAttempt,
    };
    this.current = current;
  }

  // 取消：retire 先置 retiring 再 dispose，binding 立即可见为空。
  // 不变量：已 settled 的旧代立刻出表，未 settled 的等 ACK 后自行清空。
  // 资源：retire 同时清退避定时器，防止失败代被延迟复活。
  private retireCurrent(): void {
    const current = this.current;
    if (!current || current.retiring) {
      return;
    }
    this.clearRetryTimer();
    current.retiring = true;
    current.binding = null;
    current.controller.dispose();
    this.emitBindings();
    if (current.settled) {
      this.current = null;
    }
  }

  private emitBindings(): void {
    for (const subscriber of this.subscribers.values()) {
      this.emitBindingTo(subscriber);
    }
  }

  // 不变量：只向版本匹配且未 retire 的订阅者下发 binding。
  // 失败路径：其余订阅者收到 null，UI 据此隐藏预热态而非复用旧句柄。
  private emitBindingTo(subscriber: DraftPrewarmSubscriber): void {
    const current = this.current;
    subscriber.onBinding(
      current && !current.retiring && current.invalidationVersion === subscriber.invalidationVersion
        ? current.binding
        : null,
    );
  }
}

const draftPrewarmCoordinatorsByTransport = new Map<
  unknown,
  Map<string, DraftSessionPrewarmCoordinator>
>();

// 不变量：paneId 与 workspaceKey 同权参与身份，缺一不可。
// 去重：owner key 用 JSON 数组序列化，避免拼接分隔符带来歧义。
// 权衡：序列化有字符串分配开销，换来 key 跨调用直接可比。
function logicalDraftOwnerKey(workspaceKey: string, paneId: string): string {
  return JSON.stringify([workspaceKey, paneId]);
}

// 生命周期：transport 换代新建一层 Map，旧 coordinator 不会被新 transport 复用。
// 资源：onEmpty 回收空表，避免 transport 级 Map 随切换无限增长。
// 并发：查表与建表在同一同步块内完成，重挂并发不会产生两个实例。
// 失败路径：表项已被替换时 onEmpty 不再删除，防止误清他人登记。
function getDraftSessionPrewarmCoordinator(params: {
  workspaceKey: string;
  paneId: string;
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;
}): DraftSessionPrewarmCoordinator {
  let transportCoordinators = draftPrewarmCoordinatorsByTransport.get(params.transportIdentity);
  if (!transportCoordinators) {
    transportCoordinators = new Map();
    draftPrewarmCoordinatorsByTransport.set(params.transportIdentity, transportCoordinators);
  }
  const ownerKey = logicalDraftOwnerKey(params.workspaceKey, params.paneId);
  let coordinator = transportCoordinators.get(ownerKey);
  if (!coordinator) {
    coordinator = new DraftSessionPrewarmCoordinator(
      params.workspaceKey,
      params.dispatchCommand,
      params.resolveInitialConfig,
      () => {
        if (transportCoordinators?.get(ownerKey) !== coordinator) {
          return;
        }
        transportCoordinators.delete(ownerKey);
        if (transportCoordinators.size === 0) {
          draftPrewarmCoordinatorsByTransport.delete(params.transportIdentity);
        }
      },
    );
    transportCoordinators.set(ownerKey, coordinator);
  }
  return coordinator;
}

// 触发：enabled 为假时不 acquire，草稿未激活不产生任何协议请求。
// 依赖：owner 只由 workspace、pane、transport 决定，回调变更不重建 coordinator。
// 不变量：返回的 binding 与 generation 绑定，换代后旧 binding 自动失效。
export function useDraftSessionPrewarm(params: {
  /** pane 未绑定会话（sessionId===null）时启用。 */
  enabled: boolean;
  workspaceKey: string;
  /** 同一 workspace 内的逻辑 pane 身份；同步重挂必须保持稳定。 */
  paneId: string;
  /** 外部能力变化时递增；仅用于回收并重建尚未提升的草稿预热会话。 */
  invalidationVersion?: number;
  /** conversation provider 的 transport identity；同 workspace lease 变化时保持不变。 */
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  /** 预热会话初始 config（全局「上次选择」，同步解析）；让投影首帧即全局、不闪。 */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftSessionPrewarm {
  const {
    enabled,
    workspaceKey,
    paneId,
    transportIdentity,
    invalidationVersion = 0,
    dispatchCommand,
    resolveInitialConfig,
  } = params;
  // workspace/pane/transport 共同定义逻辑 owner：同 owner 重挂复用 single-flight，transport
  // 换代仍生成新 coordinator，确保旧 session 的清理不会误走新 transport。
  const owner = useMemo(
    () => ({ workspaceKey, paneId, transportIdentity }),
    [paneId, transportIdentity, workspaceKey],
  );
  const coordinator = useMemo(
    () =>
      getDraftSessionPrewarmCoordinator({
        workspaceKey,
        paneId,
        transportIdentity,
        dispatchCommand,
        resolveInitialConfig,
      }),
    [owner],
  );
  useLayoutEffect(() => {
    coordinator.update(dispatchCommand, resolveInitialConfig);
  }, [coordinator, dispatchCommand, resolveInitialConfig]);
  const generation = useMemo(() => ({ owner }), [enabled, invalidationVersion, owner]);
  const [ready, setReady] = useState<{
    generation: typeof generation;
    binding: DraftPrewarmBinding;
  } | null>(null);

  // 并发：acquire 的返回值是唯一退订句柄，重复执行 effect 不会重复登记。
  // 取消：卸载只交给延迟 cleanup 判定，StrictMode 双执行不会删除会话。
  // 失败路径：binding 为空且 generation 匹配时清 ready，防止跨代残留。
  // 依赖：generation 含 enabled 与 invalidationVersion，两者变化都会重跑。
  useEffect(() => {
    if (!enabled) return;
    return coordinator.acquire({
      generation,
      invalidationVersion,
      onBinding: (binding) => {
        setReady((current) => {
          if (!binding) {
            return current?.generation === generation ? null : current;
          }
          return { generation, binding };
        });
      },
    });
  }, [coordinator, enabled, generation, invalidationVersion]);

  // 不变量：enabled 为假直接抛错，发送路径不会悄悄新建会话。
  // 失败路径：错误上抛给调用方展示请重新发送，不在内部吞掉。
  // 并发：同一代的并发等待共享 completion，只唤醒一次创建。
  const waitForSession = useCallback(async () => {
    if (!enabled) throw new Error("草稿会话尚未启用");
    return coordinator.waitForSession(invalidationVersion, generation);
  }, [coordinator, enabled, generation, invalidationVersion]);

  // 不变量：binding 仅在 generation 匹配时外露，换代即回落 null。
  // 权衡：用对象引用比较代替字段比较，依赖 memo 保持引用稳定才能避免抖动。
  return { binding: ready?.generation === generation ? ready.binding : null, waitForSession };
}
