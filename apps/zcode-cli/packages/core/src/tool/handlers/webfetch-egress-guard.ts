// WebFetch 出站目标的「字面量」egress 防护。
//
// 只处理 URL 文本里已经写着的主机：localhost 名字、以及 IPv4/IPv6 字面量。普通域名在这里
// **不做** DNS 解析——之前那套 preflight 在部分网络下会拖慢甚至失败（见下方内联注释），
// 现在把域名解析后的私网判定交给底层 httpClientPort 的 public egress 检查（adapter 报告
// egress_blocked 时本工具再翻译成 EgressBlocked）。
//
// 这层是「每次真实 GET 前」的守卫而非一次性入参校验：重定向会把 URL 换成新目标，若只在
// 入口查一次，攻击者可用 302 把请求导向内网。任何放行判断都必须对当前这一跳的 URL 重新做。
import ipaddr from "ipaddr.js";
import { webFetchError } from "./webfetch-errors.js";

// 198.18.0.0/15 是 IPv4 benchmarking 段：ipaddr.js 归类为 unicast，但常被 DNS 劫持/代理
// 工具占用，公网抓取不应把它当普通公网地址。
const IPV4_BENCHMARK_NETWORK = ipaddr.parseCIDR("198.18.0.0/15") as [ipaddr.IPv4, number];
// ipaddr.js 对这些 special-use IPv6 前缀的 range() 仍可能返回 unicast，必须显式排除：
// 64:ff9b:1::/48（本地 NAT64）、100::/64（discard）、2001:2::/48（benchmarking）、
// 2001:10::/28 与 2001:20::/28（ORCHID）。它们都不是可公开访问的普通公网目标。
const SPECIAL_USE_IPV6_NETWORKS: Array<[ipaddr.IPv6, number]> = [
  ipaddr.parseCIDR("64:ff9b:1::/48") as [ipaddr.IPv6, number],
  ipaddr.parseCIDR("100::/64") as [ipaddr.IPv6, number],
  ipaddr.parseCIDR("2001:2::/48") as [ipaddr.IPv6, number],
  ipaddr.parseCIDR("2001:10::/28") as [ipaddr.IPv6, number],
  ipaddr.parseCIDR("2001:20::/28") as [ipaddr.IPv6, number],
];
// NAT64/DNS64 的 well-known prefix 64:ff9b::/96（前 12 字节固定，后 4 字节编入 IPv4）。
const DNS64_WELL_KNOWN_PREFIX = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * 对当前这一跳的 URL 做出站前检查，违规直接抛 EgressBlocked（fail-closed，不放行）。
 *
 * 输入：已规范化的 URL；输出：无（通过即返回）。副作用：无网络 I/O、无事件——纯判定。
 * 两类拦截：localhost / *.localhost 主机名；私网/保留/特殊用途的 IP 字面量（含 IPv4-mapped
 * 与 NAT64 编码）。普通域名字面量在这里放行，由 adapter 的 DNS 后检查兜底。
 *
 * 不变量：每次真实 GET（含重定向后的每一跳）都必须先调用本函数；跳过它等于让
 * NO_PROXY/代理层面的私网访问绕过工具自身的安全边界。
 */
export function assertWebFetchLiteralEgress(url: URL): void {
  const hostname = normalizeHostname(url.hostname);

  if (isLocalHostname(hostname)) {
    throw webFetchError("EgressBlocked", "WebFetch cannot access private or local hostnames", {
      hostname,
      url: url.toString(),
    });
  }

  // DNS preflight 在部分网络下 1s 内无法完成，会让公网 URL 在真实 fetch 前失败。
  // 当前只保留 URL 字面量层面的本地/私网目标阻断，不对普通域名做本地 DNS 解析。
  if (!isIpLiteral(hostname)) return;
  assertPublicIpAddress(hostname, { hostname, url });
}

/**
 * 断言 IP 字面量属于允许公网出站的地址，否则抛 EgressBlocked 并带上原始地址与主机名。
 * 判定统一走 isPublicIpAddress 的「先还原载体地址、再按版本判」路径，避免 IPv6 包裹的
 * IPv4 私网地址（::ffff:127.0.0.1、NAT64 编码）被当成公网 IPv6 放过去。
 */
function assertPublicIpAddress(address: string, context: { hostname: string; url: URL }): void {
  if (isPublicIpAddress(address)) return;

  throw webFetchError("EgressBlocked", "WebFetch cannot access private or local IP addresses", {
    address,
    hostname: context.hostname,
    url: context.url.toString(),
  });
}

/**
 * 判断 IP 是否为可出站的公开地址。
 *
 * 解析失败一律返回 false（未知形态按拒绝处理，fail-closed）。先尝试从
 * IPv6 载体中还原 IPv4，再用对应版本的规则判定；两者都不匹配也返回 false。
 */
function isPublicIpAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  if (!parsed) return false;

  const effectiveAddress = unwrapIpv6CarrierAddress(parsed) ?? parsed;
  if (isIpv4Address(effectiveAddress)) return isPublicIpv4(effectiveAddress);
  if (isIpv6Address(effectiveAddress)) return isPublicIpv6(effectiveAddress);
  return false;
}

/** 去除 IPv6 方括号与结尾点、转小写；URL.hostname 对 IPv6 会带 `[]`，不剥离会解析失败。 */
function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets.endsWith(".") ? withoutBrackets.slice(0, -1) : withoutBrackets;
}

/**
 * 供 URL 层判断「这是不是一个 IP 字面量」；自身做同样的主机名规范化，避免 `[::1]`、
 * `LOCALHOST.` 这类写法在两层判定中得出不同结论。
 */
export function isWebFetchIpLiteral(hostname: string): boolean {
  return isIpLiteral(normalizeHostname(hostname));
}

function isIpLiteral(hostname: string): boolean {
  return ipaddr.isValid(hostname);
}

/** localhost 及其子域一律按本地目标处理，不做例外。 */
function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function parseIpAddress(address: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  try {
    return ipaddr.parse(normalizeHostname(address));
  } catch {
    return undefined;
  }
}

/**
 * 从 IPv6 载体中还原被包裹的 IPv4；非载体形式返回 undefined。
 *
 * 两种载体：IPv4-mapped（::ffff:a.b.c.d）和 NAT64/DNS64 的 64:ff9b::/96。若不还原，
 * `::ffff:10.0.0.1` 会被当作公网 IPv6 unicast，私网地址就从 IPv6 通道漏出去。
 */
function unwrapIpv6CarrierAddress(address: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | undefined {
  if (!isIpv6Address(address)) return undefined;
  if (address.isIPv4MappedAddress()) return address.toIPv4Address();

  // NAT64/DNS64 的 well-known prefix 会把 IPv4 私网地址编码成 IPv6；
  // 必须先还原低 32 位 IPv4 再套用同一套 public egress policy。
  const bytes = address.toByteArray();
  if (bytes.length !== 16) return undefined;
  if (!DNS64_WELL_KNOWN_PREFIX.every((byte, index) => bytes[index] === byte)) return undefined;
  return ipaddr.fromByteArray(bytes.slice(12)) as ipaddr.IPv4;
}

/**
 * IPv4 公开性：先排除 benchmarking 段，再要求 ipaddr.js 的 range() 恰为 "unicast"。
 * 这样 private / loopback / linkLocal / carrierGradeNat / multicast / reserved / broadcast
 * 等所有非单播段一次性被拒，不需要逐段枚举。
 */
function isPublicIpv4(address: ipaddr.IPv4): boolean {
  if (address.match(IPV4_BENCHMARK_NETWORK)) return false;
  return address.range() === "unicast";
}

/**
 * IPv6 公开性：显式排除 special-use 前缀后，同样只接受 "unicast"。
 * 不能只依赖 range()：ipaddr.js 对上述前缀可能返回 unicast，会导致本地 NAT64 等目标
 * 被误判成公网可达。
 */
function isPublicIpv6(address: ipaddr.IPv6): boolean {
  // ipaddr.js 会把部分 special-use IPv6 前缀归类为 unicast；
  // WebFetch 的 public egress 边界需要显式排除这些非普通公网目标的地址段。
  if (SPECIAL_USE_IPV6_NETWORKS.some((network) => address.match(network))) return false;
  return address.range() === "unicast";
}

function isIpv4Address(address: ipaddr.IPv4 | ipaddr.IPv6): address is ipaddr.IPv4 {
  return address.kind() === "ipv4";
}

function isIpv6Address(address: ipaddr.IPv4 | ipaddr.IPv6): address is ipaddr.IPv6 {
  return address.kind() === "ipv6";
}
