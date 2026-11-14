/* off-peak 服务端五接口客户端。
   只负责 额度快照/取号/批量查状态/结算 四个 JSON 接口——messages 调模型不走这里
   （由 idle plan per-turn provider 在 agent 进程内直连，D33）。
   无内建重试：排队/退避语义在调用方（offPeakTaskService 轮询 / 适配层 D24）。 */
import { z } from "zod";
import type { OffPeakTakeNumberAvailability } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  withRequestIdHeader,
  REQUEST_ID_HEADER_NAME,
} from "#src/providers/api/requestIdHeaders.js";
import { buildZCodeSourceHeaders } from "#src/providers/sourceHeaders.js";
import {
  buildOffPeakPlanIdentityHeaders,
  type OffPeakCredentialSnapshot,
} from "./offPeakRuntimeModel.js";

/** 服务端准入态（两轴状态机的服务端轴）。 */
// 状态枚举覆盖排队到结算全链路，not_found 也是合法状态。
export const offPeakTicketStateSchema = z.enum([
  "queued",
  "ready",
  "active",
  "expired",
  "settled",
  "not_found",
]);
// 状态类型由 schema 推导，避免枚举与类型漂移。
export type OffPeakTicketState = z.infer<typeof offPeakTicketStateSchema>;

// 响应字段 snake_case 按服务端 v2；宽容解析（loose），未知字段不报错。
// ⚠ next_poll_after 单位按"秒"实现（与 Retry-After 同惯例）。
// 取号响应：ticket_id 与 state 是仅有的必填字段，其余按状态可选。
const takeTicketResponseSchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    accepted: z.boolean().optional(),
    // 服务端仅在 queued 态返回数字，进入 ready/active 等状态后会显式返回 null；
    // 这里接受 null，并在领域模型映射时归一化为字段缺省，避免整批状态同步被解析失败中断。
    position: z.number().int().nonnegative().nullish(),
    next_poll_after: z.number().nonnegative().optional(),
    queued_at: z.number().optional(),
    ready_deadline: z.number().optional(),
  })
  .passthrough();

// 批量状态条目复用同一状态枚举，但用 active_deadline 替代 ready_deadline。
const ticketStatusEntrySchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    position: z.number().int().nonnegative().nullish(),
    active_deadline: z.number().optional(),
  })
  .passthrough();

// tickets 缺省为空数组，兼容服务端省略空列表。
const batchStatusResponseSchema = z
  .object({
    next_poll_after: z.number().nonnegative().optional(),
    tickets: z.array(ticketStatusEntrySchema).default([]),
  })
  .passthrough();

// 结算响应只做形状校验，字段全部可选。
const settleResponseSchema = z
  .object({
    ticket_id: z.string().min(1).optional(),
    task_id: z.string().optional(),
    state: z.string().optional(),
    settled_at: z.number().optional(),
  })
  .passthrough();

// 额度快照：can_take_number=false 时契约要求带 next_take_at。
const takeNumberAvailabilityResponseSchema = z
  .object({
    can_take_number: z.boolean(),
    next_take_at: z.number().int().positive().optional(),
  })
  .passthrough();

/** 业务错误体（HTTP 非 2xx 时尽力解析；zai 网关惯例 code/msg，字段缺失容忍）。 */
// 错误体字段全部宽容，避免网关换文案掩盖真实 HTTP 状态。
const errorBodySchema = z
  .object({
    code: z.number().optional(),
    msg: z.string().optional(),
    message: z.string().optional(),
    next_take_at: z.number().optional(),
    data: z
      .object({ next_take_at: z.number().int().positive().optional() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

// 对外领域模型统一 camelCase，并已把秒换算成毫秒。
export interface OffPeakTakeTicketResult {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  /** 下次轮询间隔（毫秒；服务端下发秒，此处已换算）。 */
  nextPollAfterMs?: number;
  registeredAt: number;
}

// 批量条目不带 next_poll_after，轮询节奏由响应顶层统一给出。
export interface OffPeakTicketStatusEntry {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  activeDeadline?: number;
}

// 顶层 next_poll_after 缺省时由调用方使用自己的默认退避。
export interface OffPeakBatchStatusResult {
  nextPollAfterMs?: number;
  tickets: OffPeakTicketStatusEntry[];
}

/** 类型化服务端错误：调用方按 bizCode 分流（3101 无资格 / 3103 取号超限 / 其余）。 */
// 同时保留 httpStatus 与 bizCode，调用方按业务码分流而非文本匹配。
export class OffPeakServerError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly bizCode?: number,
    readonly nextTakeAt?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "OffPeakServerError";
  }
}

// origin 允许异步：mock 网关可能首次调用才启动并返回端口。
export interface OffPeakServerClientDeps {
  /** API origin（真实服务端或 mock 网关，ZCODE_OFFPEAK_MOCK 切换在装配层）；mock 网关懒启动故允许异步。 */
// 每次请求都重新解析 origin，兼容网关重启换端口。
  resolveOrigin: () => string | Promise<string>;
  /** 凭证快照：四个 ticket 接口统一携带同一次 selected credential snapshot。 */
// 凭证每次请求重新解析，保证切换账号后立即生效。
  resolveCredentials: () => Promise<OffPeakCredentialSnapshot>;
  fetchImpl?: typeof fetch;
  logger: ServiceLogger;
}

// 单请求 10 秒超时，超时以 AbortError 抛出，本层不重试。
const REQUEST_TIMEOUT_MS = 10_000;

// 四个接口与契约一一对应，不额外暴露底层 request。
export interface OffPeakServerClient {
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  takeTicket(taskId: string): Promise<OffPeakTakeTicketResult>;
  batchStatus(ticketIds: string[]): Promise<OffPeakBatchStatusResult>;
  settle(ticketId: string): Promise<void>;
}

// 工厂函数注入 fetch 与凭证解析，测试可完全离线。
export function createOffPeakServerClient(deps: OffPeakServerClientDeps): OffPeakServerClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

// 统一请求入口：装头、超时、错误映射与信封拆解都收敛在这里。
  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
// 凭证先取，避免请求发出后才发现登录态缺失。
    const credentials = await deps.resolveCredentials();
    const controller = new AbortController();
// 计时器在 finally 清理，异常路径不会泄漏。
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
// origin 可能触发 mock 网关懒启动，因此每次请求都 await。
      const origin = await deps.resolveOrigin();
      // 该 client 直接使用 fetch，过去绕过 NodeApiClient 的来源头与 request id 注入；
      // test 服务端只能看到 user_agent=node，且客户端日志无法关联 2007/裸 429 的服务端请求。
      // 这里只补标准非敏感来源头和链路 id，JWT/API Key 仍禁止进入日志。
// request id 同时写入请求与错误日志，便于和服务端日志对齐。
      const headers = withRequestIdHeader({
        ...buildZCodeSourceHeaders(),
// 只有带 body 的请求才声明 content-type。
        ...(body === undefined ? {} : { "content-type": "application/json" }),
// JWT 作为 authorization，兼容客户端的 x-api-key 由上游转换。
        authorization: `Bearer ${credentials.jwt}`,
        "x-coding-plan-api-key": credentials.codingPlanApiKey,
        ...buildOffPeakPlanIdentityHeaders(credentials),
      });
// 路径前缀固定，path 只由本文件内部常量传入。
      const response = await fetchImpl(`${origin}/api/v1/off-peak${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
// 先读文本再解析，兼容空 body 与非 JSON 错误页。
      const text = await response.text();
      const json: unknown = text ? safeJsonParse(text) : {};
// 非 2xx 一律转类型化错误，保留业务码与恢复时间。
      if (!response.ok) {
// 错误体解析失败不阻断，退化为只有 HTTP 状态的错误。
        const parsed = errorBodySchema.safeParse(json);
        const errorBody = parsed.success ? parsed.data : {};
// 优先取服务端回显的 request id，其次用本地生成值。
        const requestId =
          response.headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          undefined;
        // 可恢复的服务端拒绝使用 warn；只记录契约元数据，禁止记录凭证原文、指纹或响应体。
// [安全] warn 只带 bizCode/credentialKind/httpStatus：指纹与响应体原文一律不得进日志。
        deps.logger.warn(undefined, "off-peak request rejected", {
          bizCode: errorBody.code,
          credentialKind: credentials.kind,
          httpStatus: response.status,
          method,
          path,
          requestId,
        });
// message 拼接业务码与文案，方便只看日志时定位。
        throw new OffPeakServerError(
          `off-peak ${path} failed: HTTP ${response.status}${errorBody.code ? ` code=${errorBody.code}` : ""}${(errorBody.msg ?? errorBody.message) ? ` ${errorBody.msg ?? errorBody.message}` : ""}`,
          response.status,
          errorBody.code,
          errorBody.next_take_at ?? errorBody.data?.next_take_at,
          requestId,
        );
      }
      // 兼容裸体与 {code:0,data} 信封两种形态（v2 文档为裸体；网关惯例可能包信封）。
      if (
        json &&
        typeof json === "object" &&
// 兼容网关信封：code=0 时只取 data。
        "data" in json &&
        (json as { code?: number }).code === 0
      ) {
        return (json as { data: unknown }).data;
      }
// 裸体响应原样返回，由各接口的 schema 校验。
      return json;
    } finally {
// 无论成功失败都清理超时计时器。
      clearTimeout(timer);
    }
  }

  return {
// 额度接口 GET 无 body，返回布尔与下次可取时间。
    async getTakeNumberAvailability() {
// 失败即抛错，UI 侧 fail-open 允许继续尝试取号。
      const raw = await request("GET", "/ticket/availability");
      const parsed = takeNumberAvailabilityResponseSchema.parse(raw);
      // 缺少恢复时间的 false 快照会让 UI 无法安排重查，再次形成永久灰态。
      // 契约要求 false 必带 next_take_at；脏响应按查询失败处理，由 UI fail-open、POST /ticket 兜底。
// 不可取号却无恢复时间视为脏响应，直接判失败。
      if (!parsed.can_take_number && parsed.next_take_at === undefined) {
        throw new Error("off-peak availability missing next_take_at while unavailable");
      }
      return {
// 只有可取号时才没有恢复时间，用展开保证字段缺省。
        canTakeNumber: parsed.can_take_number,
        ...(parsed.next_take_at !== undefined ? { nextTakeAt: parsed.next_take_at } : {}),
      };
    },
// 取号是唯一会产生新票据的写接口。
    async takeTicket(taskId) {
      const raw = await request("POST", "/ticket", { task_id: taskId });
// schema 必填 ticket_id 与 state，缺一即抛解析错误。
      const parsed = takeTicketResponseSchema.parse(raw);
      deps.logger.info(
        undefined,
        `off-peak take ticket ok task=${taskId} ticket=${parsed.ticket_id} state=${parsed.state} position=${parsed.position ?? "-"}`,
      );
      return {
// 取号成功已在上方打 info：每次派发只发生一次，频率可控。
        ticketId: parsed.ticket_id,
        state: parsed.state,
        ...(parsed.position != null ? { position: parsed.position } : {}),
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
// 注册时间用于本地计算轮询超时与展示。
        registeredAt: Date.now(),
      };
    },
// 批量查询：空输入直接返回，不发起请求。
    async batchStatus(ticketIds) {
      if (ticketIds.length === 0) return { tickets: [] };
      // 契约上限 ≤100；调用方 listNonTerminal 规模远小于此，超限截断并警告而非拆包。
      // 单用户非终态任务数达到 100 前，服务端取号上限早就先挡住了。
// 契约上限 100，超出截断并告警，不拆包。
      const limited = ticketIds.slice(0, 100);
      if (limited.length < ticketIds.length) {
        deps.logger.warn(`off-peak batch status truncated ${ticketIds.length} -> 100`);
      }
      const raw = await request("POST", "/ticket/status", {
        ticket_ids: limited,
      });
// 返回顺序不保证与入参一致，调用方按 ticketId 匹配。
      const parsed = batchStatusResponseSchema.parse(raw);
      return {
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        tickets: parsed.tickets.map((entry) => ({
          ticketId: entry.ticket_id,
          state: entry.state,
          ...(entry.position != null ? { position: entry.position } : {}),
          ...(entry.active_deadline !== undefined ? { activeDeadline: entry.active_deadline } : {}),
        })),
      };
    },
// 结算幂等：重复上报或未知票据服务端都返回 2xx。
    async settle(ticketId) {
      // 幂等：重复上报/未知票一律 2xx；无 body。
      const raw = await request("POST", `/ticket/${encodeURIComponent(ticketId)}/settle`);
// 成功路径只校验形状，不消费返回值。
      settleResponseSchema.parse(raw);
      deps.logger.info(undefined, `off-peak settle acked ticket=${ticketId}`);
    },
  };
}

// 解析失败返回空对象，让上层按缺字段处理。
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
