// ============================================================
// Automation Port - scheduled task management boundary
// ============================================================

import type {
  CronAutomation,
  CronCreateInput,
  CronDeleteInput,
  CronUpdateInput,
} from "../tools/automation.js";

/**
 * 【契约坐标】稳定领域码，不是展示文案：core 的 turn-control 用它判断「CronCreate 撞上全局
 * 保留任务上限（20 条）」并关掉本轮的工具恢复边界；bootstrap 的 automation-port 在协议错误
 * 进入工具循环之前把它映射成 {@link AutomationCreateLimitError}。码必须跨进程 / 协议保持
 * 逐字一致（含被包进 message 的那份），否则同一失败会被当成可重试的普通错误。
 */
export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

/**
 * 【契约坐标】生产者：bootstrap 的 `createProtocolAutomationPort`（把协议侧的超限错误重新
 * 包装成领域错误，`cause` 保留原始错误）；消费者：core 的 `withAutomationCreateLimitTurnStop`。
 * 继承 Error 是为了沿工具错误通道传播；`code` 固定为上面的常量，`cause` 只用于日志，模型
 * 可见的是 message。它不是「创建失败」的通用错误——只在全局保留任务上限命中时出现。
 */
export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AutomationCreateLimitError";
    this.cause = cause;
  }
}

/**
 * 【契约坐标】判别顺序：先按 `instanceof`（本进程内的领域错误），再按 `code`，最后才退化到
 * message 包含错误码——协议层把领域码包进文案，跨进程回来时已不是同一个类实例，只能靠码
 * 识别。刻意按码而不是文案判断，避免本地化 / 措辞漂移让守卫失效。生产者：本文件；
 * 消费者：core 的 turn-control 与 bootstrap 的自动化入口。
 */
export function isAutomationCreateLimitError(error: unknown): error is AutomationCreateLimitError {
  if (error instanceof AutomationCreateLimitError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === AUTOMATION_CREATE_LIMIT_ERROR_CODE ||
    (typeof candidate.message === "string" &&
      candidate.message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE))
  );
}

/**
 * 【契约坐标】由执行器注入、**不来自模型输入**：`model` 是本次 turn 的规范 picker 值，
 * `sessionId` 是工具调用所在会话。两者决定新任务触发时复用哪个模型与会话；会话一旦被绑定成
 * 某个 automation 的归属会话（`activeAutomationId`），后续在该会话内再次创建会被
 * fail-closed 拒绝。字段缺席即「不知道」，准入判断退回服务端归属查询。
 */
export interface AutomationCreateContext {
  /** 当前工具调用所在 runtime 的模型，由执行器注入，不来自模型输入。 */
  model?: string;
  /** 当前工具调用所在 session；会话内 cron 后续触发复用该 session。 */
  sessionId?: string;
}

/**
 * 【契约坐标】生产者：bootstrap 的 protocol automation 端口；消费者：core 的 Cron 工具
 * handler（见 `tool/handlers/cron.ts`）。`create` 是**准入最重**的一条：本轮已是 automation
 * 派发则拒绝，当前会话已绑定某个 automation 也拒绝，归属查询失败时 fail-closed（不许「无法
 * 验证就当未绑定」）；成功后会话标题被冻结，避免后续 turn 改动归属语义。`update` / `delete`
 * 在 automation 轮次内同样由 handler 层在调用端口之前拒绝——那是本轮事实，不是存储职责。
 */
export interface AutomationPort {
  /**
   * 创建任务：`input` 的 cron / prompt 是持久事实，`context` 只参与准入与归属，不落库。
   * 命中全局保留任务上限时抛 {@link AutomationCreateLimitError}；其余失败按普通错误上抛。
   */
  create(input: CronCreateInput, context?: AutomationCreateContext): Promise<CronAutomation>;
  /** 按 id 改写 cron / prompt / enabled；归属会话与已绑定的 automationId 不变。 */
  update(input: CronUpdateInput): Promise<CronAutomation>;
  /** 全量返回，不做分页或模型侧缓存；给模型的裁剪发生在 handler 的展示层。 */
  list(): Promise<CronAutomation[]>;
  /** 按 id 删除；返回 false 表示本就不存在（幂等），不是故障。 */
  delete(input: CronDeleteInput): Promise<boolean>;
}
