// Env Config Adapter - Parse the intentionally small ZCODE_* environment surface.

/*
 * ============================================================
 * config / env-config.adapter.ts —— 解析少量 ZCODE_* 环境变量
 *
 * 定位：把环境变量映射成 RuntimeConfigPatch（Storage/Network/Logging/ToolConcurrency），
 * 是 env 层配置的唯一入口；刻意保持字段白名单，避免环境变量无限膨胀成配置面。
 *
 * 输入输出：输入 env（默认 process.env）与可选 prefix（默认 ZCODE_）；
 * 返回只含已识别字段的 patch；未识别的 ZCODE_* 变量被忽略。
 *
 * 副作用：无（纯函数）；不读取/写入文件。
 *
 * 失败语义：非法数字→0，非法日志格式→text；不抛错。
 *
 * 不变量：只读取白名单键；timeout/并发数按 Number 归一，非法值不产生 NaN。
 * ============================================================
 */

import type { RuntimeConfigPatch } from "@zcode/contracts";

interface EnvConfigOptions {
  /** 环境变量前缀，默认 ZCODE_；测试可覆盖。 */
  prefix?: string;
}

const DEFAULT_PREFIX = "ZCODE_";

/**
 * 将 ZCODE_* 环境变量解析为配置 patch（纯函数，无副作用）。
 * Parse ZCODE_* environment variables into config
 *
 * 只匹配前缀 + 白名单键，undefined 值跳过；数字非法归 0、日志格式非法归 text，
 * 不抛出异常。
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  options: EnvConfigOptions = {},
): RuntimeConfigPatch {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const config: RuntimeConfigPatch = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;

    const configKey = key.slice(prefix.length);
    // Storage config
    if (configKey === "STORAGE_DIR") {
      if (!config.storage) config.storage = {};
      config.storage.dir = value;
    } else if (configKey === "SESSION_DB_PATH" || configKey === "SESSION_DB") {
      if (!config.storage) config.storage = {};
      config.storage.sessionDbPath = value;
    }

    // Network config
    else if (configKey === "HTTP_PROXY") {
      if (!config.network) config.network = {};
      config.network.httpProxy = value;
    } else if (configKey === "NO_PROXY") {
      if (!config.network) config.network = {};
      config.network.noProxy = value;
    } else if (configKey === "AGENT_CA_CERT") {
      if (!config.network) config.network = {};
      config.network.caCertFile = value;
    } else if (configKey === "HTTP_TIMEOUT" || configKey === "TIMEOUT") {
      if (!config.network) config.network = {};
      config.network.timeout = normalizeNumber(value);
    }

    // Logging config
    else if (configKey === "LOG_FORMAT") {
      if (!config.logging) config.logging = {};
      config.logging.format = normalizeLogFormat(value);
    }

    // Tool Concurrency config
    else if (configKey === "MAX_TOOL_CONCURRENCY") {
      if (!config.toolConcurrency) config.toolConcurrency = {};
      config.toolConcurrency.maxConcurrency = normalizeNumber(value);
    }
  }

  return config;
}

/**
 * 直接读取工具并发配置（不走完整 config 链）。
 * Get tool concurrency config from environment
 * 未设置时默认 10；非法值经 normalizeNumber 归 0（调用方需注意 0 的语义）。
 */
export function getToolConcurrencyConfig(): { maxConcurrency: number } {
  return {
    maxConcurrency: normalizeNumber(process.env.ZCODE_MAX_TOOL_CONCURRENCY ?? "10"),
  };
}

// ============================================================
// Helpers
// ============================================================

/** 字符串转数字；NaN 归 0（而非抛错），保证配置解析永远不会因坏值中断。 */
function normalizeNumber(value: string): number {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

/** 日志格式只接受 text/json（大小写不敏感），其余回退 text。 */
function normalizeLogFormat(value: string): "text" | "json" {
  const format = value.toLowerCase();
  if (format === "text" || format === "json") {
    return format;
  }
  return "text";
}
