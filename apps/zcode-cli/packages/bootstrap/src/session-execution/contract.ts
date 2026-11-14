import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import type { SendInputOptions } from "../app/types.js";

/** 原 session record 拥有计数；租约不创建第二个运行态或调度锁。 */
export interface SessionResidencyFinalizationOwner {
  /** 当前仍在收尾的 detached runner 数；由 pool 回收侧读取，本模块只增减。 */
  residencyFinalizationCount?: number;
}
/** wire 侧（V4 command payload）的鉴权材料形态；允许 Secret/Ticket 以值传入。 */
export type ModelExecutionInput = NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>;
/** 执行侧投影：鉴权被包装成惰性依赖，且不进入可持久化 intent。 */
export type ModelExecutionContext = NonNullable<SendInputOptions["modelExecution"]>;

/** 三个能力的契约面：执行材料投影 + 收尾租约的获取与包装执行。 */
export interface SessionExecutionContract {
  /** 拷贝并冻结本轮请求鉴权，不持久化凭证。 */
  createModelExecutionContext(input: ModelExecutionInput): ModelExecutionContext;
  /** 同步增加原 record 计数，返回幂等释放函数。 */
  acquireSessionResidencyFinalization(owner: SessionResidencyFinalizationOwner): () => void;
  /** 先持有再执行，成功、失败或同步抛错均释放，不吞掉错误。 */
  runWithSessionResidencyFinalization<T>(
    owner: SessionResidencyFinalizationOwner,
    run: () => Promise<T>,
  ): Promise<T>;
}
