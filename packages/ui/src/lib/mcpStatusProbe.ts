// INV-01 探测只读：守住位置 全部实现；改错故障 测试连接改动了用户配置。
// INV-02 缺 type 时按字段推断：守住位置 normalizeMcpServerConfigForTest；改错故障 旧配置被判为无效类型。
// INV-03 SSE 用 GET 其余用 OPTIONS：守住位置 buildUrlProbeRequest；改错故障 SSE 端点返回 405 被当成不可达。
// INV-04 200~499 视为可达：守住位置 isReachableHttpStatus；改错故障 需要鉴权的端点被误判离线。
// INV-05 5xx 与网络错误不可达：守住位置 三元与 catch；改错故障 服务端崩溃仍显示绿灯。
// INV-06 每次探测独立超时：守住位置 AbortController 与 setTimeout；改错故障 请求悬挂拖住设置页。
// INV-07 finally 清定时器：守住位置 clearTimeout；改错故障 已结束请求仍触发 abort。
// INV-08 缺 url 直接返回配置错误：守住位置 第一个早退；改错故障 fetch 收到 undefined 抛未捕获异常。
// INV-09 stdio 只校验 command：守住位置 testStdioServer；改错故障 测试连接真的拉起子进程。
// INV-10 空 command 视为错误：守住位置 trim 判断；改错故障 空白命令显示连接成功。
// INV-11 耗时统一用 startTime 差值：守住位置 四处 response_time；改错故障 各分支口径不一致。
// INV-12 未知类型带类型名报错：守住位置 末尾模板串；改错故障 用户看不出配置错在哪。
// INV-13 自定义 headers 原样透传：守住位置 RequestInit；改错故障 鉴权头被丢弃。
// INV-14 返回三字段结构固定：守住位置 McpTestResult；改错故障 调用方需要处理多种形状。
//
// 模块职责：MCP 服务器连通性探测，覆盖 URL 与 stdio 两类配置。
// 阅读顺序：先看类型规整与 URL 探测，再看 stdio 校验，最后看总入口的分派。
import type { McpServerConfig, McpTestResult } from "@zcode/shared";

// 探测超时集中一处，便于统一调整。
const MCP_PROBE_TIMEOUT_MS = 5000;

// 测试前先补齐可推断的 type。
function normalizeMcpServerConfigForTest(config: McpServerConfig): McpServerConfig {
  if (config.type) {
    return config;
  }

  // 有 command 视为 stdio。
  if (config.command) {
    return {
      ...config,
      type: "stdio",
    };
  }

  // 有 url 视为 http。
  if (config.url) {
    return {
      ...config,
      type: "http",
    };
  }

  return config;
}

function buildUrlProbeRequest(config: McpServerConfig): RequestInit {
  return {
    // SSE 需要 GET，其余用 OPTIONS 探测。
    method: config.type === "sse" ? "GET" : "OPTIONS",
    headers: config.headers,
  };
}

function isReachableHttpStatus(status: number): boolean {
  // 4xx 也算可达，只关心端点是否存在。
  return status >= 200 && status < 500;
}

async function testUrlServer(
  config: McpServerConfig,
  startTime: number,
): Promise<McpTestResult> {
  // 缺 url 直接返回配置错误。
  if (!config.url) {
    return {
      success: false,
      error: "URL 类型服务器缺少 url 配置",
      response_time: Date.now() - startTime,
    };
  }

  const controller = new AbortController();
  // 每次 `probeMcpServer` 单独建 `AbortController` 并设 `MCP_PROBE_TIMEOUT_MS`，慢服务不会拖住后续探测。
  const timeoutId = window.setTimeout(() => controller.abort(), MCP_PROBE_TIMEOUT_MS);

  try {
    // 请求头原样透传，鉴权由配置负责。
    const response = await fetch(config.url, {
      ...buildUrlProbeRequest(config),
      signal: controller.signal,
    });

    return {
      success: isReachableHttpStatus(response.status),
      error: isReachableHttpStatus(response.status)
        ? undefined
        : `HTTP ${response.status} ${response.statusText}`.trim(),
      response_time: Date.now() - startTime,
    };
  } catch (error) {
    // 非 Error 抛出也要有可读文案。
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: errorMessage,
      response_time: Date.now() - startTime,
    };
  } finally {
    // 定时器必须在 finally 清理。
    window.clearTimeout(timeoutId);
  }
}

function testStdioServer(config: McpServerConfig, startTime: number): McpTestResult {
  // stdio 只校验命令非空，不做真实启动。
  if (!config.command?.trim()) {
    return {
      success: false,
      error: "stdio 类型服务器缺少 command 配置",
      response_time: Date.now() - startTime,
    };
  }

  return {
    success: true,
    response_time: Date.now() - startTime,
  };
}

export async function testMcpConnectivity(config: McpServerConfig): Promise<McpTestResult> {
  const startTime = Date.now();
  const normalizedConfig = normalizeMcpServerConfigForTest(config);

  if (normalizedConfig.type === "stdio") {
    return testStdioServer(normalizedConfig, startTime);
  }

  // 其余可探测类型统一走 URL 探测。
  if (normalizedConfig.url) {
    return testUrlServer(normalizedConfig, startTime);
  }

  return {
    success: false,
    error: `无效的 MCP 服务器配置: ${normalizedConfig.type ?? "unknown"}`,
    response_time: Date.now() - startTime,
  };
}
