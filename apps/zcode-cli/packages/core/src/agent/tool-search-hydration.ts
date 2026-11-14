import {
  PersistedToolSearchContentSchema,
  ToolSearchAnnouncementSchema,
  compactBoundaryPayloadSchema,
  type Logger,
} from "@zcode/contracts";
import { compactDiscoveryMetadata } from "../tool/search/history.js";

// 校验并还原持久化的 ToolSearch 检索内容，用于冷恢复后重建工具搜索历史。
// value 为未知来源的持久化 JSON；undefined 表示“本就没有”，直接返回 undefined 不告警。
// schema 校验失败时返回 undefined 并打 warn，让调用方回退到旧版 tool result，不抛错。
// 副作用：仅可能产生一条 warn 日志（logger 可选，缺省静默）。
export function hydrateToolSearchContent(value: unknown, logger?: Logger) {
  if (value === undefined) return undefined;
  const parsed = PersistedToolSearchContentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger?.warn("Invalid persisted ToolSearch content; using legacy tool result", {
    event: "session.tool_search.invalid_content",
    module: "core.session",
  });
  return undefined;
}

// 从持久化压缩边界还原“可发现工具”元数据，供 resume 后保持与摘要一致的检索范围。
// 校验失败返回 undefined（静默降级，不打日志），表示该边界不含可用的发现信息。
export function hydrateCompactDiscovery(value: unknown) {
  const parsed = compactBoundaryPayloadSchema.safeParse(value);
  return parsed.success ? compactDiscoveryMetadata(parsed.data) : undefined;
}

// 校验并还原 ToolSearch 的公告（announcement）内容；undefined 视为无公告，返回 undefined。
// 结构不合法同样返回 undefined，不抛错也不告警。
export function hydrateToolSearchAnnouncement(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = ToolSearchAnnouncementSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
