import {
  zcodeProtocolMethods,
  zcodePluginsReferenceCatalogResultSchema,
  type ZCodePluginsReferenceCatalogParams,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
// 优先请求带分类字段的新方法，失败时回退到旧方法；
// 两条路径共用同一响应 schema，调用方无需感知差异。
export async function requestPluginReferenceCatalog(
  client: Pick<ZCodeProtocolClient, "request">,
  params: ZCodePluginsReferenceCatalogParams,
) {
// 新方法命中即返回，只有明确的「方法不存在」才进入回退分支。
  try {
    return await client.request(
// 新方法额外返回展示分类，供选择器分组；旧方法没有该字段。
// 这里不改写 params，两种方法接受同一份请求体。
      zcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      zcodePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
// [失败路径] 只有 -32601（方法未找到）才说明对端是旧 Agent；
// 其余错误必须原样抛出，否则会把真实故障伪装成兼容回退。
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
// 回退调用不再捕获异常：旧方法也失败时，错误应直接交给调用方。
    return client.request(
      zcodeProtocolMethods.pluginsReferenceCatalog,
      params,
      zcodePluginsReferenceCatalogResultSchema,
    );
  }
}
