// 职责：为出站请求补齐 x-request-id，让客户端日志与服务端日志可按同一 id 关联。
// 边界：只处理 header 容器形态差异（Headers / 二元组数组 / 普通对象），不读取、不校验已有值。
// 不变量（INV）：已存在的 request-id 必须原样保留 —— 重试或转发时覆盖会切断与首次请求的追踪链；
// 因此只有不存在时才生成，且判断一律大小写不敏感（HTTP header 名不区分大小写）。
import { createUuid } from "@zcode/shared";

// 小写是规范形态；两个容器实现分别用 has() 与 toLowerCase 比较，大小写不构成语义差异，
// 但下游按字面量取值时依赖它，改动需全仓搜索。
export const REQUEST_ID_HEADER_NAME = "x-request-id";

// Headers 构造器会规范化 name 大小写并合并重复项，因此补头只在这一层做；
// 不要在返回后再次 set，否则会覆盖调用方显式传入的 trace id。
export function withRequestIdHeader(headers: RequestInit["headers"] | undefined): Headers {
  const next = new Headers(headers);
  if (!next.has(REQUEST_ID_HEADER_NAME)) {
    next.set(REQUEST_ID_HEADER_NAME, createUuid());
  }
  return next;
}

// 对象形态无法依赖 Headers 的规范化能力，必须手动遍历三种输入；输出 Record 是为了
// 兼容不支持 Headers 的运行环境（如部分 Node 中间件与序列化路径）。
export function withRequestIdHeaderRecord(
  headers: RequestInit["headers"] | undefined,
): Record<string, string> {
  const next: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      next[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      next[key] = value;
    }
  } else if (headers) {
    Object.entries(headers).forEach(([key, value]) => {
      next[key] = String(value);
    });
  }

  if (!Object.keys(next).some((key) => key.toLowerCase() === REQUEST_ID_HEADER_NAME)) {
    next[REQUEST_ID_HEADER_NAME] = createUuid();
  }
  return next;
}
