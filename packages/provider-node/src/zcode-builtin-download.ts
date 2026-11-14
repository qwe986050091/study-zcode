// INV-01 总预算覆盖两次请求：守住位置 定时器设置；改错故障 串行下载无上限拖死启动。
// INV-02 外部取消与超时合并：守住位置 信号合并；改错故障 调用方无法中途放弃。
// INV-03 未引用定时器不阻止退出：守住位置 释放调用；改错故障 进程因定时器滞留。
// INV-04 配置缺失返回空而非抛错：守住位置 空值判断；改错故障 未配置内置包时启动失败。
// INV-05 配置响应按严格模式校验：守住位置 模式解析；改错故障 多字段被静默接受。
// INV-06 下载地址只接受安全链接：守住位置 精化判断；改错故障 凭据随链接外泄。
// INV-07 请求不继承控制面鉴权：守住位置 请求选项；改错故障 用户令牌被发往第三方。
// INV-08 禁止跟随重定向：守住位置 重定向策略；改错故障 下载被引到任意新来源。
// INV-09 响应体设字节上限：守住位置 累计判断；改错故障 异常响应耗尽内存。
// INV-10 取消后立即停止读取：守住位置 循环内检查；改错故障 取消后仍继续拉取。
// INV-11 非成功响应先释放正文：守住位置 取消调用；改错故障 连接池被未读正文占住。
// INV-12 无正文按边界错误处理：守住位置 读取器判断；改错故障 空响应解析出空对象。
// INV-13 释放读取器锁：守住位置 收尾分支；改错故障 后续读取被锁阻塞。
// INV-14 错误只暴露阶段与原因：守住位置 错误消息；改错故障 带查询串的链接进入日志。
// INV-15 取消与超时区分原因：守住位置 三元判断；改错故障 排查时分不清是哪种中断。
// INV-16 模式错误只报首个路径：守住位置 问题取值；改错故障 用户看到一整墙校验错误。
// INV-17 阶段标记随流程推进：守住位置 赋值位置；改错故障 无法判断失败在配置还是下载。
// INV-18 定时器在收尾统一清理：守住位置 收尾分支；改错故障 成功路径也残留定时器。
//
// 模块职责：从控制面取内置 Provider 配置，再下载并解码内置发行包。
// 状态所有权：超时、阶段与取消都局限在单次调用内，无模块级状态。
// 阅读顺序：先看主流程与计时，再看正文读取，最后看错误归类。
import { z } from "zod";
import { decodeZCodeBuiltinRelease, type ZCodeBuiltinRelease } from "./zcode-builtin-release.js";

const clientConfigSchema = z
  .object({
    code: z.literal(0),
    data: z
      .object({
        configs: z
          .object({
            builtin_provider_config_json: z
              .string()
              .url()
              .refine((value) => {
                const url = new URL(value);
                return url.protocol === "https:" && !url.username && !url.password;
              })
              .optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export interface ZCodeBuiltinDownloadOptions {
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly request: (url: string | URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}

/** App/CLI 共用下载边界。总预算包含两次请求正文，不依赖 ApiClient 的响应头超时。 */
// 先建 AbortController 再挂 20_000 毫秒定时器：到点置 timedOut 为 true 并 abort。
// options.signal 存在时用 AbortSignal.any 与控制器信号合流，任一路 abort 都中断 readJson。
// stage 从 client-config 推进到 cdn，异常消息据此指出失败环节。
// downloadUrl 为 undefined 说明服务端未下发内置包，直接返回 null 且不发起 CDN 请求。
export async function downloadZCodeBuiltinRelease(
  options: ZCodeBuiltinDownloadOptions,
): Promise<ZCodeBuiltinRelease | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let stage = "client-config";
  try {
    const url = new URL("/api/v1/client/configs", options.endpointOrigin);
    url.searchParams.set("app_version", options.appVersion);
    url.searchParams.set("platform", options.platform);
    const payload = clientConfigSchema.parse(await readJson(url));
    const downloadUrl = payload.data.configs.builtin_provider_config_json;
    if (downloadUrl === undefined) return null;
    stage = "cdn";
    return decodeZCodeBuiltinRelease(await readJson(new URL(downloadUrl)));
  } catch (error) {
    // 不能把带 query 的 URL、响应正文或 Schema 输入（可能含凭据）交给上层日志。
    const reason = signal.aborted
      ? timedOut
        ? "timeout"
        : "cancelled"
      : error instanceof DownloadBoundaryError
        ? error.message
        : error instanceof z.ZodError
          ? `invalid schema at ${error.issues[0]?.path.join(".") || "root"} (${error.issues[0]?.code})`
          : "invalid response";
    throw new Error(`ZCode Built-in ${stage}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  // 进入 readJson 先调 signal.throwIfAborted()，已取消时不再构造 RequestInit。
  // 请求固定 credentials: "omit" 与 redirect: "error"，既不带控制面凭据也不允许换源。
  // bytes 累加每次 chunk 的 byteLength，超过 10_000_000 抛 DownloadBoundaryError。
  // finally 里 reader.releaseLock() 释放锁；异常路径先 reader.cancel() 再向外抛。
  async function readJson(url: URL): Promise<unknown> {
    signal.throwIfAborted();
    // 每次新建请求选项，不继承控制面鉴权；不跟随重定向把下载变成任意新来源。
    const response = await abortable(
      options
        .request(url, { method: "GET", signal, credentials: "omit", redirect: "error" })
        .then((value) => {
          if (signal.aborted) {
            void value.body?.cancel().catch(() => {});
            signal.throwIfAborted();
          }
          return value;
        }),
      signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new DownloadBoundaryError(`HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DownloadBoundaryError("empty body");
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 10_000_000) throw new DownloadBoundaryError("body limit exceeded");
        chunks.push(decoder.decode(part.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      signal.throwIfAborted();
      return JSON.parse(chunks.join("")) as unknown;
    } catch (error) {
      // cancel 不得成为新的无期限等待；释放 reader 后底层请求仍由同一 signal 取消。
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

// DownloadBoundaryError 只承载边界失败原因，网络异常不包装成这个类型。
// 抛出的消息固定为 ZCode Built-in 加 stage 加 reason，不携带 URL query 与响应正文。
// signal.aborted 时以 timedOut 区分 timeout 与 cancelled，两者都优先于原始 error。
class DownloadBoundaryError extends Error {}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
