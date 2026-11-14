// ============================================================
// CLI 会话的默认模型选择与普通输入的准入元数据
// ============================================================
// 这里只服务 CLI 的交互输入：把「用户选了什么模型」保存成一份可复制的意图，并在没有 intent
// 的输入上补齐 commandId / admissionSeq 等排队字段。临时执行（modelExecution）、离峰任务与
// 自动化续跑自带选择与鉴权，一律不垫默认值。
// 不变量：外部拿到的 selection 与内部持有的都是深拷贝，改一方不会改另一方。

import { createQueryId, type ModelSelection, type TurnInputIntentMetadata } from "@zcode/contracts";

/** CLI 配置命令的会话默认值；Core Session 仍独立负责后台与 Goal 续跑。 */
export class CliDefaultSelection {
  /** 保存的模型意图；`undefined` 表示尚未选择，prepareInput 会因此拒绝发送。 */
  private selection: ModelSelection | undefined;
  /** 本实例内的准入序号；只用于同进程 CLI 的排队展示，不跨进程也不等于 session 的 turn 号。 */
  private inputSequence = 0;

  constructor(selection?: ModelSelection) {
    this.set(selection);
  }

  /** 读当前默认选择；返回深拷贝，调用方改动不会回写本实例。 */
  get(): ModelSelection | undefined {
    return this.selection && structuredClone(this.selection);
  }

  /** 覆盖默认选择；同样存深拷贝，避免调用方后续修改原对象影响已保存的意图。 */
  set(selection: ModelSelection | undefined): void {
    this.selection = selection && structuredClone(selection);
  }

  /**
   * 为一条普通 CLI 输入补齐 intent；已有 intent 时只补 modelSelection，其余字段原样保留。
   *
   * 输入带 modelExecution / offPeakTaskId / automationId 时整体放行——这些路径有自己的选择与
   * 鉴权来源，垫默认值会覆盖调用方语义。既无 intent 也无默认选择时抛错，调用方（发送入口）
   * 据此提示「先选模型」，这是本文件唯一的失败出口。
   */
  prepareInput<
    T extends {
      inputId?: string;
      intent?: TurnInputIntentMetadata;
      modelExecution?: unknown;
      offPeakTaskId?: string;
      automationId?: string;
    },
  >(options?: T): T & { intent?: TurnInputIntentMetadata } {
    // 只补普通 CLI 用户输入；临时执行和自动续跑有自己的选择与鉴权。
    if (options?.modelExecution || options?.offPeakTaskId || options?.automationId) {
      return { ...options } as T;
    }
    const selection = options?.intent?.modelSelection ?? this.get();
    if (!selection) throw new Error("Select a model before sending a message");
    if (options?.intent) {
      // 已有 intent 只替换选择：commandId / 队列与投递字段由上游（协议或 TUI）负责。
      return {
        ...options,
        intent: { ...options.intent, modelSelection: structuredClone(selection) },
      };
    }
    const commandId = options?.inputId ?? String(createQueryId());
    // 无 intent 时新建一条 sendText：sourceCommandId 与 queueItemId 复用同一个 commandId，
    // 让 UI 的 optimistic overlay 与入站队列能按同一 id 关联；admittedDelivery=startNow 即
    // 空闲时立即执行，忙时仍由 CommandInbox 串行准入。
    return {
      ...options,
      inputId: commandId,
      intent: {
        sourceCommandId: commandId,
        queueItemId: commandId,
        clientId: "cli",
        kind: "sendText",
        admissionSeq: ++this.inputSequence,
        admittedAt: Date.now(),
        requestedDelivery: "auto",
        admittedDelivery: "startNow",
        modelSelection: structuredClone(selection),
      },
    } as T & { intent: TurnInputIntentMetadata };
  }
}
