// INV-01 逐字符扫描：守住位置 内联表解析循环；改错故障：正则切分把嵌套结构切坏。
// INV-02 转义优先：守住位置 反斜杠分支；改错故障：引号被误判为字符串边界。
// INV-03 引号成对：守住位置 切换判断；改错故障：字符串内的逗号被当成分隔符。
// INV-04 深度跟踪：守住位置 括号计数；改错故障：嵌套对象被顶层切分拆散。
// INV-05 键非空：守住位置 键判断；改错故障：空键写入结果对象。
// INV-06 重复覆盖：守住位置 赋值方式；改错故障：后出现的同名键被丢弃。
// INV-07 类型收敛：守住位置 字面量分支；改错故障：布尔与数字被当成字符串。
// INV-08 解析失败降级：守住位置 内联表回退；改错故障：旧格式对象整体丢失。
// INV-09 空值不写：守住位置 解析结果判断；改错故障：未定义值覆盖已有字段。
// INV-10 表头识别：守住位置 两种前缀；改错故障：蛇形命名的服务表读不到。
// INV-11 他表即止：守住位置 非服务表头分支；改错故障：后续表字段串进上一个服务。
// INV-12 子表隔离：守住位置 点号拆分；改错故障：环境变量被平铺到服务顶层。
// INV-13 空服务过滤：守住位置 收尾过滤；改错故障：只有表头的服务产生空配置。
// INV-14 行尾归一：守住位置 换行切分；改错故障：回车残留进键名。
// INV-15 序列化递归：守住位置 各类型分支；改错故障：嵌套值被写成对象字符串。
// INV-16 转义保真：守住位置 字符串输出；改错故障：引号与换行破坏 TOML 结构。
// INV-17 剥离成对：守住位置 跳过状态；改错故障：服务表之后的内容被整段删除。
// INV-18 顺序稳定：守住位置 先标量后子表；改错故障：子表插在标量中间，解析歧义。
//
// 模块职责：在 MCP 用户目录里读写 TOML 片段，覆盖内联表、服务表与序列化。
// 状态所有权：无运行时状态，全部为纯解析与拼接函数，缓存配置会与磁盘内容脱节。
// 阅读顺序：值解析 → 内联表 → 读取服务 → 序列化值 → 剥离 → 序列化服务。
/**
 * MCP 用户目录模块 - TOML 解析和序列化
 */

import type { McpServerConfig } from "@zcode/shared";

/**
 * 解析 TOML 内联表格格式
 * 支持: { key = "value", key2 = "value2" }
 */
function parseTomlInlineTable(input: string): Record<string, unknown> | null {
  const inner = input.slice(1, -1).trim();
  if (!inner) return {};

  const result: Record<string, unknown> = {};
  let current = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  // 扫描 inner 时维护 escaped、inString 与 depth 三个状态：只有 depth===0 的逗号才切分键值对。
  // 等号必须出现在键名之后（空键忽略），引号内的逗号与等号不计入切分。
  //
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (!char) continue;

    if (escaped) {
      escaped = false;
      current += char;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      current += char;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      current += char;
      continue;
    }

    if (!inString) {
      if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
      } else if (char === "," && depth === 0) {
        const pair = current.trim();
        if (pair) {
          const eqIndex = pair.indexOf("=");
          if (eqIndex > 0) {
            const key = pair.slice(0, eqIndex).trim();
            const value = pair.slice(eqIndex + 1).trim();
            if (key) {
              result[key] = parseTomlValue(value);
            }
          }
        }
        current = "";
        continue;
      }
    }
    current += char;
  }

  const pair = current.trim();
  if (pair) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      if (key) {
        result[key] = parseTomlValue(value);
      }
    }
  }

  return result;
}

// parseTomlValue 只在引号成对时去壳，单双引号都支持。
// 布尔与数字按字面量解析，解析不出的值回退原文，否则调用方会拿到字符串型数字。
//
function parseTomlValue(value: string): unknown {
  const normalized = value.trim();

  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    return normalized.slice(1, -1);
  }

  if (normalized === "true") return true;
  if (normalized === "false") return false;

  // 支持内联表格格式 { key = "value", key2 = "value2" }
  if (normalized.startsWith("{") && normalized.endsWith("}")) {
    const parsed = parseTomlInlineTable(normalized);
    if (parsed) {
      return parsed;
    }
    // 如果解析失败，尝试作为 JSON 解析（兼容旧格式）
    try {
      return JSON.parse(normalized);
    } catch {
      return undefined;
    }
  }

  if (normalized.startsWith("[")) {
    try {
      return JSON.parse(normalized.replace(/'/g, '"'));
    } catch {
      return undefined;
    }
  }

  const num = Number(normalized);
  if (!Number.isNaN(num)) return num;

  return normalized;
}

// readTomlMcpServers 只识别两种服务表头，其余表头结束当前服务。
// 空服务在收尾时被过滤，否则会输出没有命令的条目。
//
export function readTomlMcpServers(raw: string): Record<string, McpServerConfig> {
  const servers: Record<string, Record<string, unknown>> = {};
  const lines = raw.split(/\r?\n/);
  let currentServerName: string | null = null;
  // 当前写入目标：可能是 server 对象本身，也可能是子表（如 env）
  let currentTarget: Record<string, unknown> | null = null;
  const mcpServerHeaderPattern = /^\[(?:mcpServers|mcp_servers)\.([^\]]+)\]$/;

  function ensureServer(name: string): Record<string, unknown> {
    if (!servers[name]) {
      servers[name] = {};
    }
    return servers[name];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const tableMatch = trimmed.match(mcpServerHeaderPattern);
    if (tableMatch) {
      const fullKey = tableMatch[1] ?? "";
      const dotIndex = fullKey.indexOf(".");
      // dotIndex<0 表示顶层服务表头；带点号时 fullKey 前段为服务名，后段为子表名。
      //
      if (dotIndex < 0) {
        // 顶层 server header: [mcp_servers.context7]
        currentServerName = fullKey || null;
        currentTarget = currentServerName ? ensureServer(currentServerName) : null;
      } else {
        // 子表 header: [mcp_servers.context7.env]
        const serverName = fullKey.slice(0, dotIndex);
        const subKey = fullKey.slice(dotIndex + 1);
        currentServerName = serverName;
        const serverObj = ensureServer(serverName);
        const subObj: Record<string, unknown> = {};
        serverObj[subKey] = subObj;
        currentTarget = subObj;
      }
      continue;
    }

    // 遇到非 MCP 的 table header 时结束当前 server
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      currentServerName = null;
      currentTarget = null;
      continue;
    }

    if (!currentServerName || !currentTarget) {
      continue;
    }

    // keyValueMatch 只把单词字符当键，值取等号后全部内容；解析为空的值不写入，避免覆盖已有字段。
    //
    const keyValueMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!keyValueMatch) {
      continue;
    }

    const key = keyValueMatch[1];
    const value = keyValueMatch[2];
    if (!key || value === undefined) {
      continue;
    }
    const parsedValue = parseTomlValue(value);
    if (parsedValue !== undefined) {
      currentTarget[key] = parsedValue;
    }
  }

  // 过滤空的 server
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (Object.keys(config).length > 0) {
      result[name] = config as McpServerConfig;
    }
  }
  return result;
}

/**
 * 序列化 TOML 值
 * 支持标准 TOML 格式输出，包括内联表格
 */
// serializeTomlValue 对数组递归序列化，字符串统一走 JSON 转义。
// 空对象输出空表，其余对象输出内联表；误判会让嵌套表被压平成字符串。
//
function serializeTomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeTomlValue(item)).join(", ")}]`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (value == null) {
    return '""';
  }
  // 处理对象：输出 TOML 内联表格格式 { key = "value" }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "{}";
    }
    const pairs = entries.map(([k, v]) => `${k} = ${serializeTomlValue(v)}`);
    return `{ ${pairs.join(", ")} }`;
  }
  return JSON.stringify(value);
}

// stripTomlMcpServers 遇到服务表头开始跳过，直到下一个非服务表头。
// 其余行原样输出，只去掉末尾空白；保留空白会让 TOML 解析器无法识别下一段表头。
//
export function stripTomlMcpServers(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  const mcpServerHeaderPattern = /^\[(?:mcpServers|mcp_servers)\.[^\]]+\]$/;

  for (const line of lines) {
    const trimmed = line.trim();
    const isMcpServerHeader = mcpServerHeaderPattern.test(trimmed);
    const isOtherHeader = /^\[[^\]]+\]$/.test(trimmed) && !isMcpServerHeader;

    if (isMcpServerHeader) {
      skipping = true;
      continue;
    }

    if (skipping && isOtherHeader) {
      skipping = false;
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("\n").trimEnd();
}

// serializeTomlMcpServers 先输出非对象字段，再输出子表。
// 子表之间留空行，块与块之间再空一行；少一行会导致后续表头被并入上一个服务。
//
export function serializeTomlMcpServers(
  servers: Record<string, McpServerConfig>,
  configKeyName: string = "mcp_servers",
): string {
  const blocks = Object.entries(servers).map(([name, config]) => {
    const lines = [`[${configKeyName}.${name}]`];
    // 先序列化非对象的字段（内联值）
    const subTables: Array<[string, Record<string, unknown>]> = [];
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) {
        continue;
      }
      // 纯对象（非数组）作为子表输出，保持 TOML 风格
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        subTables.push([key, value as Record<string, unknown>]);
      } else {
        lines.push(`${key} = ${serializeTomlValue(value)}`);
      }
    }
    // 输出子表 [mcp_servers.serverName.subKey]
    for (const [subKey, subObj] of subTables) {
      lines.push("");
      lines.push(`[${configKeyName}.${name}.${subKey}]`);
      for (const [k, v] of Object.entries(subObj)) {
        if (v === undefined) {
          continue;
        }
        lines.push(`${k} = ${serializeTomlValue(v)}`);
      }
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
