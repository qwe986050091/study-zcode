// 组装 ProjectAccessTokenClient：把服务层 ApiClient 适配成换证服务需要的请求函数。
// INV-01：只有 404 被降级成 { code: 404 }，其余错误原样上抛，不能把 401/403 吞成空数据。
// INV-02：429、5xx 与连接层异常统一映射为 ProjectAccessTokenTransientError，让缓存层
//          回退到仍在有效期内的旧令牌；JSON 解析失败与未知异常必须保持原样。
// INV-03：每个鉴权 owner 只持有一个实例，项目定位缓存与在途合并依赖实例唯一性。
import {
  ApiError,
  ProjectAccessTokenClient,
  ProjectAccessTokenTransientError,
  type ApiClient,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import type { LocalCredentialService } from "#src/credential/credentialService.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "#src/providers/api/apiJson.js";

// 15s 覆盖定位 + 换证两次 RTT；超过后按传输异常处理，由缓存层决定是否复用旧令牌。
const PROJECT_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("project-access-token");

/** 本地与旧远程附加入口复用同一 HTTP/ID 存储约束，每个鉴权 owner 只持有一个实例。 */
// 依赖只取 load/save/delete：定位缓存只需要键值读写，不感知凭据的加密格式。
export function createAccountProjectTokenClient(
  apiClient: ApiClient,
  credentialService: Pick<ICredentialService, "load" | "save" | "delete"> &
    Partial<Pick<LocalCredentialService, "recoverUnreadable">>,
): ProjectAccessTokenClient {
  return new ProjectAccessTokenClient({
// request 必须自己判错误类型：换证客户端只区分成功、瞬时失败与致命失败，
// 不知道 ApiError 与 DOMException 的差别。
    request: async (url, init) => {
      try {
        return await readApiJson(apiClient, url, {
          ...init,
          timeoutMs: PROJECT_TOKEN_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
// [失败路径] 404 表示项目已不存在：返回空信封让换证服务走「无项目」分支，而不是抛错中断登录。
        if (error instanceof ApiError && error.status === 404) return { code: 404 };
        // 仅承认传输异常/内部超时及临时 HTTP 状态；JSON 解析和未知异常不能恢复旧 PAT。
        if (
          error instanceof ApiError &&
          (error.status === 429 ||
            (error.status !== undefined && error.status >= 500 && error.status < 600) ||
            (error.status === undefined &&
              (error.cause instanceof TypeError ||
                (error.cause instanceof DOMException &&
                  ["AbortError", "TimeoutError"].includes(error.cause.name)))))
        )
// [失败路径] 只把 429、5xx 和无 status 的连接层错误归为瞬时；AbortError/TimeoutError
// 是本端超时，同样按瞬时处理，但其它 DOMException 或解析失败要原样抛出。
          throw new ProjectAccessTokenTransientError();
        throw error;
      }
    },
// locationStore 缓存「账号 → 项目 + Key ID」定位；recoverUnreadable 是本地存储可选的解密修复入口。
    locationStore: credentialService,
// observe 只在有诊断价值时打 warn：提前刷新暂缓属于正常降级，定位缓存不可读会触发恢复，
// 其余统一按「获取失败」记录，避免为每个事件维护独立日志级别。
    observe: (event) =>
      log.warn(
        undefined,
        event.code === "project_token_refresh_deferred"
          ? "项目 Token 提前刷新暂缓"
          : event.code === "project_token_location_unreadable"
            ? "项目定位缓存无法解密，准备局部恢复"
            : event.code === "project_token_location_recovery"
              ? "项目定位缓存复核完成"
              : "项目 Token 获取失败",
        event,
      ),
  });
}
