// 默认 15 秒上限。第三方 Bot API（Telegram/飞书/微信 iLink）在异常时会长时间挂住连接，
// 而 Bot 的入站处理是串行 actor：一个悬挂请求会占住队列，后续权限确认、问答、计划审批全部停摆。
// 因此「有界」不是优化而是正确性要求（INV-10 的配套约束：超时由适配层兜底，重试交给上层）。
const BOT_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

// JSON 响应的统一形状：ok/status 直接来自 HTTP，payload 只在解析成功时存在。
// responseLogId 取自渠道的链路 ID 头（飞书/字节系为 x-tt-logid），用于把用户报障对应到服务端日志。
// [权衡] 不在这里抛「业务错误」：payload 里是否有错、错误码叫什么，各渠道差异太大，
// 适配层统一成 ok/status/payload 三元组，让上层按自己的协议解读。
export interface BotProviderJsonResponse<T> {
  ok: boolean;
  status: number;
  payload: T | undefined;
  responseLogId?: string;
}

// 只需要状态码时（如 Telegram 发送/typing）使用的轻量结果，不携带响应体。
// 之所以仍要读空响应体，见 fetchBotProvider 的说明：不读就等于没完成请求。
export interface BotProviderResponse {
  ok: boolean;
  status: number;
}

// 统一的请求执行器：合并外部取消信号与内部超时，并在同一个 deadline 下消费响应体。
// 输入：input/init 原样透传给 fetch（init.signal 会被替换，见下），consume 负责读完整响应体。
// 副作用：一个 AbortController、一个 setTimeout、一个外部 signal 监听器，全部在 finally 释放。
// 失败语义：网络错误、超时、外部取消、consume 内的解析错误都会向上抛，不在这里吞掉或重试。
async function runBotProviderRequest<T>(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  // 外部取消用「转发」而不是直接采用 externalSignal：内部还需要超时也能触发同一个 abort，
  // 两者必须汇聚到一个 signal 上，fetch 只接受一个。reason 一并透传，便于上游区分「用户取消」与「超时」。
  const onAbort = (): void => controller.abort(externalSignal?.reason);
  // 已经取消的信号不会再次触发 abort 事件，必须立即手动转发一次；
  // 否则后续 fetch 会带着一个已取消源头却仍活跃的 controller 发出去。
  if (externalSignal?.aborted) {
    onAbort();
  } else {
    // once:true 保证监听器最多触发一次；同时让 V8 可在取消后回收闭包。
    externalSignal?.addEventListener("abort", onAbort, { once: true });
  }
  // [资源] 定时器必须在 finally 清除：成功、失败、取消三条路径都要走到，
  // 否则一个已完成的请求仍会在 15 秒后触发 abort（虽然此时 controller 已无消费者，但会延长事件循环存活）。
  const timeout = setTimeout(() => {
    // 超时用 Error 作为 reason：fetch 会以该 reason reject，
    // 上层可据 message 里的毫秒数判断是本地超时而非渠道返回错误。
    controller.abort(new Error(`Bot provider request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  try {
    // 用 controller.signal 覆盖 init.signal：原始 signal 的取消已通过 onAbort 转发，
    // 直接传原 signal 会让超时无法生效（fetch 只认一个 signal）。
    const response = await fetch(input, { ...init, signal: controller.signal });
    // 修复原因：收到响应头不代表请求完成。必须在同一个 AbortSignal 和 deadline 下
    // 消费响应体，否则服务端 headers 后停滞仍会永久堵住 Bot actor 队列。
    // [失败路径] consume 抛错（读取中断、JSON 解析失败）会直接冒泡；此时定时器仍由 finally 清理，
    // 且响应体已被丢弃，不会出现「半截数据被当成成功」。
    return await consume(response);
  } finally {
    // [资源] 释放顺序无关但必须都执行：先清定时器防止其再次 abort，再移除监听器防止外部 signal 长期持有本闭包。
    // [并发] removeEventListener 对未添加过的监听器是 no-op，因此外部 signal 已 abort 的分支也能安全执行。
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 第三方 Bot API 不一定会自行结束悬挂请求。所有回调 ACK 和出站消息都必须有界，
 * 否则单个请求会占住 actor 串行队列，后续权限、问答和计划审批都无法继续。
 */
// 只要状态码的便捷封装。返回前会把响应体读空（arrayBuffer），这一步不是浪费：
// 只有读完 body，deadline 才真正覆盖整次传输；提前返回 Response 会让超时在响应头到达时就失效。
// 返回的 ok/status 即渠道语义，不额外判断业务错误（INV-02 的「拿到 id 才算成功」由调用方落实）。
export async function fetchBotProvider(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = BOT_PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<BotProviderResponse> {
  return runBotProviderRequest(input, init, timeoutMs, async (response) => {
    // Bugfix：fetch() 在响应头到达时就会完成，直接返回 Response 会提前撤销 deadline。
    // Telegram 调用方只需要状态，因此在受控 signal 下收完响应体后返回轻量结果。
    // [失败路径] 身体读取中断（超时/取消/连接重置）会在这里抛错，正是我们想要的行为：
    // 调用方不会拿到一个「状态码 200 但实际没传完」的假成功。
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status };
  });
}

// JSON 便捷封装：把响应体读成文本后按需解析。
// [失败路径] 解析失败的处理是分叉的：HTTP 成功但 JSON 非法 -> 抛错（协议被破坏，不能静默）；
// HTTP 失败且响应体不是 JSON -> payload 留空继续返回（错误页常是 HTML，状态码已足够表达失败）。
// 这个分叉避免了「4xx 的 HTML 错误页」把正常的状态码判断变成异常。
export async function fetchBotProviderJson<T>(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = BOT_PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<BotProviderJsonResponse<T>> {
  return runBotProviderRequest(input, init, timeoutMs, async (response) => {
    // 先读 text 而不是直接 response.json()：需要区分「空体」与「非法 JSON」，
    // 且要在同一 deadline 下完成读取（json() 内部同样受 signal 约束，但空体处理更清晰）。
    const text = await response.text();
    let payload: T | undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as T;
      } catch (error) {
        // 仅当 HTTP 成功时重抛：此时「声称成功却给不出合法 JSON」属于渠道违约，
        // 静默返回 undefined 会让上层把一次真实投递失败当成成功（违反 INV-02 的判定口径）。
        if (response.ok) {
          throw error;
        }
      }
    }
    // x-tt-logid 是飞书/字节系的链路 ID；缺失时保持 undefined 而不是空串，便于上层判断「有没有」。
    const responseLogId = response.headers.get("x-tt-logid") ?? undefined;
    return { ok: response.ok, status: response.status, payload, responseLogId };
  });
}
