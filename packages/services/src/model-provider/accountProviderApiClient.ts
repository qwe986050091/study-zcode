// /api/biz 响应的最小客户端：解析信封并按 code 判定成功，业务失败一律降级为 null。
// INV-01：远端 code 语义不统一（0 与 200 都表示成功），判定集中在 isSuccessfulRemoteCode。
// INV-02：本类不抛业务错误；网络/解析异常仍由 readApiJson 抛出，调用方只看 null 判空。
import { type ApiClient } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import type { RemoteEnvelope } from "./accountProviderApiTypes.js";

// 缺省 code 视为成功：部分接口直接返回 data 而不带信封；
// 数字与字符串两种形态都要接受，否则透传的 "200" 会被误判为失败。
function isSuccessfulRemoteCode(code: unknown): boolean {
  if (code === null || code === undefined) {
    return true;
  }
  if (typeof code === "number") {
    return code === 0 || code === 200;
  }
  if (typeof code === "string") {
    return code === "0" || code === "200";
  }
  return false;
}

// 只持有 ApiClient，无额外状态；同一实例可被多个账号解析器共享。
export class AccountProviderApiClient {
  constructor(readonly apiClient: ApiClient) {}

  async fetchRemoteData<T>(url: string, init: RequestInit): Promise<T | null> {
    const payload = await readApiJson<RemoteEnvelope<T>>(this.apiClient, url, init);
    // BigModel 部分业务接口成功时返回 code=200，而不是 code=0。
    if (!isSuccessfulRemoteCode(payload.code)) {
      return null;
    }

// [失败路径] data 为 undefined 时返回 null 而不是 undefined，统一调用方的空值判断。
    return payload.data ?? null;
  }
}
