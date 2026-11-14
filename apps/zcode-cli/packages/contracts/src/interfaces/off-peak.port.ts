// ============================================================
// Off-Peak Port - idle-time task creation boundary
// ============================================================
// 与 AutomationPort 兄弟并列。create 返回判别联合而非抛错：失败分类
// （额度 3103 / 资格 3101 / 网络等）必须跨 CLI↔host 协议保真到 handler，
// 供模型收到稳定、可行动的错误提示，禁止降级为 message 字符串判断。
// 持久状态由 host 侧（闲时任务队列）持有：本端口只负责一次取号与列表读取，
// 不缓存任务状态、不推断派发时机；list 结果是某一时刻的服务端快照。
// 生产者在 bootstrap 的 zcode-protocol offpeak-port（转发协议方法），
// 消费者是 core 的 OffPeakCreate/OffPeakList handler；会话绑定由调用方以
// context.sessionId 传入，端口不得自行选择会话。

import type { OffPeakCreateInput, OffPeakTaskSummary } from "../tools/off-peak.js";

// 失败发生的阶段，与错误分类正交：同一 errorCategory 可能出现在不同阶段
// （例如本地持久化失败与取号请求失败都可能是 network）。该值原样进入
// CoreError 的 context，供 telemetry 区分"请求前/请求中/请求后"。
export type OffPeakCreateFailureStage = "client_validation" | "ticket_request" | "local_persist";

// 稳定错误分类。3101=账号无可用 Coding Plan 资格，3103=免费闲时额度耗尽；
// 两者是服务端协议码，必须原样跨协议传递，不能让上层的字符串匹配重新推断。
export type OffPeakCreateErrorCategory =
  | "client_validation"
  | "eligibility_3101"
  | "quota_3103"
  | "network"
  | "invalid_response"
  | "local_persist"
  | "unknown";

// 创建结果判别联合。ok:true 时 task 已由服务端取号并排队（queuePosition 可能缺席）；
// ok:false 时三个字段必须同时存在——failureStage 说明卡在哪一步，errorCategory
// 决定模型可见文案，errorCode 是服务端/本地的细分码（如 model_not_allowed、
// session_bound、offpeak_disabled），handler 用它做二次分派。
export type OffPeakCreateOutcome =
  | { ok: true; task: OffPeakTaskSummary }
  | {
      ok: false;
      failureStage: OffPeakCreateFailureStage;
      errorCategory: OffPeakCreateErrorCategory;
      errorCode: string;
    };

// 额度耗尽判定器。只认 errorCategory === "quota_3103"，不解析 errorCode 或文案：
// 分类是跨协议保真的事实，细分码可能随服务端演进而变化。
export function isOffPeakQuotaFailure(
  outcome: OffPeakCreateOutcome,
): outcome is Extract<OffPeakCreateOutcome, { ok: false }> {
  return !outcome.ok && outcome.errorCategory === "quota_3103";
}

// 资格缺失判定器。只认 eligibility_3101；同样不依赖 errorCode/文案，
// 保证 host 侧分类逻辑调整时模型仍收到"先去选择 Coding Plan 连接"的提示。
export function isOffPeakEligibilityFailure(
  outcome: OffPeakCreateOutcome,
): outcome is Extract<OffPeakCreateOutcome, { ok: false }> {
  return !outcome.ok && outcome.errorCategory === "eligibility_3101";
}

// 创建上下文。sessionId 是当前工具调用所在会话，作为闲时任务的绑定会话：
// 任务派发时 resume 该会话（对齐 CronCreate targetTaskId），因此调用方必须传
// executor 提供的事实，不得用全局/最近会话替代；缺席时由 host 侧按自身会话兜底。
export interface OffPeakCreateContext {
  /** 当前工具调用所在 session；作为闲时任务的绑定会话（首跑 resume 该会话，对齐 CronCreate targetTaskId）。 */
  sessionId?: string;
}

// 闲时任务端口。create 会消耗一次免费额度并在服务端排队（有副作用，调用前须过审批）；
// list 只读当前工作区的任务快照，不保证反映派发进度。实现方负责会话绑定守卫
// （同一会话存在未终态任务时拒绝再建）与闲时轮递归防护；端口自身不缓存状态，
// 所有"是否已存在/何时开始"的判断都必须回到服务端。
export interface OffPeakPort {
  create(input: OffPeakCreateInput, context?: OffPeakCreateContext): Promise<OffPeakCreateOutcome>;
  list(): Promise<OffPeakTaskSummary[]>;
}
