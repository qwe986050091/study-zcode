/* eslint-disable max-lines -- mock 网关集中模拟 availability、ticket、status、settle 与 messages，拆分会割裂共享票据状态。 */
/* off-peak 进程内 mock 网关。
   本地起 127.0.0.1 http 服务完整模拟 额度快照/取号/批量状态/结算/messages，
   真实 HTTP client 与 idle plan provider 的 baseURL 只需指到本网关 origin——生产代码路径
   与联调完全一致，联调时删掉 ZCODE_OFFPEAK_MOCK 开关即可（tech-design §10 工序 3）。

   ⚠ messages 端点在准入后把请求原样代理到 resolveUpstream() 指定的真实模型端点
   （通常是用户 coding plan 的 anthropic 兼容端点）——mock 模式下跑的是真模型、
   计费走用户自己的 key，仅用于开发/演示，文档已注明。

   状态机（对齐 D26 两轴的服务端轴）：
   take → queued（FIFO position）；status 轮询触发晋级（轮询即 Promote）：
   取号超过 readyDelayMs → ready（readyDeadline = +readyTtlMs）；ready 超时未发首个
   message → expired；首个 message 准入 → active（activeDeadline = +activeMs）；
   active 到期 → expired，messages 返回 400/3102；settle → settled（幂等）。
   messages 准入前可注入 N 次 429/3105 + Retry-After（模拟资源满载细阀，D24）。 */
// 模块职责：startOffPeakMockGateway —— 进程内 mock 闲时额度服务端；票据状态机与 messages 代理都在本文件。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ServiceLogger } from "../logger/serviceLogger.js";

// 所有时间参数都可调小，用于在 E2E 里快速走完 queued→ready→active→expired。
// 默认值在 startOffPeakMockGateway 内统一合并。
export interface OffPeakMockGatewayOptions {
  /** queued→ready 的晋级延迟；默认 15s（演示低峰等待）。 */
// queued 停留时长，0 表示取号即 ready。
  readyDelayMs?: number;
  /** ready 后须发首个 message 的窗口；默认 5min。 */
// ready 后必须发出首个 message，否则过期。
  readyTtlMs?: number;
  /** active 硬顶；默认 3h（调小可演示 400/3102 自动续跑）。 */
// active 硬顶；到期后 messages 返回 400/3102。
  activeMs?: number;
  /** 每张票准入前先回多少次 429/3105；默认 0。 */
// 每张票准入前的 429/3105 次数，用于验证细阀重试。
  queue429Count?: number;
  /** 前 N 次取号直接回 3103（免费额度耗尽），用于验证错误提示后仍可重试；默认 0。 */
// 前 N 次取号返回 3103，验证额度耗尽提示后仍可重试。
  quotaExhaustedCount?: number;
  /** availability 与真实取号保持不可用的时长；默认 0，E2E 用于验证服务端快照置灰。 */
// 额度快照不可用窗口，用于验证 UI 置灰。
  availabilityBlockedMs?: number;
  /** 429 的 Retry-After 秒数；默认 5。 */
// 429 响应带 Retry-After，客户端按此退避。
  retryAfterS?: number;
  /** status/take 下发的 next_poll_after 秒数；默认 5。 */
// 下发 next_poll_after，驱动客户端轮询节奏。
  nextPollS?: number;
  /** 仅供确定性 E2E 使用的 messages 脚本；生产与普通 mock 演示均不设置。 */
// 仅确定性 E2E 使用，普通 mock 不设置。
  scenario?: "foreground-subagents" | "capture" | "invalid-ticket";
}

// 上游解析依赖注入，网关自身不持有任何凭证。
export interface OffPeakMockGatewayDeps {
  logger: ServiceLogger;
  /**
   * 准入后 messages 的转发目标：完整 messages URL + 出站头（含上游鉴权）。
   * 返回 null = 不代理，直接回一段固定的 Anthropic 响应（E2E/离线演示：agent loop 立即完成，
   * 不依赖真实模型 key）。
   */
// 返回 null 表示离线回放，用于无 key 的 E2E。
// url 必须是完整 messages 地址。
  resolveUpstream: () => Promise<{
    url: string;
    headers: Record<string, string>;
  } | null>;
}

// mock 票据只保存在进程内存，不落库。
// taskId 用于同任务重取号时定位旧票。
interface MockTicket {
  ticketId: string;
  taskId: string;
// 与服务端两轴模型的状态一一对应。
  state: "queued" | "ready" | "active" | "expired" | "settled";
// 取号时间，queued 晋级据此计算。
  takenAt: number;
// 晋级时间用于计算 readyDeadline。
  readyAt?: number;
  readyDeadline?: number;
// active 到期时间，messages 每次都会检查。
  activeDeadline?: number;
// queue429Remaining 由 config.queue429Count 初始化，每回一次 429 细阀扣一次（见 handleMessages）。
  queue429Remaining: number;
  /** FIFO 序号，用于 position 计算。 */
// 全局递增序号，FIFO 位次据此计算。
  seq: number;
}

// 唯一开关：只有显式设为 1 才启用 mock。
export function isOffPeakMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ZCODE_OFFPEAK_MOCK"] === "1";
}

/** 环境变量覆盖数值选项（真机演示用；测试直接传 options）。 */
// 环境变量只接受非负有限数，非法值按未设置处理。
function readEnvOptions(env: NodeJS.ProcessEnv): OffPeakMockGatewayOptions {
  const num = (key: string): number | undefined => {
    const raw = env[key];
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
// 场景名走白名单收窄，避免任意字符串进入状态机。
  const scenarioValue = env["ZCODE_OFFPEAK_MOCK_SCENARIO"];
  const scenario =
    scenarioValue === "foreground-subagents" ||
    scenarioValue === "capture" ||
    scenarioValue === "invalid-ticket"
      ? scenarioValue
      : undefined;
  return {
    ...(num("ZCODE_OFFPEAK_MOCK_READY_DELAY_MS") !== undefined
      ? { readyDelayMs: num("ZCODE_OFFPEAK_MOCK_READY_DELAY_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_READY_TTL_MS") !== undefined
      ? { readyTtlMs: num("ZCODE_OFFPEAK_MOCK_READY_TTL_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_ACTIVE_MS") !== undefined
      ? { activeMs: num("ZCODE_OFFPEAK_MOCK_ACTIVE_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT") !== undefined
      ? { queue429Count: num("ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_QUOTA_COUNT") !== undefined
      ? { quotaExhaustedCount: num("ZCODE_OFFPEAK_MOCK_QUOTA_COUNT") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS") !== undefined
      ? {
          availabilityBlockedMs: num("ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS"),
        }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S") !== undefined
      ? { retryAfterS: num("ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_NEXT_POLL_S") !== undefined
      ? { nextPollS: num("ZCODE_OFFPEAK_MOCK_NEXT_POLL_S") }
      : {}),
    ...(scenario ? { scenario } : {}),
  };
}

// 捕获的请求只用于 E2E 断言，不参与业务决策。
interface OffPeakMockCapturedRequest {
// 三种鉴权头的存在性分别记录，用于验证头透传。
  hasApiKey: boolean;
  hasAuthorization: boolean;
  hasCodingPlanApiKey: boolean;
  maxTokens?: number;
  model?: string;
  requestJson: unknown;
// 请求所处的脚本阶段，用于断言调用顺序。
  stage: string;
  ticketId: string;
  organization?: string;
  project?: string;
}

// handle 只暴露 origin/port 与关闭方法。
// port 与 origin 同时返回，方便断言与日志。
export interface OffPeakMockGatewayHandle {
// 真实 HTTP client 的 baseURL 直接使用该值。
  origin: string;
  port: number;
  /** true = 端口已被另一个 host 的网关占用，本 handle 只是指向它（close 为 no-op）。 */
// 复用他人实例时 close 为空操作。
  external: boolean;
  close: () => Promise<void>;
}

/** 固定端口（可用 ZCODE_OFFPEAK_MOCK_PORT 覆盖）：多窗口多 host 时共享同一份 mock 票据状态。 */
// 固定端口让多 host 共享同一份票据状态。
const DEFAULT_MOCK_PORT = 45_197;

// 启动：默认值 → 环境变量 → 显式 options，后者覆盖前者。
export async function startOffPeakMockGateway(
  deps: OffPeakMockGatewayDeps,
  options?: OffPeakMockGatewayOptions & { port?: number },
): Promise<OffPeakMockGatewayHandle> {
// 配置合并顺序固定，options 永远最后覆盖。
  const config = {
    readyDelayMs: 15_000,
    readyTtlMs: 5 * 60_000,
    activeMs: 3 * 60 * 60_000,
    queue429Count: 0,
    quotaExhaustedCount: 0,
    availabilityBlockedMs: 0,
    retryAfterS: 5,
    nextPollS: 5,
    ...readEnvOptions(process.env),
    ...options,
  };
// 票据表以 ticketId 为键，全进程唯一。
  const tickets = new Map<string, MockTicket>();
// 额度注入计数只减不增，模拟一次性耗尽。
  let quotaInjectionsRemaining = config.quotaExhaustedCount;
// 不可用窗口从启动时刻起算。
// 窗口结束后 availability 自动恢复。
  const availabilityBlockedUntil = Date.now() + config.availabilityBlockedMs;
  /** taskId → 最新一张票（同 task_id 重新取号后旧票作废）。 */
// 同 task 重取号时据此作废旧票。
  const latestByTask = new Map<string, string>();
// 捕获列表按到达顺序追加。
  const capturedRequests: OffPeakMockCapturedRequest[] = [];
// 统计 3102 次数，供 E2E 断言客户端重取票。
  let invalidTicketRequests = 0;
// 在下一次 parent-wakeup 时把票置为 expired。
  let expireNextWake = false;
// 后台屏障：延迟返回，模拟真实的异步完成。
  let releaseBackground!: () => void;
  const backgroundBarrier = new Promise<void>((resolve) => {
    releaseBackground = resolve;
  });
// 序号单调递增，永不复用。
  let seqCounter = 0;

  /** 懒惰推进时间驱动的状态（轮询/messages 时评估，无后台计时器）。 */
// 时间驱动状态机：只在轮询与 messages 时评估，不跑后台计时器。
  function advance(ticket: MockTicket, now: number): void {
// 排队超过阈值即晋级 ready，并开启 TTL 窗口。
    if (ticket.state === "queued" && now - ticket.takenAt >= config.readyDelayMs) {
      ticket.state = "ready";
// 记录晋级时刻，便于调试时对照 deadline。
      ticket.readyAt = now;
// TTL 从真正晋级时刻起算。
      ticket.readyDeadline = now + config.readyTtlMs;
    }
    if (
      ticket.state === "ready" &&
      ticket.readyDeadline !== undefined &&
// ready 超时未发首个 message 即过期。
      now > ticket.readyDeadline
    ) {
      ticket.state = "expired";
    }
    if (
// active 到期同样转为 expired。
      ticket.state === "active" &&
      ticket.activeDeadline !== undefined &&
      now > ticket.activeDeadline
    ) {
      ticket.state = "expired";
    }
  }

  /** 排队位次 = 前面还有多少张未晋级的活票。 */
// 位次 = 序号更小的排队票数量 + 1。
  function positionOf(ticket: MockTicket): number {
    let ahead = 0;
    for (const other of tickets.values()) {
// 只把 state === "queued" 的票算作占位，已晋级到 ready/active 的不占位。
      if (other.state === "queued" && other.seq < ticket.seq) ahead += 1;
    }
// 返回 1-based 位次，0 只用于未知票。
    return ahead + 1;
  }

// 统一 JSON 响应，附带调用方指定的头。
  function json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): void {
// 头顺序不影响结果，后写覆盖前写。
    res.writeHead(status, { "content-type": "application/json", ...headers });
// 序列化失败会抛错，由路由层兜底成 500。
    res.end(JSON.stringify(body));
  }

// 空 body 与非法 JSON 都归一为空对象。
  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
// 统一按 UTF-8 解码，mock 只处理 JSON。
    const text = Buffer.concat(chunks).toString("utf8");
    try {
// 一次性读完，mock 请求体都很小。
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

// handleTake 顺序固定：校验 task_id → 额度拦截 → 作废旧票 → 建票 → advance 评估晋级。
  async function handleTake(req: IncomingMessage, res: ServerResponse): Promise<void> {
// 取号请求体只需要 task_id。
    const body = (await readBody(req)) as { task_id?: string };
    const taskId = body.task_id;
// 缺 task_id 属于契约错误，回 3000。
    if (!taskId) {
      json(res, 400, { code: 3000, msg: "task_id required" });
      return;
    }
    const now = Date.now();
// 不可用窗口内直接 3103，与 availability 保持一致。
    if (now < availabilityBlockedUntil) {
      json(res, 429, {
        code: 3103,
        msg: "free tier limit reached",
        data: { next_take_at: availabilityBlockedUntil },
      });
      return;
    }
// quotaInjectionsRemaining 每次 3103 响应扣 1，用注入次数模拟额度耗尽。
    if (quotaInjectionsRemaining > 0) {
      quotaInjectionsRemaining -= 1;
      json(res, 429, {
        code: 3103,
        msg: "free tier limit reached",
        data: { next_take_at: now + 60_000 },
      });
      return;
    }
    // 同 task_id 重新取号：旧票直接作废（真实服务端旧票已自然终态）。
// 同 task 重取号：旧票作废，模拟服务端自然终态。
    const previous = latestByTask.get(taskId);
    if (previous) {
      const old = tickets.get(previous);
// 只把 queued/ready/active 的旧票置为 expired，终态票无需处理。
      if (old && (old.state === "queued" || old.state === "ready" || old.state === "active")) {
        old.state = "expired";
      }
    }
// 序号在写票前递增，保证全局单调。
    seqCounter += 1;
    const ticket: MockTicket = {
// 票号可读，E2E 断言时便于定位。
      ticketId: `mock-ticket-${seqCounter}`,
      taskId,
      state: "queued",
      takenAt: now,
// 细阀次数按配置复制到每张票。
      queue429Remaining: config.queue429Count,
      seq: seqCounter,
    };
    // readyDelayMs=0 时取号即 ready（低峰空闲直接晋级的形态）。
// advance 会把 queued 直接推进到 ready。
    advance(ticket, now);
// 先入表再评估晋级，positionOf 才能看到自己。
    tickets.set(ticket.ticketId, ticket);
// 记录最新票，供下次重取号作废。
    latestByTask.set(taskId, ticket.ticketId);
    deps.logger.info(
      `mock gateway take task=${taskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
    json(res, 200, {
      ticket_id: ticket.ticketId,
// 回显 task_id，便于客户端校验对应关系。
      task_id: taskId,
      state: ticket.state,
// 取号成功：position 仅排队态有值。
      accepted: true,
      position: ticket.state === "queued" ? positionOf(ticket) : null,
      next_poll_after: config.nextPollS,
// 入队时间用于客户端展示与调试。
      queued_at: now,
// 只有已晋级才有 ready_deadline。
      ...(ticket.readyDeadline ? { ready_deadline: ticket.readyDeadline } : {}),
    });
  }

// 额度快照实时计算，不做缓存。
// 返回 200 只表示接口可用，不代表一定能取到号。
  function handleAvailability(res: ServerResponse): void {
    const now = Date.now();
    json(res, 200, {
// 布尔与 next_take_at 必须同时自洽。
      can_take_number: now >= availabilityBlockedUntil,
      ...(now < availabilityBlockedUntil ? { next_take_at: availabilityBlockedUntil } : {}),
    });
  }

// 批量状态：先截断到 100，再逐条推进时间状态机。
  async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)) as { ticket_ids?: string[] };
// ticket_ids 非数组时按空数组处理，不抛错。
    const ids = Array.isArray(body.ticket_ids) ? body.ticket_ids.slice(0, 100) : [];
    const now = Date.now();
    const entries = ids.map((id) => {
// advance 由每次轮询触发晋级，这是两轴模型「轮询即 Promote」的核心。
      const ticket = tickets.get(id);
// 未知票回 not_found，客户端据此重取。
      if (!ticket) return { ticket_id: id, state: "not_found" as const };
      advance(ticket, now);
      return {
        ticket_id: ticket.ticketId,
        task_id: ticket.taskId,
        state: ticket.state,
        position: ticket.state === "queued" ? positionOf(ticket) : null,
// active 票额外给出硬顶时间。
        ...(ticket.activeDeadline ? { active_deadline: ticket.activeDeadline } : {}),
      };
    });
// 顶层统一给轮询间隔，条目内不再重复。
    json(res, 200, { next_poll_after: config.nextPollS, tickets: entries });
  }

// 结算幂等，未知票同样回 200。
  function handleSettle(res: ServerResponse, ticketId: string): void {
    const ticket = tickets.get(ticketId);
// 已终态的票被再次结算也直接覆盖为 settled。
    if (ticket) ticket.state = "settled";
    // 幂等：未知票也 200。
    json(res, 200, {
      ticket_id: ticketId,
      state: "settled",
// settled_at 取服务端时钟，不用请求携带的时间。
      settled_at: Date.now(),
    });
  }

// messages 准入判定 + 上游代理。
  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
// 票据从专用头读取，缺头等同未知票。
    const ticketId = String(req.headers["x-off-peak-ticket-id"] ?? "");
    const ticket = tickets.get(ticketId);
    const now = Date.now();
// 每次请求先推进状态，避免依赖轮询。
    if (ticket) advance(ticket, now);
// 未知/过期/已结算统一回 3102。
    if (!ticket || ticket.state === "expired" || ticket.state === "settled") {
      json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
      return;
    }
// 该场景让每个请求都命中 3102，验证客户端重取票。
    if (config.scenario === "invalid-ticket") {
      // 让 E2E 走真实的 3102 终态路径：客户端必须重取票/保留原任务身份，
      // 且不能把失败的闲时请求偷偷改发到普通 Chat provider。
      invalidTicketRequests += 1;
      json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
      return;
    }
// 未晋级就发 message 属于防御分支，回 429。
    if (ticket.state === "queued") {
      // 粗阀未开就来了 message：按细阀排队应答（客户端不应走到这，防御分支）。
      json(
        res,
        429,
        { code: 3105, msg: "not ready" },
        { "retry-after": String(config.retryAfterS) },
      );
      return;
    }
// 细阀：准入前按配置回若干次 429/3105。
// 每次 429 都会递减，直到 0 才放行。
    if (ticket.queue429Remaining > 0) {
      ticket.queue429Remaining -= 1;
      json(
        res,
        429,
        { code: 3105, msg: "model concurrency saturated (mock)" },
        { "retry-after": String(config.retryAfterS) },
      );
      return;
    }
// 首个 message 即准入，进入 active 窗口。
    if (ticket.state === "ready") {
      // ready 5min 内首个 message 即准入 active，进入 3h 窗口。
      ticket.state = "active";
// activeDeadline 从准入时刻起算，等于 now + config.activeMs。
      ticket.activeDeadline = now + config.activeMs;
      deps.logger.info(
        `mock gateway admitted ticket=${ticketId} activeDeadline=${ticket.activeDeadline}`,
      );
    }
    // admitted：原样代理到真实上游（SSE 透传）。
// 代理需要完整原始字节，不能重新序列化。
    const requestBody = await (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    })();
// 解析只用于场景判定，失败不影响代理。
    const requestJson = parseMockRequestJson(requestBody);
// 只有这两个场景记录请求并按脚本应答。
    if (config.scenario === "foreground-subagents" || config.scenario === "capture") {
// 阶段由请求内容反推，不依赖外部状态。
      const stage = classifyForegroundSubagentScenarioRequest(requestJson);
      const maxTokens = readRequestNumber(requestJson, "max_tokens");
      const model = readRequestString(requestJson, "model");
      capturedRequests.push({
// 记录三类鉴权头的存在性，供断言头是否透传。
        hasApiKey: Boolean(req.headers["x-api-key"]),
        hasAuthorization: Boolean(req.headers.authorization),
        hasCodingPlanApiKey: Boolean(req.headers["x-coding-plan-api-key"]),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(model ? { model } : {}),
        requestJson,
        stage,
// 关联票据，便于把请求与任务对上。
        ticketId,
        ...(typeof req.headers["bigmodel-organization"] === "string"
          ? { organization: req.headers["bigmodel-organization"] }
          : {}),
        ...(typeof req.headers["bigmodel-project"] === "string"
          ? { project: req.headers["bigmodel-project"] }
          : {}),
      });
// 唤醒瞬间让票过期，模拟 3h 硬顶后的 3102。
      if (expireNextWake && stage === "parent-wakeup") {
        expireNextWake = false;
        ticket.state = "expired";
        invalidTicketRequests++;
// 把最后一条记录的 stage 改写成 parent-wakeup-expired，断言据此确认走了过期分支。
        capturedRequests[capturedRequests.length - 1]!.stage = "parent-wakeup-expired";
        json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
        return;
      }
// foreground 场景按阶段返回脚本化响应。
      const scripted =
        config.scenario === "foreground-subagents"
          ? buildForegroundSubagentScenarioResponse(
              stage,
              (server.address() as { port: number }).port,
            )
          : null;
      if (scripted) {
// 后台子代理挂起，等 E2E 显式放行。
// 放行动作由 E2E 的 release 端点触发。
        if (stage.startsWith("background-")) await backgroundBarrier;
// 按请求是否 stream 决定 JSON 或 SSE。
        respondWithAnthropicMock(res, scripted, readRequestBoolean(requestJson, "stream"));
        return;
      }
    }
// 未命中的场景一律经 deps.resolveUpstream 代理到真实上游。
    let upstream: { url: string; headers: Record<string, string> } | null;
    try {
      upstream = await deps.resolveUpstream();
    } catch (error) {
      deps.logger.warn("mock gateway resolveUpstream failed:", error);
// 解析失败降级为离线回放，避免 E2E 卡死。
      upstream = null;
    }
// 离线回放：返回一段 stop_reason=end_turn 的固定响应。
    if (!upstream) {
      // 离线/E2E：回一段固定的非流式 Anthropic 响应，agent loop 立即拿到 stop 收尾。
      json(res, 200, {
        id: "msg_offpeak_mock",
        type: "message",
        role: "assistant",
        model: "offpeak-mock",
// end_turn 让 agent loop 立即收尾。
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Off-peak mock run completed." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return;
    }
    try {
// 转发只带 content-type 与 anthropic-version，鉴权头由 upstream.headers 注入。
      const upstreamResponse = await fetch(upstream.url, {
        method: "POST",
        headers: {
          "content-type": String(req.headers["content-type"] ?? "application/json"),
// anthropic-version 必须透传，否则上游拒绝。
          ...(req.headers["anthropic-version"]
            ? { "anthropic-version": String(req.headers["anthropic-version"]) }
            : {}),
// upstream.headers 展开在最后，允许覆盖客户端自带的同名头。
          ...upstream.headers,
        },
        body: new Uint8Array(requestBody),
      });
// hop-by-hop 头不能透传，否则连接语义错乱。
      const responseHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, key) => {
        // hop-by-hop 头不透传。
        if (
// 这四个头由本地 HTTP 栈重新生成。
          ["transfer-encoding", "connection", "content-length", "content-encoding"].includes(key)
        ) {
          return;
        }
        responseHeaders[key] = value;
      });
// 状态码原样透传，错误语义保持一致。
      res.writeHead(upstreamResponse.status, responseHeaders);
// 空 body 直接结束，不构造流。
      if (!upstreamResponse.body) {
        res.end();
        return;
      }
// 逐块转发，保持 SSE 的实时性。
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
// reader 返回 done 即结束逐块转发。
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (error) {
      deps.logger.warn("mock gateway upstream proxy failed:", error);
// 代理失败统一 502，调用方按网络错误退避。
      json(res, 502, { code: 2001, msg: "mock upstream proxy failed" });
    }
  }

// 路由按「E2E 私有端点 → 业务端点 → 404」顺序匹配。
  const server: Server = createServer((req, res) => {
// 缺失 url 按空串处理，最终落到 404。
    const url = req.url ?? "";
// 路由体包在 void (async …) 里，异常统一由末尾的 .catch 兜底。
    void (async () => {
      if (
        req.method === "GET" &&
// E2E 私有端点：后台 bash 挂起直到放行。
        url === "/__e2e/off-peak/background-bash" &&
        config.scenario === "foreground-subagents"
      ) {
        capturedRequests.push({
          stage: "bash-started",
          requestJson: {},
          ticketId: "",
          hasApiKey: false,
          hasAuthorization: false,
          hasCodingPlanApiKey: false,
        });
// 等待 backgroundBarrier 才写响应，模拟真实异步命令的完成时刻。
        await backgroundBarrier;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("E2E_OFFPEAK_BACKGROUND_BASH_OK");
        return;
      }
      if (
        req.method === "POST" &&
// releaseBackground 放行后台屏障，expireOnWake 决定下一次 parent-wakeup 是否过期。
        url === "/__e2e/off-peak/release-background" &&
        config.scenario === "foreground-subagents"
      ) {
// release 端点的 body 可选，缺省不打开过期开关。
        const input = (await readBody(req)) as { expireOnWake?: boolean };
// 开关只影响下一次 parent-wakeup。
        expireNextWake = input.expireOnWake === true;
// 屏障只放行一次，重复调用无额外效果。
        releaseBackground();
        json(res, 200, { released: true });
        return;
      }
      if (
        req.method === "GET" &&
// 测试读取捕获结果与 3102 次数。
        url === "/__e2e/off-peak/requests" &&
        (config.scenario === "foreground-subagents" ||
          config.scenario === "capture" ||
          config.scenario === "invalid-ticket")
      ) {
        json(res, 200, {
// 返回统计与请求列表，全部只读。
          invalidTicketRequests,
          requests: capturedRequests,
        });
        return;
      }
// availability 是唯一允许 GET 的业务端点。
// 它不参与票据状态机。
      if (req.method === "GET" && url === "/api/v1/off-peak/ticket/availability") {
        handleAvailability(res);
        return;
      }
// 其余业务端点只接受 POST。
      if (req.method !== "POST") {
        json(res, 405, { msg: "method not allowed" });
        return;
      }
// POST /api/v1/off-peak/ticket 交给 handleTake 取号。
      if (url === "/api/v1/off-peak/ticket") {
        await handleTake(req, res);
        return;
      }
// 批量状态查询（轮询即晋级）。
      if (url === "/api/v1/off-peak/ticket/status") {
        await handleStatus(req, res);
        return;
      }
// 结算路径带票号，用正则提取后解码。
      const settleMatch = /^\/api\/v1\/off-peak\/ticket\/([^/]+)\/settle$/.exec(url);
// 票号可能被 URL 编码，必须解码后再查表。
      if (settleMatch) {
        handleSettle(res, decodeURIComponent(settleMatch[1]!));
        return;
      }
// messages 走独立处理，包含准入与代理。
      if (url === "/api/v1/off-peak/anthropic/v1/messages") {
        await handleMessages(req, res);
        return;
      }
// 未知路由显式 404，避免误判为成功。
      json(res, 404, { msg: `no mock route for ${url}` });
// 兜底：记录并尽量回 500。
// 已发送响应时无法再写 500，这里静默忽略。
    })().catch((error) => {
      deps.logger.warn("mock gateway handler failed:", error);
      try {
        json(res, 500, { msg: "mock gateway internal error" });
      } catch {
        // 响应已发出，忽略。
      }
    });
  });

// 端口优先级：显式参数 → 环境变量 → 默认固定端口。
  const requestedPort =
// 显式 port 优先级最高，便于并发测试。
    options?.port ??
    (Number(process.env["ZCODE_OFFPEAK_MOCK_PORT"]) > 0
      ? Number(process.env["ZCODE_OFFPEAK_MOCK_PORT"])
      : DEFAULT_MOCK_PORT);
  try {
// server.listen 绑定 127.0.0.1，不暴露到局域网。
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", () => resolve());
    });
  } catch (error) {
// 端口被占用说明已有网关实例，直接复用。
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // 多窗口：另一个 host 已起网关，共用它的票据状态（票在共享 sqlite 里跨 host 流转，
      // mock 状态必须单实例，否则 A 取的票在 B 的网关查不到）。
// 复用实例标记 external，关闭责任不在本进程。
      const origin = `http://127.0.0.1:${requestedPort}`;
      deps.logger.info(`off-peak mock gateway reusing existing instance at ${origin}`);
      return {
        origin,
        port: requestedPort,
        external: true,
        close: async () => {},
      };
    }
    throw error;
  }
// 绑定后必须拿到端口，否则视为启动失败。
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("off-peak mock gateway failed to bind");
  }
// 暴露的 origin 供 client 与 provider baseURL 使用。
  const origin = `http://127.0.0.1:${address.port}`;
// 启动日志打印 origin，联调时直接复制。
  deps.logger.info(`off-peak mock gateway listening at ${origin}`);
  return {
    origin,
    port: address.port,
    external: false,
    close: () =>
      new Promise<void>((resolve) => {
// 关闭只等待连接释放，不强制断开。
        server.close(() => resolve());
      }),
  };
}

// 前台子代理继承场景的脚本常量，E2E 用字符串匹配驱动。
const FOREGROUND_SUBAGENT_SCENARIO = {
// 父任务标记出现在请求里即进入该场景分支。
  parentMarker: "E2E_OFFPEAK_SUBAGENTS_PARENT",
  parentFinal: "E2E_OFFPEAK_SUBAGENTS_PARENT_OK",
  children: [
    {
      stage: "child-explore",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK",
      toolId: "toolu_e2e_offpeak_explore",
      input: {
        description: "Verify Explore foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK.",
// Explore 子代理验证内建类型继承。
        subagent_type: "Explore",
      },
    },
    {
      stage: "child-general-purpose",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK",
      toolId: "toolu_e2e_offpeak_general",
      input: {
        description: "Verify general-purpose foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK.",
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "child-code-search",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK",
      toolId: "toolu_e2e_offpeak_code_search",
      input: {
        description: "Verify custom Code Search foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK.",
        subagent_type: "Code Search",
      },
    },
    {
      stage: "child-custom-inherit",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK",
      toolId: "toolu_e2e_offpeak_inherit",
      input: {
        description: "Verify custom inherited-model foreground agent",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK.",
        subagent_type: "E2E OffPeak Inherit Reviewer",
      },
    },
  ],
  backgrounds: [
    {
      stage: "background-explicit",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT",
      toolId: "toolu_e2e_offpeak_background_explicit",
      input: {
        description: "Verify explicit background inheritance",
        prompt: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT: reply when released.",
        run_in_background: true,
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "background-profile",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE",
      toolId: "toolu_e2e_offpeak_background_profile",
      input: {
        description: "Verify profile background inheritance",
        prompt: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE: reply when released.",
        subagent_type: "E2E OffPeak Background Reviewer",
      },
    },
  ],
} as const;

// 解析失败返回空对象，场景判定退化为 unknown。
function parseMockRequestJson(requestBody: Buffer): unknown {
  try {
    return JSON.parse(requestBody.toString("utf8"));
  } catch {
    return {};
  }
}

// 三个读取工具都先做对象类型收窄。
function readRequestString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

// 数值必须是有限数，NaN 视为缺失。
function readRequestNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

// 只有严格 true 才为真，避免字符串 true 干扰。
function readRequestBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[key] === true;
}

// 阶段判定顺序很重要：标题 → 父任务 → 子代理 → 未知。
function classifyForegroundSubagentScenarioRequest(requestJson: unknown): string {
// 用 JSON.stringify 后的文本做 includes 匹配，忽略字段顺序与结构差异。
  const serialized = JSON.stringify(requestJson);
  // 标题包含相同用户素材，必须先按 system 任务区分，否则会误触发整套 Agent 脚本。
// 标题请求包含相同素材，必须最先区分。
  if (serialized.includes("Generate a concise title for this coding session."))
    return "session-title";
  if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentMarker)) {
// 父任务按「最终标记 / 工具 id / 初始」细分。
    if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentFinal)) return "parent-wakeup";
    if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.children[0].toolId))
      return "parent-continuation";
    return "parent-initial";
  }
// 子代理用各自 marker 匹配。
  for (const child of FOREGROUND_SUBAGENT_SCENARIO.children) {
    if (serialized.includes(child.marker)) return child.stage;
  }
// 后台子代理按 backgrounds[].marker 走同一套匹配。
  for (const background of FOREGROUND_SUBAGENT_SCENARIO.backgrounds) {
    if (serialized.includes(background.marker)) return background.stage;
  }
  if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentMarker)) {
    return "parent-initial";
  }
// 未命中任何标记时返回 unknown，交由上游代理。
  return "unknown";
}

// 按阶段生成 Anthropic 响应，未定义阶段返回 undefined。
function buildForegroundSubagentScenarioResponse(
  stage: string,
  port: number,
): AnthropicMockResponse | undefined {
// 标题阶段直接返回固定 JSON 标题。
  if (stage === "session-title") {
    return anthropicMockResponse({
      content: [{ type: "text", text: '{"title":"E2E 闲时后台验证"}' }],
      stopReason: "end_turn",
    });
  }
// 初始阶段一次性下发 bash + 全部子代理工具调用。
  if (stage === "parent-initial") {
    return anthropicMockResponse({
      content: [
        {
          type: "tool_use",
          id: "toolu_e2e_offpeak_bash",
          name: "Bash",
          input: {
            run_in_background: true,
// 后台 bash 会请求私有端点并挂起。
            command: `node -e 'fetch("http://127.0.0.1:${port}/__e2e/off-peak/background-bash").then(r=>r.text()).then(console.log)'`,
          },
        },
// children 的 4 个前台子代理一次性并行派发。
        ...FOREGROUND_SUBAGENT_SCENARIO.children.map((child) => ({
          type: "tool_use" as const,
          id: child.toolId,
          name: "Agent",
// 子代理参数原样透传，由 agent 侧解释。
          input: child.input,
        })),
// 两个后台子代理等放行后才返回。
        ...FOREGROUND_SUBAGENT_SCENARIO.backgrounds.map((background) => ({
          type: "tool_use" as const,
          id: background.toolId,
          name: "Agent",
// 后台子代理参数同样原样透传。
          input: background.input,
        })),
      ],
// tool_use 让 agent loop 继续下一轮。
      stopReason: "tool_use",
    });
  }
// 子代理阶段只回一段文本，结束该子会话。
  const child = FOREGROUND_SUBAGENT_SCENARIO.children.find(
    (candidate) => candidate.stage === stage,
  );
  if (child) {
    return anthropicMockResponse({
      content: [{ type: "text", text: child.reply }],
      stopReason: "end_turn",
    });
  }
// 后台阶段返回 marker_OK，供断言继承上下文。
  const background = FOREGROUND_SUBAGENT_SCENARIO.backgrounds.find(
    (candidate) => candidate.stage === stage,
  );
  if (background) {
    return anthropicMockResponse({
      content: [{ type: "text", text: `${background.marker}_OK` }],
      stopReason: "end_turn",
    });
  }
// 续跑与唤醒都回父任务最终标记。
  if (stage === "parent-continuation" || stage === "parent-wakeup") {
    return anthropicMockResponse({
      content: [{ type: "text", text: FOREGROUND_SUBAGENT_SCENARIO.parentFinal }],
      stopReason: "end_turn",
    });
  }
// 未匹配任何阶段的请求返回 undefined，由上游代理处理。
  return undefined;
}

// 只覆盖 mock 需要的最小 Anthropic 消息形状。
interface AnthropicMockResponse {
  content: readonly Record<string, unknown>[];
  id: string;
  model: string;
  role: "assistant";
  stop_reason: "end_turn" | "tool_use";
  type: "message";
  usage: { input_tokens: number; output_tokens: number };
}

// 固定 usage 与 model，断言不需要真实数值。
function anthropicMockResponse(input: {
  content: readonly Record<string, unknown>[];
  stopReason: "end_turn" | "tool_use";
}): AnthropicMockResponse {
  return {
// id 带 stopReason，便于在日志中区分。
    id: `msg_offpeak_mock_${input.stopReason}`,
    type: "message",
    role: "assistant",
    model: "offpeak-mock",
// stop_reason 决定 agent loop 是否继续。
    stop_reason: input.stopReason,
    content: input.content,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// 非流式直接回 JSON；流式则拼完整 SSE 序列。
function respondWithAnthropicMock(
  res: ServerResponse,
  response: AnthropicMockResponse,
  stream: boolean,
): void {
// 非流式响应体就是普通的 Anthropic message。
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

// SSE 顺序固定：message_start → 各 block → message_delta → message_stop。
  const events: string[] = [
    anthropicSseEvent("message_start", {
      type: "message_start",
      message: { ...response, content: [], stop_reason: null },
    }),
  ];
// 每个内容块生成 start/delta/stop 三事件。
  response.content.forEach((block, index) => {
// 工具调用用 input_json_delta 传完整 JSON。
    if (block.type === "tool_use") {
      events.push(
        anthropicSseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
// 工具调用起点先发空 input，细节走 delta。
            input: {},
          },
        }),
        anthropicSseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
// partial_json 必须是字符串化后的参数。
            type: "input_json_delta",
// 一次性发送完整参数，客户端拼接后解析。
            partial_json: JSON.stringify(block.input ?? {}),
          },
        }),
        anthropicSseEvent("content_block_stop", {
          type: "content_block_stop",
          index,
        }),
      );
      return;
    }
    events.push(
      anthropicSseEvent("content_block_start", {
        type: "content_block_start",
        index,
// 文本块起点为空串，正文走 text_delta。
        content_block: { type: "text", text: "" },
      }),
      anthropicSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
// 文本内容一次性下发。
        delta: { type: "text_delta", text: block.text ?? "" },
      }),
      anthropicSseEvent("content_block_stop", {
        type: "content_block_stop",
        index,
      }),
    );
  });
  events.push(
    anthropicSseEvent("message_delta", {
      type: "message_delta",
// message_delta 携带最终 stop_reason 与 usage。
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: response.usage,
    }),
// message_stop 是流结束的唯一信号。
    anthropicSseEvent("message_stop", { type: "message_stop" }),
  );
  res.writeHead(200, {
// SSE 必须禁用缓存，否则中间层会聚合。
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  });
// 事件已含空行分隔，直接拼接写出。
  res.end(events.join(""));
}

// 单条 SSE 事件的格式：event + data + 空行。
function anthropicSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
