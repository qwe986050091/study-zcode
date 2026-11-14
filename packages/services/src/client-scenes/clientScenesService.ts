// 场景服务只负责把统一 ApiClient 与固定场景端点拼成一次只读请求，不做缓存、重试与响应加工。
// INV：端点必须取自 apiEndpoints 常量，禁止在本文件硬编码 URL 或夹带业务参数，否则多环境切换会静默打到错误后端。
// INV：list 原样返回服务端 ClientScenesResponse，任何字段裁剪或默认值填充都会让上层场景配置缺项且难以察觉。
// 维护提示：鉴权头与超时策略归 ApiClient 与 readApiJson 管理，此处新增分支会绕开统一错误映射。
import type { ApiClient } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import { ZCODE_CLIENT_SCENES_URL } from "../providers/api/apiEndpoints.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

// 工厂保持无状态：每次调用新建闭包；若改为模块级单例，需自行承担 apiClient 生命周期与热更新的失效风险。
export function createClientScenesService(dependencies: {
  apiClient: ApiClient;
}): IClientScenesService {
  return {
    list: () =>
      readApiJson<ClientScenesResponse>(dependencies.apiClient, ZCODE_CLIENT_SCENES_URL, {
        method: "GET",
      }),
  };
}
