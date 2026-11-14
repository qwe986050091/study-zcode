import { BlockList, isIP } from "node:net";

// `node:net` 的 `isIP` 返回码：0 表示不是 IP 字面量，4/6 表示对应协议族。
// 之所以把 0 纳入类型，是为了让“非法/无法判定”成为返回值的一部分而不是异常，
// 调用方可以据此走 fail-closed 分支；不要把它当作枚举来穷举协议版本。
export type IpAddressVersion = 0 | 4 | 6;

// 阻断原因：`reason` 是给人看的稳定短语（如 "private IPv4 address"），只用于日志/诊断，
// 不得作为程序分支依据；`version` 是规范化后的协议版本，便于上层区分处理与展示。
// 返回 `undefined` 才是“允许”，任何非空对象（含 "not an IP address"）都必须按拒绝处理，
// 这样无法解析的输入天然 fail-closed。该结构不跨进程持久化，也不携带原始输入字符串。
export interface PublicEgressIpBlockReason {
  reason: string;
  version: IpAddressVersion;
}

// 一条被禁止的网段：`address` 是网络地址而非任意主机地址，`prefix` 是 CIDR 前缀长度，
// `family` 必须与 `BlockList.addSubnet` 的协议族一致，`reason` 面向日志。
// 这是模块私有结构，不是跨包契约；新增网段只需追加条目，判定逻辑无需改动。
interface BlockedIpRange {
  address: string;
  family: "ipv4" | "ipv6";
  prefix: number;
  reason: string;
}

// 禁止访问的非公网地址清单，覆盖未指定、回环、私网、CGNAT、链路本地、IETF 保留、
// 基准测试、组播与 IPv6 的未指定/回环/ULA/链路本地/组播。顺序决定命中时返回的 reason，
// 因此更具体的段应放在更宽的段之前；这是数据表，不是可配置项，也不随运行时变化。
const BLOCKED_IP_RANGES: BlockedIpRange[] = [
  { address: "0.0.0.0", family: "ipv4", prefix: 8, reason: "unspecified IPv4 address" },
  { address: "10.0.0.0", family: "ipv4", prefix: 8, reason: "private IPv4 address" },
  { address: "127.0.0.0", family: "ipv4", prefix: 8, reason: "loopback IPv4 address" },
  {
    address: "100.64.0.0",
    family: "ipv4",
    prefix: 10,
    reason: "carrier-grade NAT IPv4 address",
  },
  { address: "169.254.0.0", family: "ipv4", prefix: 16, reason: "link-local IPv4 address" },
  { address: "172.16.0.0", family: "ipv4", prefix: 12, reason: "private IPv4 address" },
  { address: "192.168.0.0", family: "ipv4", prefix: 16, reason: "private IPv4 address" },
  {
    address: "192.0.0.0",
    family: "ipv4",
    prefix: 24,
    reason: "IETF protocol assignment IPv4 address",
  },
  { address: "198.18.0.0", family: "ipv4", prefix: 15, reason: "benchmark IPv4 address" },
  { address: "224.0.0.0", family: "ipv4", prefix: 4, reason: "multicast IPv4 address" },
  { address: "240.0.0.0", family: "ipv4", prefix: 4, reason: "reserved IPv4 address" },
  { address: "::", family: "ipv6", prefix: 128, reason: "unspecified IPv6 address" },
  { address: "::1", family: "ipv6", prefix: 128, reason: "loopback IPv6 address" },
  { address: "fc00::", family: "ipv6", prefix: 7, reason: "unique-local IPv6 address" },
  { address: "fe80::", family: "ipv6", prefix: 10, reason: "link-local IPv6 address" },
  { address: "ff00::", family: "ipv6", prefix: 8, reason: "multicast IPv6 address" },
];

// 模块加载时把 CIDR 表预编译成 `BlockList`：这是本文件唯一的“缓存”形态，
// 之后每次判定都是纯同步查表，没有运行时观测、没有 TTL、不会过期。
// 预编译只做一次，意味着新增网段必须改源码并重启进程，不能指望热更新生效。
const BLOCKED_PUBLIC_EGRESS_RANGES = BLOCKED_IP_RANGES.map((range) => {
  const blockList = new BlockList();
  blockList.addSubnet(range.address, range.prefix, range.family);
  return { ...range, blockList };
});

// 归一化 IP 字面量：去掉首尾方括号（IPv6 在 URL 中写作 `[::1]`）、去掉末尾的点
// （FQDN 形式 `127.0.0.1.`），并统一小写，避免 `::FFFF:7F00:1` 之类逃过 CIDR 匹配。
// 只做字面量层面的清洗，不做 DNS 解析、不做 IPv4-mapped IPv6 显式拆解（交给 BlockList）。
// 调用方应先把 URL host 中的环境变量展开完再传入，本函数不处理变量占位符。
export function normalizeIpAddressLiteral(value: string): string {
  return value.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

// 返回 IP 字面量的协议版本，非法输入返回 0 而不是抛错；与 `getPublicEgressIpBlockReason`
// 共用同一套归一化，避免两处对 `[::1]`/尾点等写法判定不一致。
// 该结果只代表“是不是合法 IP 字面量”，不代表“能不能公网访问”，后者必须再走阻断判定。
export function getIpAddressVersion(value: string): IpAddressVersion {
  return isIP(normalizeIpAddressLiteral(value)) as IpAddressVersion;
}

// 纯同步判定：字面量归一化 → 非法即返回 "not an IP address" → 逐个 CIDR 检查是否落在
// 私网/回环/保留段内并返回首个命中的 reason。返回 `undefined` 才表示该地址可作为出口。
// 这里只处理 IP 字面量；域名解析、DNS 预检与实际请求阻断在
// adapters/src/http/public-egress-policy.ts，本函数不采集出口 IP 观测、不缓存解析结果，
// 也不承担失败降级——调用方必须把“解析失败/非法输入”也当作不可出口。
// IPv4-mapped IPv6 由 BlockList 的 CIDR 匹配覆盖，不需要额外的正则分支。
export function getPublicEgressIpBlockReason(value: string): PublicEgressIpBlockReason | undefined {
  const normalized = normalizeIpAddressLiteral(value);
  const version = isIP(normalized) as IpAddressVersion;
  if (version === 0) {
    return { reason: "not an IP address", version };
  }

  const family = version === 4 ? "ipv4" : "ipv6";
  // BlockList 按 CIDR 匹配时能覆盖 IPv4-mapped IPv6，
  // 避免手写正则漏掉 ::ffff:7f00:1 这类标准化后的 loopback 表示。
  for (const range of BLOCKED_PUBLIC_EGRESS_RANGES) {
    if (range.blockList.check(normalized, family)) {
      return { reason: range.reason, version };
    }
  }

  return undefined;
}
