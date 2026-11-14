// INV-01 迁移是只读的：不修改旧存储，守住位置 全部读取函数；改错故障：迁移过程写回旧文件会让回滚后数据不一致。
// INV-02 逐层校验后才解析：每一层都先确认是对象，守住位置 各层判断；改错故障：缺校验时对字符串取属性会抛错，整次迁移失败。
// INV-03 解析失败一律视为未找到：守住位置 各异常分支；改错故障：抛错会让一个损坏候选中断后续所有候选。
// INV-04 候选按优先级排列：显式目录、旧存储、各运行形态的数据目录，守住位置 候选构造；改错故障：顺序混乱会让新格式数据被旧副本抢先。
// INV-05 候选去重但保持首次出现顺序：守住位置 集合转换；改错故障：去重打乱顺序会改变优先级语义。
// INV-06 显式目录优先于内置路径：守住位置 候选首项；改错故障：用户指定路径被内置路径抢先，迁移到错误目录。
// INV-07 旧存储候选以文件名后缀识别：守住位置 分派判断；改错故障：把数据目录当文件读会静默返回未找到。
// INV-08 旧存储键名固定：守住位置 顶层取值；改错故障：键名漂移后永远读不到配置，迁移静默为空。
// INV-09 内层值可能是字符串化 JSON：守住位置 二次解析；改错故障：只按对象读会让字符串形态的配置被跳过。
// INV-10 配置层级固定为状态对象下的配置字段：守住位置 两级取值；改错故障：跳层读取会让服务器表恒为空。
// INV-11 服务器表必须非空才算命中：守住位置 非空判断；改错故障：空表被当作命中会阻断后续候选尝试。
// INV-12 文本扫描按平衡括号截取：守住位置 括号配对函数；改错故障：按正则截取会在嵌套对象处截断，解析失败。
// INV-13 字符串内的括号与转义不参与配对：守住位置 状态机分支；改错故障：把字符串里的花括号计入深度会提前结束。
// INV-14 扫描可多次尝试：单个候选解析失败后继续向后找，守住位置 扫描循环；改错故障：首次失败即返回会漏掉后面有效的键。
// INV-15 数据目录只读数据段与日志文件：守住位置 后缀过滤；改错故障：读取锁文件会因占用失败，拖慢迁移。
// INV-16 数据段按文件名倒序尝试：新段优先，守住位置 排序比较器；改错故障：正序会让旧段先命中，迁移到过期配置。
// INV-17 读取用单字节编码以保留原始字节：守住位置 解码方式；改错故障：按多字节编码解码会在非法字节处替换字符，破坏 JSON。
// INV-18 全部候选失败返回空结果而非抛错：守住位置 主流程末尾；改错故障：抛错会让首次启动因缺少旧数据而中断。
//
// 模块职责：从旧版 store.json 与浏览器数据目录中只读提取公共 MCP 服务器配置，供迁移使用。
// 状态所有权：无状态；candidates、文件句柄与解析中间值只存在于单次调用内。
// 阅读顺序：先看括号配对与服务器表提取，再看两种读取形态，最后看候选构造与主流程短路。
/**
 * MCP 用户目录模块 - Legacy 迁移
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  McpServerConfig,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
} from "@zcode/shared";
import { isRecord, normalizeServerMap } from "./utils.js";

// extractBalancedJson 用 depth/inString/escaped 三个状态扫到第一个 depth === 0 的 "}"：字符串内的 { } 与 \" 不计深度，否则嵌套配置会被提前截断；startIndex 不是 "{" 时行为由 extractLegacyCommonMcpFromText 保证，未闭合返回 null 让外层继续 indexOf("mcp-config")。
function extractBalancedJson(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function getLegacyCommonServers(value: unknown): Record<string, McpServerConfig> | null {
  if (!isRecord(value)) {
    return null;
  }

  const mcp = value.mcp;
  if (!isRecord(mcp) || !("mcpServers" in mcp)) {
    return null;
  }

  return normalizeServerMap(mcp.mcpServers);
}

// readLegacyCommonMcpFromStoreJson 逐层取 storeRoot["mcp-storage"]（字符串、需二次 JSON.parse）→ mcpStorage.state → state.config → getLegacyCommonServers(config)：任一层不是 isRecord 就 return null；keys 固定为 "mcp-storage"，服务器表 Object.keys(servers).length > 0 才算命中，否则继续下一个候选；整段 try/catch 把解析异常归为未找到。
async function readLegacyCommonMcpFromStoreJson(
  storeJsonPath: string,
): Promise<MigrateLegacyCommonMcpResult | null> {
  try {
    const raw = await readFile(storeJsonPath, "utf-8");
    const storeRoot = JSON.parse(raw) as unknown;

    if (!isRecord(storeRoot)) {
      return null;
    }

    const mcpStorageRaw = storeRoot["mcp-storage"];
    if (typeof mcpStorageRaw !== "string") {
      return null;
    }

    const mcpStorage = JSON.parse(mcpStorageRaw) as unknown;
    if (!isRecord(mcpStorage)) {
      return null;
    }

    const state = mcpStorage.state;
    if (!isRecord(state)) {
      return null;
    }

    const config = state.config;
    if (!isRecord(config)) {
      return null;
    }

    const servers = getLegacyCommonServers(config);
    if (servers && Object.keys(servers).length > 0) {
      return {
        servers,
        sourcePath: storeJsonPath,
        totalCount: Object.keys(servers).length,
        importedCount: 0,
        skippedCount: 0,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// extractLegacyCommonMcpFromText 以 "mcp-config" 为锚点循环 text.indexOf：每次把 searchStart 推到 keyIndex + "mcp-config".length，避免原地打转；extractBalancedJson 返回空或 JSON.parse 失败只 catch 后继续找下一个同名键，最终 null 表示该文件没有可迁移配置。
function extractLegacyCommonMcpFromText(text: string): Record<string, McpServerConfig> | null {
  let searchStart = 0;

  while (searchStart < text.length) {
    const keyIndex = text.indexOf("mcp-config", searchStart);
    if (keyIndex < 0) {
      return null;
    }

    const jsonStart = text.indexOf("{", keyIndex);
    if (jsonStart < 0) {
      return null;
    }

    const jsonText = extractBalancedJson(text, jsonStart);
    if (jsonText) {
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        const servers = getLegacyCommonServers(parsed);
        if (servers) {
          return servers;
        }
      } catch {
        // continue scanning for the next candidate
      }
    }

    searchStart = keyIndex + "mcp-config".length;
  }

  return null;
}

// readLegacyCommonMcpFromLevelDbDir 只保留 /.(?:ldb|log)$/i 的普通文件，锁与清单跳过；entries 用 right.name.localeCompare(left.name, undefined, { numeric: true }) 倒序，新段优先；readFile 后 raw.toString("latin1") 保留原始字节，单文件异常只跳过，命中即返回，不再读更旧文件。
async function readLegacyCommonMcpFromLevelDbDir(
  directoryPath: string,
): Promise<MigrateLegacyCommonMcpResult | null> {
  let entries: Array<{ name: string; fullPath: string }> = [];
  try {
    const dirents = await readdir(directoryPath, { withFileTypes: true });
    entries = dirents
      .filter((entry) => entry.isFile() && /.(?:ldb|log)$/i.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        fullPath: join(directoryPath, entry.name),
      }))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
  } catch {
    return null;
  }

  for (const entry of entries) {
    try {
      const raw = await readFile(entry.fullPath);
      const text = raw.toString("latin1");
      const servers = extractLegacyCommonMcpFromText(text);
      if (servers) {
        return {
          servers,
          sourcePath: entry.fullPath,
          totalCount: Object.keys(servers).length,
          importedCount: 0,
          skippedCount: 0,
        };
      }
    } catch {
      // ignore unreadable candidate files and continue
    }
  }

  return null;
}

// buildLegacyCommonMcpStorageCandidates 的顺序就是优先级：request.legacyStorageDir 最前，其次 appData/ai.z.zcode/store.json（结构更完整），再列 ZCode 与 ZCode Dev 的 Local Storage 与嵌入式浏览器分区；最后 Array.from(new Set(candidates)) 去重但保持首次出现顺序。
function buildLegacyCommonMcpStorageCandidates(request?: MigrateLegacyCommonMcpRequest): string[] {
  const candidates: string[] = [];
  if (request?.legacyStorageDir) {
    candidates.push(request.legacyStorageDir);
  }

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

  // 优先从老的 store.json 读取 common MCP 配置
  candidates.push(join(appData, "ai.z.zcode", "store.json"));

  candidates.push(
    join(localAppData, "ai.z.work", "EBWebView", "Default", "Local Storage", "leveldb"),
    join(appData, "ZCode", "Local Storage", "leveldb"),
    join(appData, "ZCode", "Partitions", "zcode-embedded-browser", "Local Storage", "leveldb"),
    join(appData, "ZCode Dev", "Local Storage", "leveldb"),
    join(appData, "ZCode Dev", "Partitions", "zcode-embedded-browser", "Local Storage", "leveldb"),
  );

  return Array.from(new Set(candidates));
}

// migrateLegacyCommonMcp 按 candidate.endsWith("store.json") 分派：文件走 readLegacyCommonMcpFromStoreJson，其余走 readLegacyCommonMcpFromLevelDbDir，任一命中立即 return；全部落空返回 { servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 } 而不抛错，本函数不写存储，落盘由调用方完成。
export async function migrateLegacyCommonMcp(
  request?: MigrateLegacyCommonMcpRequest,
): Promise<MigrateLegacyCommonMcpResult> {
  for (const candidate of buildLegacyCommonMcpStorageCandidates(request)) {
    // 优先尝试从 store.json 读取
    if (candidate.endsWith("store.json")) {
      const result = await readLegacyCommonMcpFromStoreJson(candidate);
      if (result) {
        return result;
      }
    } else {
      // 然后尝试从 leveldb 读取
      const result = await readLegacyCommonMcpFromLevelDbDir(candidate);
      if (result) {
        return result;
      }
    }
  }

  return {
    servers: {},
    totalCount: 0,
    importedCount: 0,
    skippedCount: 0,
  };
}
