// INV-01 事件名与事件组是常量，禁止调用方自带：守住位置 三个导出常量；改错故障 报表按名称聚合时出现同义异名。
// INV-02 上报端未注册时所有上报静默丢弃：守住位置 emit 首行判空；改错故障 测试环境或早期启动阶段抛错打断会话打开。
// INV-03 上报必须发起即走，异常只记警告：守住位置 emit 的异步链与 catch；改错故障 遥测失败反噬主流程。
// INV-04 测试专用清理函数与正式设置函数分离：守住位置 清理函数；改错故障 生产代码误调清理，遥测全程丢失。
// INV-05 时间字段统一四舍五入为非负整数，非法值丢弃：守住位置 时间字段归一函数；改错故障 报表出现负数或浮点毫秒。
// INV-06 计数类字段走非负整数校验，同样丢弃非法值：守住位置 六个计数字段；改错故障 负数计数污染均值。
// INV-07 事件数值取总耗时的取整值，缺失时回 0：守住位置 载荷的数值字段；改错故障 事件数值为空被聚合端丢弃。
// INV-08 身份字段固定五个，键名不可改：守住位置 身份属性构造；改错故障 看板按会话打开标识关联时断链。
// INV-09 结果事件必须同时携带状态：守住位置 结果载荷构造；改错故障 无法区分成功、失败与超时。
// INV-10 错误阶段与错误码只在失败时出现，其余留空：守住位置 属性对象赋值；改错故障 成功样本被错误标签污染。
// INV-11 计时字段缺失时保留空值而不是 0：守住位置 各计时字段赋值；改错故障 缺失样本被当成 0ms 拉低均值。
// INV-12 属性对象允许空值，由上报端决定裁剪：守住位置 属性对象类型；改错故障 强制补默认值掩盖采集缺口。
// INV-13 开始与结果共用同一事件组，仅名称不同：守住位置 两个载荷构造；改错故障 两组事件无法按同一实验口径对齐。
// INV-14 上报函数不得等待，调用方无需感知异步：守住位置 两个 report 入口；改错故障 会话打开路径被遥测阻塞。
// INV-15 上报端可显式传入以覆盖全局实例：守住位置 emit 第二参数；改错故障 单测无法隔离全局状态。
// INV-16 所有导出类型保持只读语义，调用方只构造不修改：守住位置 各 interface；改错故障 上报后字段被就地改写，事件内容不可复现。
// INV-17 日志前缀固定为会话打开标记：守住位置 两处日志调用；改错故障 排障时无法按模块过滤。
// INV-18 本模块不依赖 React 或浏览器 API：守住位置 仅引入 shared 与 logger；改错故障 无法在 host 侧复用同一套载荷构造。
//
// 模块职责：构造并上报「会话打开」性能埋点的开始与结果两类事件。
// 状态所有权：全局上报端是唯一可变状态，其余全部是纯函数与常量。
// 阅读顺序：先看常量与类型，再看上报端生命周期与发送函数，最后看两个载荷构造与两个上报入口。
import type { ArmsCustomEventPayload } from "@zcode/shared";
import { logger } from "@/logger.js";

// 组名固定为 ui_perf，与前端性能看板的既有分组保持一致。
// 开始事件只证明「发起了一次打开尝试」，不带耗时；结果事件才承载完整分解。
// 两个事件用同一会话打开标识关联，构成一次完整打开的两端。
// 事件名是报表维度，改动等同破坏历史数据可比性。
// [权衡] 不在这里做采样：采样策略由上报端统一控制，避免双处限流。
export const SESSION_OPEN_ARMS_GROUP = "ui_perf";
export const SESSION_OPEN_EVENT_START = "perf_ui_session_open_start";
export const SESSION_OPEN_EVENT_RESULT = "perf_ui_session_open_result";

export type SessionOpenKind = "cold" | "warm" | "keep_warm";
export type SessionOpenTrigger =
  | "sidebar"
  | "search"
  | "deeplink"
  | "reload"
  | "subagent"
  | "selection"
  | "split"
  | "pane";
export type SessionOpenStatus = "success" | "failed" | "timeout";
export type SessionOpenProcessState = "spawned" | "reused";
export type SessionOpenRuntimeState = "cold" | "warm";

export interface SessionOpenArmsReporter {
  reportArmsCustomEvent(payload: ArmsCustomEventPayload): Promise<unknown>;
}

export interface SessionOpenIdentity {
  sessionOpenId: string;
  sessionId: string;
  openTrigger: SessionOpenTrigger;
  openKind: SessionOpenKind;
  clientMode: "desktop-continuous";
}

export interface SessionOpenTimingFields {
  rendererPrepareMs?: number;
  hostPrepareMs?: number;
  providerRegistrySyncMs?: number;
  taskMetaReadMs?: number;
  cliRequestMs?: number;
  cliBootstrapMs?: number;
  cliSessionRestoreMs?: number;
  initialFrameEncodeMs?: number;
  initialFrameTransportMs?: number;
  rendererSnapshotApplyMs?: number;
  reactRenderMs?: number;
  paintToInteractiveMs?: number;
}

export interface SessionOpenResultFields extends SessionOpenTimingFields {
  status: SessionOpenStatus;
  totalMs: number;
  errorPhase?: string;
  errorCode?: string;
  cliProcessState?: SessionOpenProcessState;
  sessionRuntimeState?: SessionOpenRuntimeState;
  attemptCount?: number;
  persistedMessageCount?: number;
  snapshotRowCount?: number;
  snapshotBytes?: number;
  pluginCount?: number;
  skillCount?: number;
  mcpServerCount?: number;
  mcpPendingAtInteractive?: boolean;
}

// 全局单例由宿主在启动时注入，避免本模块直接依赖具体上报实现。
// reporter 声明为可空，因为测试与启动早期还没有注入 SessionOpenArmsReporter。
// 设置函数接受空值，用于显式关闭上报。
// clearSessionOpenArmsReporterForTest 单独命名，生产代码只能调 setSessionOpenArmsReporter。
let reporter: SessionOpenArmsReporter | null = null;

export function setSessionOpenArmsReporter(next: SessionOpenArmsReporter | null): void {
  reporter = next;
}

export function clearSessionOpenArmsReporterForTest(): void {
  reporter = null;
}

// roundedNonNegative 对非数字、非有限值与负数都返回 undefined，交给上报端自行裁剪。
// 缺失返回空值，让上报端自行裁剪，而不是补 0。
// 与计数用的整数函数逻辑相同但语义不同，故保留两个名字。
function roundedNonNegative(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function positiveOrZeroInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

// 没有上报端时直接返回，调用方无需判断。
// 先包一层已完成承诺再挂异常处理，兼容同步抛错与异步拒绝两种实现。
// 异常只记警告，绝不向上抛：埋点不能影响会话打开。
// 默认参数取全局上报端，显式传入时优先，便于单测隔离。
function emit(
  payload: ArmsCustomEventPayload,
  targetReporter: SessionOpenArmsReporter | null | undefined = reporter,
): void {
  if (!targetReporter) return;
  try {
    void Promise.resolve(targetReporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[session-open] ARMS 上报失败", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[session-open] ARMS 上报异常", { name: payload.name, error });
  }
}

// 五个身份字段是所有事件的最小关联键，顺序与命名都固定。
// 全部转成字符串：属性值类型混用会让看板分组出现重复桶。
// 每次返回新对象，防止调用方修改后影响后续事件。
// 不含任何可能为空的字段，保证关联键始终可用。
function identityProperties(identity: SessionOpenIdentity): Record<string, string> {
  return {
    session_open_id: identity.sessionOpenId,
    session_id: identity.sessionId,
    open_trigger: identity.openTrigger,
    open_kind: identity.openKind,
    client_mode: identity.clientMode,
  };
}

export function buildSessionOpenStartArmsPayload(
  identity: SessionOpenIdentity,
): ArmsCustomEventPayload {
  return {
    name: SESSION_OPEN_EVENT_START,
    group: SESSION_OPEN_ARMS_GROUP,
    value: 1,
    properties: identityProperties(identity),
  };
}

// 身份字段先展开，再逐项追加结果与计时字段。
// 计时字段统一做四舍五入，非法值落成空值而不是 0。
// 计数字段走整数校验，负数与非有限值同样丢弃。
// 事件数值取总耗时的取整值，缺失时回 0 保证聚合端可入桶。
export function buildSessionOpenResultArmsPayload(
  identity: SessionOpenIdentity & SessionOpenResultFields,
): ArmsCustomEventPayload {
  const properties: Record<string, string | number | boolean | undefined> = {
    ...identityProperties(identity),
    status: identity.status,
    error_phase: identity.errorPhase,
    error_code: identity.errorCode,
    total_ms: roundedNonNegative(identity.totalMs),
    renderer_prepare_ms: roundedNonNegative(identity.rendererPrepareMs),
    host_prepare_ms: roundedNonNegative(identity.hostPrepareMs),
    provider_registry_sync_ms: roundedNonNegative(identity.providerRegistrySyncMs),
    task_meta_read_ms: roundedNonNegative(identity.taskMetaReadMs),
    cli_request_ms: roundedNonNegative(identity.cliRequestMs),
    cli_bootstrap_ms: roundedNonNegative(identity.cliBootstrapMs),
    cli_session_restore_ms: roundedNonNegative(identity.cliSessionRestoreMs),
    initial_frame_encode_ms: roundedNonNegative(identity.initialFrameEncodeMs),
    initial_frame_transport_ms: roundedNonNegative(identity.initialFrameTransportMs),
    renderer_snapshot_apply_ms: roundedNonNegative(identity.rendererSnapshotApplyMs),
    react_render_ms: roundedNonNegative(identity.reactRenderMs),
    paint_to_interactive_ms: roundedNonNegative(identity.paintToInteractiveMs),
    cli_process_state: identity.cliProcessState,
    session_runtime_state: identity.sessionRuntimeState,
    attempt_count: positiveOrZeroInteger(identity.attemptCount),
    persisted_message_count: positiveOrZeroInteger(identity.persistedMessageCount),
    snapshot_row_count: positiveOrZeroInteger(identity.snapshotRowCount),
    snapshot_bytes: positiveOrZeroInteger(identity.snapshotBytes),
    plugin_count: positiveOrZeroInteger(identity.pluginCount),
    skill_count: positiveOrZeroInteger(identity.skillCount),
    mcp_server_count: positiveOrZeroInteger(identity.mcpServerCount),
    mcp_pending_at_interactive: identity.mcpPendingAtInteractive,
  };
  return {
    name: SESSION_OPEN_EVENT_RESULT,
    group: SESSION_OPEN_ARMS_GROUP,
    value: roundedNonNegative(identity.totalMs) ?? 0,
    properties,
  };
}

// buildSessionOpenStartArmsPayload 只构造载荷，再由 reportSessionOpenStart 调 emit，测试可直接断言返回值。
// 第二参数 targetReporter 优先于全局 reporter，供测试与特殊链路临时替换上报端。
// reportSessionOpenStart 返回 void 而不是 Promise，调用方不需要 await 也不会漏掉上报。
export function reportSessionOpenStart(
  identity: SessionOpenIdentity,
  targetReporter?: SessionOpenArmsReporter | null,
): void {
  emit(buildSessionOpenStartArmsPayload(identity), targetReporter);
}

export function reportSessionOpenResult(
  identity: SessionOpenIdentity & SessionOpenResultFields,
  targetReporter?: SessionOpenArmsReporter | null,
): void {
  emit(buildSessionOpenResultArmsPayload(identity), targetReporter);
}
