// 把通配规则（仅 * 为通配符）编译为整串匹配的 RegExp。
// 先转义每段中的正则元字符再以 .* 连接，避免规则里的 . 或 ( 被当作语法。
// 返回 ^...$ 的精确匹配；空 pattern 得到匹配空串的正则，不会匹配任意输入。
// 每次调用都新建正则，调用方若用于热点路径应自行缓存。
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

// 提取 URL 的权限主体，格式固定为 "domain:<host>"；协议、端口、路径均不参与。
// 输入先 trim，URL 解析失败或 hostname 为空时返回 undefined（调用方视为无主体、不命中）。
// hostname 统一小写并去掉末尾单个点，避免 "example.com." 与 "example.com" 被当作两条规则。
export function domainRuleSubject(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return hostname.length > 0 ? `domain:${hostname}` : undefined;
  } catch {
    return undefined;
  }
}

// 返回 web fetch 规则需要匹配的主体数组；当前只有 domain 一种，故成功时长度恒为 1。
// URL 非法时返回空数组而非抛错，表示"没有可匹配主体"，由规则引擎走默认拒绝/询问。
export function webFetchRuleSubjects(url: string): string[] {
  const domain = domainRuleSubject(url);
  return domain ? [domain] : [];
}
