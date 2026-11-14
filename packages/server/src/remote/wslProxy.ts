// INV-01 空串返回空：守住位置 修剪判断；改错故障 空地址被补成默认主机。
// INV-02 无协议补默认协议：守住位置 协议探测；改错故障 纯主机地址解析失败。
// INV-03 解析失败返回空：守住位置 捕获；改错故障 抛错打断调用方。
// INV-04 回环含三种写法：守住位置 判断；改错故障 localhost 被当远端。
// INV-05 方括号先剥除：守住位置 归一化；改错故障 IPv6 回环漏判。
// INV-06 替换主机保留端口：守住位置 地址重建；改错故障 端口丢失。
// INV-07 IPv6 主机补方括号：守住位置 地址类型；改错故障 生成非法地址。
// INV-08 探测命令默认端口：守住位置 缺省；改错故障 无端口地址探测失败。
// INV-09 非数字端口返回空：守住位置 正则；改错故障 命令注入。
// INV-10 探测脚本统一引用：守住位置 引用函数；改错故障 空格参数被拆分。
// INV-11 网关命令分别输出来源：守住位置 标签前缀；改错故障 无法区分路由与解析。
// INV-12 网关解析逐词扫描：守住位置 分词；改错故障 首个候选错误即放弃。
// INV-13 回环与本地链路排除：守住位置 候选判断；改错故障 选到回环地址。
// INV-14 解析来源要求私网：守住位置 私网判断；改错故障 公网地址被当网关。
// INV-15 IPv6 私网段识别：守住位置 前缀判断；改错故障 唯一本地地址被丢弃。
// INV-16 日志格式隐藏路径：守住位置 协议与主机；改错故障 凭据写进日志。
// INV-17 非法地址给占位：守住位置 捕获；改错故障 日志记录抛错。
// INV-18 不修改输入字符串：守住位置 纯函数；改错故障 调用方地址被改写。
//
// 模块职责：WSL 代理地址的规范化、端口探测命令与宿主网关解析。
// 状态所有权：全部为纯函数，不持有连接或缓存。
// 阅读顺序：先看地址规范化，再看探测命令，最后看网关候选判定。
import { isIP } from "node:net";
import { quotePosixShellArg } from "@zcode/server/remote/posixShell.js";

const LOOPBACK_IPV4_PREFIX = "127.";
const LINK_LOCAL_IPV4_PREFIX = "169.254.";

// 空串返回空。
// 无协议补默认协议。
// 解析失败返回空。
// 协议与主机都需非空。
// 返回规范字符串。
export function normalizeWslProxyUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol.length > 0 && url.hostname.length > 0 ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isLoopbackProxyHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith(LOOPBACK_IPV4_PREFIX))
  );
}

export function replaceProxyHostname(proxyUrl: string, hostname: string): string {
  const url = new URL(proxyUrl);
  if (isIP(hostname) === 6) {
    url.hostname = `[${hostname}]`;
  } else {
    url.hostname = hostname;
  }
  return url.toString();
}

// 解析失败返回空。
// 端口缺省按协议。
// 端口必须是数字。
// 主机保留 IPv6 方括号。
// 脚本参数统一引用。
export function buildWslProxyPortProbeCommand(proxyUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return null;
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!/^\d+$/u.test(port)) {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const tcpTarget = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const probeScript = `:</dev/tcp/${tcpTarget}/${port}`;
  return [
    "if command -v timeout >/dev/null 2>&1 &&",
    `timeout 1 bash -c ${quotePosixShellArg(probeScript)} >/dev/null 2>&1; then`,
    "printf reachable",
    "else",
    "printf unreachable",
    "fi",
  ].join(" ");
}

export function parseWslProxyPortProbeOutput(output: string): boolean | undefined {
  const normalized = output.trim();
  if (normalized === "reachable") {
    return true;
  }
  if (normalized === "unreachable") {
    return false;
  }
  return undefined;
}

export function buildWslHostGatewayCommand(): string {
  return [
    "gateway=",
    'if command -v ip >/dev/null 2>&1; then gateway=$(ip route show default 2>/dev/null | awk \'$1=="default" && $2=="via" {print $3; exit}\'); fi',
    'if [ -n "$gateway" ]; then printf "route=%s " "$gateway"; fi',
    'if [ -r /etc/resolv.conf ]; then awk \'$1=="nameserver" {print "resolv=" $2}\' /etc/resolv.conf; fi',
  ].join("; ");
}

// 逐词扫描候选。
// 标签区分来源。
// 先命中先返回。
// 全部不合格返回空。
export function parseWslHostGatewayOutput(output: string): string | null {
  for (const token of output.trim().split(/\s+/u)) {
    const taggedCandidate = /^(route|resolv)=(.+)$/u.exec(token);
    const source = taggedCandidate?.[1] ?? "resolv";
    const candidate = (taggedCandidate?.[2] ?? token).replace(/^\[|\]$/gu, "");
    if (isWslGatewayCandidate(candidate, source)) {
      return candidate;
    }
  }
  return null;
}

// 必须是合法地址。
// 回环地址排除。
// 解析来源只收私网。
// 路由来源可直接采用。
function isWslGatewayCandidate(candidate: string, source: string): boolean {
  const addressType = isIP(candidate);
  if (addressType !== 4 && addressType !== 6) {
    return false;
  }
  if (candidate === "::1" || (addressType === 4 && candidate.startsWith(LOOPBACK_IPV4_PREFIX))) {
    return false;
  }
  if (source !== "resolv") {
    return true;
  }
  return isPrivateOrLinkLocalAddress(candidate, addressType);
}

function isPrivateOrLinkLocalAddress(candidate: string, addressType: number): boolean {
  if (addressType === 6) {
    const normalized = candidate.toLowerCase();
    return (
      normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized)
    );
  }
  const octets = candidate.split(".").map(Number);
  const firstOctet = octets[0] ?? -1;
  const secondOctet = octets[1] ?? -1;
  return (
    octets.length === 4 &&
    (firstOctet === 10 ||
      (firstOctet === 192 && secondOctet === 168) ||
      (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
      candidate.startsWith(LINK_LOCAL_IPV4_PREFIX))
  );
}

export function formatWslProxyForLog(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const displayHost = isIP(host) === 6 ? `[${host}]` : host;
    return `${url.protocol}//${displayHost}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "<invalid-proxy>";
  }
}
