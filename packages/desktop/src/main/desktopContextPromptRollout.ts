// INV-01 未下发配置视为关闭而不是沿用旧快照：守住位置 空配置分支；改错故障 服务端撤下开关后客户端仍长期开启。
// INV-02 业务码非零或 success=false 一律判为无效响应：守住位置 信封判断；改错故障 失败响应被当成关闭。
// INV-03 enabled 必须是布尔值，否则判无效：守住位置 typeof 检查；改错故障 字符串 false 被当成开启。
// INV-04 config_version 只接受去空白后的非空字符串：守住位置 trim 与长度判断；改错故障 版本号为空串污染缓存键。
// INV-05 版本号缺失时不得输出该字段：守住位置 条件展开；改错故障 序列化出现多余空键。
// INV-06 默认值必须是关闭：守住位置 defaultValue；改错故障 拉取失败时默认开启。
// INV-07 请求超时固定 3 秒：守住位置 DESKTOP_CONTEXT_PROMPT_REQUEST_TIMEOUT_MS；改错故障 启动被慢接口阻塞。
// INV-08 配置缓存 1 小时：守住位置 缓存时长常量；改错故障 频繁请求配置接口。
// INV-09 响应体上限 1 MiB：守住位置 最大响应字节常量；改错故障 超大响应耗尽内存。
// INV-10 超限必须中止请求并拒绝：守住位置 累计字节判断；改错故障 继续读取已超限响应。
// INV-11 非 2xx 状态直接失败：守住位置 statusCode 区间判断；改错故障 错误页被当成 JSON 解析。
// INV-12 所有结束路径只结算一次：守住位置 settled 标记；改错故障 resolve 与 reject 同时触发。
// INV-13 中止信号必须在结算时移除监听：守住位置 removeEventListener；改错故障 长生命周期信号泄漏闭包。
// INV-14 请求取消走 abort 而不是忽略结果：守住位置 onAbort；改错故障 中止后仍等待网络。
// INV-15 终点地址必须动态解析：守住位置 resolveEndpointOrigin；改错故障 环境切换后仍打旧域名。
// INV-16 请求头统一由来源上下文构造：守住位置 buildZCodeSourceHeadersFromContext；改错故障 缺少设备或语言标识。
// INV-17 解析失败保留原始错误类型：守住位置 instanceof Error 判断；改错故障 错误堆栈丢失。
// INV-18 本模块不缓存配置，缓存由单功能 rollout 负责：守住位置 模块边界；改错故障 两层缓存导致过期不一致。
//
// 模块职责：解析桌面上下文提示开关的远端配置，并产出 Electron 侧的配置拉取函数。
// 状态所有权：配置快照与缓存由单功能 rollout 持有；本文件只做解析与单次 HTTP 拉取。
// 阅读顺序：先看解析的失败语义，再看 rollout 装配，最后读请求生命周期与结算。
import {
  buildZCodeEndpointUrls,
  buildZCodeSourceHeadersFromContext,
  ZCODE_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@zcode/shared";
import {
  createSingleFeatureRollout,
  type SingleFeatureRollout,
  type SingleFeatureRolloutLogger,
} from "./singleFeatureRollout.js";

export { ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV };

export type DesktopContextPromptRolloutLogger = SingleFeatureRolloutLogger;
// 超时以单功能 rollout 的入参形式传入。
// 缓存有效期必须按小时计，避免频繁拉取；响应体上限是防御性阈值，不是业务限制；三个数值不能在调用点重复硬编码；调整超时需同步评估启动耗时。
export const DESKTOP_CONTEXT_PROMPT_REQUEST_TIMEOUT_MS = 3_000;
export const DESKTOP_CONTEXT_PROMPT_CACHE_TTL_MS = 60 * 60 * 1_000;
const DESKTOP_CONTEXT_PROMPT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface DesktopContextPromptConfig {
  enabled: boolean;
  configVersion?: string;
}

export type DesktopContextPromptRollout = SingleFeatureRollout<DesktopContextPromptConfig>;

// 必须先排除非对象载荷。
// 业务码与 success 共同决定响应是否可信。
// 成功但缺少配置段必须等价于关闭。
// enabled 类型不对时宁可判无效。
// 版本号必须去空白后再决定是否携带。
export function resolveDesktopContextPromptConfig(
  payload: unknown,
): DesktopContextPromptConfig | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const envelope = payload as {
    code?: unknown;
    success?: unknown;
    data?: {
      configs?: {
        desktopContextPrompt?: {
          enabled?: unknown;
          config_version?: unknown;
        } | null;
      } | null;
    } | null;
  };
  if ((envelope.code !== undefined && envelope.code !== 0) || envelope.success === false) {
    return null;
  }
  const config = envelope.data?.configs?.desktopContextPrompt;
  if (config === undefined || config === null) {
    // 服务端成功响应但未下发该单功能配置，语义是未启用；不能继续沿用旧的开启快照。
    return { enabled: false };
  }
  if (typeof config?.enabled !== "boolean") {
    return null;
  }
  const configVersion =
    typeof config.config_version === "string" && config.config_version.trim().length > 0
      ? config.config_version.trim()
      : undefined;
  return {
    enabled: config.enabled,
    ...(configVersion ? { configVersion } : {}),
  };
}

// 解析函数与默认值必须在此绑定；日志标签用于区分不同单功能开关；拉取与缓存参数必须原样透传；默认关闭保证失败安全；返回类型由泛型参数固定。
export function createDesktopContextPromptRollout(options: {
  fetchConfig: (signal: AbortSignal) => Promise<unknown>;
  logger: DesktopContextPromptRolloutLogger;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): DesktopContextPromptRollout {
  return createSingleFeatureRollout<DesktopContextPromptConfig>({
    resolveConfig: resolveDesktopContextPromptConfig,
    defaultValue: { enabled: false },
    logTag: "desktop-context-prompt",
    fetchConfig: options.fetchConfig,
    logger: options.logger,
    timeoutMs: options.timeoutMs,
    cacheTtlMs: options.cacheTtlMs,
  });
}

// electron 模块延迟导入，避免主进程启动期加载。
// 终点地址必须在每次请求时解析；查询参数只包含版本与平台；请求头按统一来源上下文生成；返回函数必须符合中止信号约定。
export function createElectronDesktopContextPromptConfigFetcher(options: {
  appVersion: string;
  deviceMid: string;
  resolveEndpointOrigin: () => Promise<string>;
  /** 当前界面语言；以前不传，X-Client-Language 固定为 unknown。 */
  getClientLanguage: () => string;
}): (signal: AbortSignal) => Promise<unknown> {
  return async (signal) => {
    const { net } = await import("electron");
    const endpointOrigin = await options.resolveEndpointOrigin();
    const url = new URL(`${buildZCodeEndpointUrls(endpointOrigin).origin}/api/v1/client/configs`);
    url.searchParams.set("app_version", options.appVersion);
    url.searchParams.set("platform", `${process.platform}-${process.arch}`);

    return await new Promise<unknown>((resolve, reject) => {
      const request = net.request(url.toString());
      let responseBytes = 0;
      let body = "";
      let settled = false;

      function onAbort() {
        request.abort();
        settle(() => reject(new Error("desktop context prompt config aborted")));
      }

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const sourceHeaders = buildZCodeSourceHeadersFromContext({
        appVersion: options.appVersion,
        arch: process.arch,
        clientLanguage: options.getClientLanguage(),
        deviceMid: options.deviceMid,
        endpointOrigin,
        platform: process.platform,
        releaseChannel: ZCODE_ENV,
        sourceTitle: "electron",
      });
      for (const [name, value] of Object.entries(sourceHeaders)) {
        request.setHeader(name, value);
      }
      request.on("response", (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          settle(() => reject(new Error(`desktop context prompt config failed: ${statusCode}`)));
          request.abort();
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          responseBytes += Buffer.byteLength(chunk);
          // 必须先累加再判断，保证跨块累计；超限立即结算并中止请求；中止后不再追加响应正文；该分支与状态码分支共用结算标记。
          if (responseBytes > DESKTOP_CONTEXT_PROMPT_MAX_RESPONSE_BYTES) {
            settle(() => reject(new Error("desktop context prompt config response too large")));
            request.abort();
            return;
          }
          body += chunk.toString();
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            settle(() => resolve(parsed));
          } catch (error) {
            settle(() => reject(error instanceof Error ? error : new Error(String(error))));
          }
        });
        response.on("error", (error) => {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        });
      });
      request.on("error", (error) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
      request.end();
    });
  };
}
