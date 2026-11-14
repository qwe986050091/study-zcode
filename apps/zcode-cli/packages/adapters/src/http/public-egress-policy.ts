/**
 * ============================================================================
 * http/public-egress-policy.ts —— 公网出口 DNS 校验
 * ============================================================================
 *
 * 【定位】当请求标记 egressPolicy="public"（网页抓取/外部 URL）时，限制只能
 * 访问公网地址：拒绝 localhost/*.local/单标签域名、拒绝解析到私网/保留段的 IP。
 *
 * 【两阶段】assertPublicEgressDestination 在建连前做一次预检；
 * createPublicEgressLookup 把同一份校验逻辑接进 socket 的 lookup，保证真正
 * 连接的 IP 就是被校验过的结果（防 DNS rebinding）。
 *
 * 【失败语义】所有阻断都抛 HttpClientPortError(code="egress_blocked")；
 * DNS 本身失败原样透传（最终由 toHttpClientError 归为 network_error）。
 * ============================================================================
 */
import { lookup as defaultDnsLookup } from "node:dns/promises";
import http from "node:http";
import {
  createHttpClientError,
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
} from "@zcode/contracts";

export type DnsLookupAddress = { address: string; family: number };
export type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<DnsLookupAddress[]>;

type NodeLookupFunction = NonNullable<http.RequestOptions["lookup"]>;

interface PublicEgressLookupOptions {
  signal?: AbortSignal;
}

/** 系统 DNS lookup 的裸函数；作为默认注入值，测试可替换。 */
export function defaultPublicDnsLookup(): DnsLookup {
  return defaultDnsLookup;
}

/**
 * 建连前预检：解析 url.hostname 并要求所有结果都是公网地址。
 *
 * 只校验不缓存；真正的连接由 createPublicEgressLookup 再复用同样的判定。
 * 无返回值，失败即抛 egress_blocked。
 */
export async function assertPublicEgressDestination(
  url: URL,
  dnsLookup: DnsLookup,
  options: PublicEgressLookupOptions = {},
): Promise<void> {
  await resolvePublicEgressAddresses(url, url.hostname, dnsLookup, options);
}

/**
 * 生成 node:http 的 lookup 函数：校验通过后才把地址交给 socket。
 *
 * 支持 Node 的两种回调形态（all=true 返回数组；否则只返回首个地址）。
 * url 参数仅用于错误信息与 host 归一化，hostname 以 Node 实际传入为准。
 */
export function createPublicEgressLookup(
  url: string,
  dnsLookup: DnsLookup,
  egressOptions: PublicEgressLookupOptions = {},
): NodeLookupFunction {
  return (hostname, lookupOptions, callback) => {
    const done = typeof lookupOptions === "function" ? lookupOptions : callback;
    const wantsAll =
      typeof lookupOptions === "object" &&
      lookupOptions !== null &&
      "all" in lookupOptions &&
      (lookupOptions as { all?: unknown }).all === true;

    if (!done) return;

    resolvePublicEgressAddresses(new URL(url), hostname, dnsLookup, egressOptions).then(
      (addresses) => {
        if (wantsAll) {
          (
            done as (error: NodeJS.ErrnoException | null, addresses: DnsLookupAddress[]) => void
          )(null, addresses);
          return;
        }
        const first = addresses[0];
        if (!first) {
          (done as (error: NodeJS.ErrnoException) => void)(
            createEgressBlockedError(url, "HTTP public egress DNS lookup returned no addresses"),
          );
          return;
        }
        (
          done as (
            error: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void
        )(null, first.address, first.family);
      },
      (error: unknown) => {
        (done as (error: NodeJS.ErrnoException) => void)(toLookupError(error));
      },
    );
  };
}

/**
 * 解析主机名 → 地址列表，并做全部地址的公网校验。
 *
 * IP 字面量不走 DNS，直接按该地址校验；域名先查 host 黑名单，再解析。
 * 任一地址落在私网/保留段即整体拒绝（不做"挑一个公网地址"的降级）。
 */
async function resolvePublicEgressAddresses(
  url: URL,
  hostnameValue: string,
  dnsLookup: DnsLookup,
  options: PublicEgressLookupOptions,
): Promise<DnsLookupAddress[]> {
  const hostname = normalizeHostname(hostnameValue);
  if (hostname.length === 0) {
    throw createEgressBlockedError(url.toString(), "HTTP public egress requires a hostname");
  }

  const hostReason = getBlockedHostnameReason(hostname);
  if (hostReason) {
    throw createEgressBlockedError(url.toString(), hostReason);
  }

  const ipVersion = getIpAddressVersion(hostname);
  const addresses =
    ipVersion === 0
      ? await lookupDnsAddresses(hostname, dnsLookup, options.signal)
      : [{ address: hostname, family: ipVersion }];

  if (addresses.length === 0) {
    throw createEgressBlockedError(
      url.toString(),
      `HTTP public egress DNS lookup returned no addresses for ${hostname}`,
    );
  }

  for (const address of addresses) {
    const blockedAddress = getBlockedIpReason(address.address);
    if (blockedAddress) {
      throw createEgressBlockedError(
        url.toString(),
        `HTTP public egress blocked ${hostname} because it resolved to a non-public address`,
      );
    }
  }

  return addresses;
}

function normalizeHostname(hostname: string): string {
  return normalizeIpAddressLiteral(hostname);
}

function getBlockedHostnameReason(hostname: string): string | undefined {
  // 先挡明显的本地别名；单标签域名（无点、也非 IP）同样不可信，可能是内网别名。
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return `HTTP public egress blocked local hostname ${hostname}`;
  }

  if (getIpAddressVersion(hostname) === 0 && hostname.split(".").length < 2) {
    return "HTTP public egress requires a public hostname";
  }

  return undefined;
}

function getBlockedIpReason(address: string): string | undefined {
  return getPublicEgressIpBlockReason(address)?.reason;
}

/**
 * 带取消边界的 DNS 解析。
 *
 * DNS 查询本身不可取消，因此用 Promise.race 语义：signal 中止时立即 reject，
 * 同时解绑监听；迟到的 DNS 结果被丢弃，不会写入已取消的请求。
 */
function lookupDnsAddresses(
  hostname: string,
  dnsLookup: DnsLookup,
  signal: AbortSignal | undefined,
): Promise<DnsLookupAddress[]> {
  throwIfAborted(signal);
  const lookup = dnsLookup(hostname, { all: true, verbatim: true });
  if (!signal) return lookup;
  throwIfAborted(signal);

  // public egress 的 DNS 预检在真正建连前执行，也必须继承同一个请求超时/取消边界。
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    lookup.then(
      (addresses) => {
        signal.removeEventListener("abort", onAbort);
        resolve(addresses);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("HTTP request was cancelled");
}

function createEgressBlockedError(url: string, message: string): Error {
  return createHttpClientError({
    code: "egress_blocked",
    url,
    message,
  });
}

function toLookupError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error) return error as NodeJS.ErrnoException;
  return new Error(String(error)) as NodeJS.ErrnoException;
}
