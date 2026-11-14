import {
  CliOAuthError,
  type CliOAuthClient,
  type CliOAuthInitData,
  type CliOAuthPollData,
  type CliOAuthReadyData,
} from "@zcode/adapters/auth";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";

const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * 轮询直到服务端返回 ready，或 deadline/取消先到。
 *
 * - deadline 取 `min(now + timeoutMs, init.expires_at)`：两个上限都必须遵守，授权码过期
 *   后继续轮询只会拿到无意义结果；
 * - 轮询间隔取 `max(1s, poll_interval_sec)`，避免服务端给 0 时打成忙等；
 * - 仅把「明确失败」当 auth_failed；408/429/5xx 与网络异常按服务端间隔重试（与 App 口径一致），
 *   不在一次瞬时抖动后直接终止登录；
 * - 每次 sleep 都裁剪到剩余时间，保证 deadline 不会被一次长等待越过；
 * - 取消优先于任何返回值：迟到 ready 也必须先 throwIfAborted 再落凭据。
 */
export async function pollUntilReady(input: {
  createError: (code: "auth_failed" | "auth_timeout") => Error;
  abortSignal?: AbortSignal;
  initData: CliOAuthInitData;
  now: () => number;
  oauthClient: CliOAuthClient;
  onPollStatus?: (data: CliOAuthPollData) => void | Promise<void>;
  pollToken: string;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}): Promise<CliOAuthReadyData> {
  const expiresAtMs = input.initData.expires_at * 1_000;
  const deadlineMs = Math.min(input.now() + input.timeoutMs, expiresAtMs);
  const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, input.initData.poll_interval_sec * 1_000);

  while (input.now() < deadlineMs) {
    throwIfAborted(input.abortSignal);
    let data: CliOAuthPollData = { status: "pending" };
    try {
      data = await waitWithAbort(
        input.oauthClient.poll(
          {
            flowId: input.initData.flow_id,
            pollToken: input.pollToken,
          },
          { signal: input.abortSignal },
        ),
        input.abortSignal,
      );
    } catch (error) {
      throwIfAborted(input.abortSignal);
      if (
        error instanceof CliOAuthError &&
        !(error.httpStatus === 408 || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500)
      )
        throw error;
      // Match App polling: transient network and server failures retry at the server interval.
    }
    throwIfAborted(input.abortSignal);
    if (input.now() >= deadlineMs) break;
    // 先上报状态再判断终态：调用方能看到最后一次 pending，便于 UI 收尾。
    await input.onPollStatus?.(data);

    if (data.status === "ready") {
      return data;
    }
    if (data.status === "failed") {
      throw input.createError("auth_failed");
    }

    // sleep 与轮询请求一样受 signal 控制；剩余时间为负时夹到 0，下一轮立即退出。
    await waitWithAbort(
      input.sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - input.now()))),
      input.abortSignal,
    );
  }

  throw input.createError("auth_timeout");
}
