// Codex config.toml 序列化：在 smol-toml 之上修正 http_headers 的表结构。
// INV-01：http_headers 只能以 inline table 形式挂在 [model_providers.<id>] 主表下；
// 若写成独立子表，Codex 解析后会忽略，表现为鉴权头丢失（守住位置：rewriteHttpHeadersAsInlineTable）。
// INV-02：除 http_headers 段外，其他行必须逐字保留原 TOML 文本，包括注释与空行顺序；
// 重排会破坏用户手写内容，也会让 diff 噪音掩盖真实变更。
// INV-03：query_params.http_headers 是历史错误层级，序列化前必须剔除（守住位置：stripNestedQueryParamHttpHeaders）。
// 破坏后果：结构写错 → Codex 读不到鉴权头直接 401；过度重写 → 用户文件被格式化。
// 因此本模块所有编辑都是按行文本操作，不重新序列化整个文档。
import { stringify as stringifyToml } from "smol-toml";

// 统一的普通对象判据：数组与 null 都不算表；TOML 的 table/array/scalar 分支全靠它区分。
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// TOML bare key 只允许 A-Za-z0-9_-；含点号或其他字符的 provider id 必须加引号，
// 否则会被解析成嵌套表路径，headers 挂到错误层级。
const TOML_BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

// 与 smol-toml 的输出口径保持一致：裸键原样输出，非裸键用 JSON 字符串转义，
// 这样后续按行拼接时才能和库生成的表头逐字匹配。
function formatTomlKey(key: string): string {
  return TOML_BARE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}

// 只认顶格 [table]：带缩进或行尾注释的表头不会由 smol-toml 生成，
// 若放宽会误把数组值 [1, 2] 之类的行当成表头。
function isTomlTableHeaderLine(line: string | undefined): boolean {
  return typeof line === "string" && line.startsWith("[") && line.endsWith("]");
}

// 表体到下一条表头为止；返回的是表头之后第一个非本表行下标，
// 调用方用它做切片，边界错了会把相邻 provider 的配置一起删掉。
function getTomlTableEndIndex(lines: string[], tableStartIndex: number): number {
  let tableEnd = tableStartIndex + 1;
  while (tableEnd < lines.length) {
    if (isTomlTableHeaderLine(lines[tableEnd])) {
      break;
    }
    tableEnd += 1;
  }
  return tableEnd;
}

// 手写 inline table 序列化：smol-toml 会把 http_headers 展开成独立子表，
// 而 Codex 只接受主表下的 inline table，只能自己拼。
function formatTomlInlineValue(value: unknown): string {
  if (value === null || value === undefined) {
// [失败路径] null/undefined 没有 TOML 表示；静默跳过会让用户配的头消失，
// 所以直接抛错，让调用方在写文件前暴露问题。
    throw new TypeError("inline table 不支持 null/undefined");
  }

// 字符串用 JSON 转义（转义集合与 TOML basic string 兼容），并单独处理 DEL：
// JSON.stringify 不转义 U+007F，而 TOML 要求控制字符必须转义，否则生成的文件无法解析。
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/\x7f/g, "\\u007f");
  }

  if (typeof value === "number") {
// TOML 用 nan/inf/-inf 字面量，不能走 String()，否则得到 JS 的 NaN/Infinity。
    if (Number.isNaN(value)) {
      return "nan";
    }
    if (value === Infinity) {
      return "inf";
    }
    if (value === -Infinity) {
      return "-inf";
    }
    return String(value);
  }

  if (typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

// Date 序列化为 RFC3339；toISOString 对 Invalid Date 会抛 RangeError 且信息含糊，
// 先自行判 NaN 以给出可定位的错误。
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError("inline table 不支持无效 Date");
    }
    return value.toISOString();
  }

// 数组一律带空格输出 [ a, b ]，与 smol-toml 风格一致；空数组单独给 []，避免生成 [  ]。
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    return `[ ${value.map((item) => formatTomlInlineValue(item)).join(", ")} ]`;
  }

  if (!isObjectRecord(value)) {
    throw new TypeError(`inline table 不支持值类型: ${typeof value}`);
  }

// [权衡] 嵌套 table 也压成 inline 写法而不是展开成子表：headers 的值可能是多层对象，
// 内联能避免再次落入「独立子表被忽略」的坑。
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }

  const formattedEntries = entries.map(
    ([entryKey, entryValue]) => `${formatTomlKey(entryKey)} = ${formatTomlInlineValue(entryValue)}`,
  );
  return `{ ${formattedEntries.join(", ")} }`;
}

// 纯文本重写而非重新序列化：smol-toml 无法表达「主表里的 inline table」这一形态，
// 逐行定位再替换可以最大限度保留用户原有格式。
function rewriteHttpHeadersAsInlineTable(options: {
  toml: string;
  providerId: string;
  headers: Record<string, unknown>;
}): string {
  const { toml, providerId, headers } = options;
  const providerSegment = formatTomlKey(providerId);
  const providerTableHeader = `[model_providers.${providerSegment}]`;
  const headersTableHeader = `[model_providers.${providerSegment}.http_headers]`;
  const inlineHeaderLine = `http_headers = ${formatTomlInlineValue(headers)}`;

// 按行精确匹配表头，不做正则前缀匹配：provider id 里可能含引号和点，
// 只有完整字符串相等才能确认是目标表。
  const lines = toml.split("\n");
  let providerHeaderIndex = lines.findIndex((line) => line === providerTableHeader);
  const headersTableIndex = lines.findIndex((line) => line === headersTableHeader);

// 没有独立子表说明已是目标形态或用户手写，直接原样返回，避免无意义的重写。
  if (headersTableIndex < 0) {
    return toml;
  }

  const headersTableEnd = getTomlTableEndIndex(lines, headersTableIndex);

// 删除子表时连同它前面的空行一起删，否则会留下连续空行；
// [边界] removeStart 只回退一格：再往前会删掉上一个表的最后一个键值行，少退一格又会残留连续空行。
  let removeStart = headersTableIndex;
  if (removeStart > 0 && lines[removeStart - 1] === "") {
    removeStart -= 1;
  }

  let nextLines = [...lines.slice(0, removeStart), ...lines.slice(headersTableEnd)];
  providerHeaderIndex = nextLines.findIndex((line) => line === providerTableHeader);

// provider 主表可能完全不存在（历史文件只写了子表）：补一个主表再挂 inline headers；
// 追加前保证文件以换行结尾，否则新表头和上一行会粘成一行。
  if (providerHeaderIndex < 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines = [...nextLines, ""];
    }
    return [...nextLines, providerTableHeader, inlineHeaderLine].join("\n");
  }

  let providerTableEnd = getTomlTableEndIndex(nextLines, providerHeaderIndex);
  const providerBodyStart = providerHeaderIndex + 1;

// 主表里已有 http_headers 时原位替换，保持用户键顺序；
// [权衡] 就地替换而非先删后加，避免打乱同一表中的其他键。
  for (let lineIndex = providerBodyStart; lineIndex < providerTableEnd; lineIndex += 1) {
    if (/^http_headers\s*=/.test(nextLines[lineIndex] ?? "")) {
      const replaced = [...nextLines];
      replaced[lineIndex] = inlineHeaderLine;
      return replaced.join("\n");
    }
  }

// 插入点回退到表体最后一个非空行之后，防止把 headers 塞进表尾的空行堆里。
  let insertIndex = providerTableEnd;
  while (insertIndex > providerBodyStart && nextLines[insertIndex - 1] === "") {
    insertIndex -= 1;
  }

  nextLines = [
    ...nextLines.slice(0, insertIndex),
    inlineHeaderLine,
    ...nextLines.slice(insertIndex),
  ];

// 插入后表体变长，重新计算结束位置；若 headers 是最后一行且后面紧跟下一张表，
// 补一个空行作为分隔，避免两个表头相邻难以阅读。
  providerTableEnd = getTomlTableEndIndex(nextLines, providerHeaderIndex);
  if (providerTableEnd < nextLines.length && nextLines[providerTableEnd - 1] !== "") {
    nextLines = [
      ...nextLines.slice(0, providerTableEnd),
      "",
      ...nextLines.slice(providerTableEnd),
    ];
  }

  return nextLines.join("\n");
}

// 迁移兼容：早期实现把 headers 写进 query_params 下。只读代码无法修复历史文件，
// 因此在每次序列化时顺手剔除，写回后自然完成收敛。
function stripNestedQueryParamHttpHeaders(providerConfig: Record<string, unknown>): {
  providerConfig: Record<string, unknown>;
  changed: boolean;
} {
  const queryParams = providerConfig.query_params;
  if (!isObjectRecord(queryParams) || !("http_headers" in queryParams)) {
    return {
      providerConfig,
      changed: false,
    };
  }

// 只处理 query_params.http_headers 这一个已知错误位置，不做通用的删未知键：
// 用户可能真的需要自定义 query 参数，过度清理会改变请求语义。
  // Bugfix: 历史错误实现会把 provider 的 http_headers 写进 query_params.http_headers。
  // Codex 只认 provider 主表的 http_headers；这里在序列化前剔除错误层级，避免持续污染 config.toml。
  const nextProviderConfig = { ...providerConfig };
  const nextQueryParams = { ...queryParams };
  delete nextQueryParams.http_headers;

// query_params 被清空后整个键也要删掉，留一个空表会让 Codex 把
// [model_providers.x.query_params] 当成有效配置，产生无意义的空段。
  if (Object.keys(nextQueryParams).length === 0) {
    delete nextProviderConfig.query_params;
  } else {
    nextProviderConfig.query_params = nextQueryParams;
  }

  return {
    providerConfig: nextProviderConfig,
    changed: true,
  };
}

// 对外唯一入口：先剔除错误层级，再交给 smol-toml 生成基础文本，最后逐个重写 headers 段。
// 顺序不能反：先重写再剔除会删掉刚写好的主表内容。
export function stringifyCodexConfigToml(config: Record<string, unknown>): string {
  const modelProviders = isObjectRecord(config.model_providers)
    ? config.model_providers
    : null;

// 没有 model_providers 时不存在需要修正的结构，直接走库默认序列化，避免多余遍历。
// 这里不做任何 normalize：无 provider 的配置不该被本模块改写，否则会引入无关 diff。
  if (!modelProviders) {
    return stringifyToml(config);
  }

// 只有真的改过配置才复制顶层对象；未变化时复用原引用，减少一次无谓的对象分配。
// 该标志同时决定是否重建 model_providers，未变化时保持对象身份便于上层做引用比较。
  let hasConfigChanged = false;
  const normalizedModelProviders: Record<string, unknown> = {
    ...modelProviders,
  };

  for (const [providerId, providerConfig] of Object.entries(modelProviders)) {
    if (!isObjectRecord(providerConfig)) {
      continue;
    }

    const normalizedProviderResult = stripNestedQueryParamHttpHeaders(providerConfig);
    if (!normalizedProviderResult.changed) {
      continue;
    }

    hasConfigChanged = true;
    normalizedModelProviders[providerId] = normalizedProviderResult.providerConfig;
  }

// [权衡] 变化时整体替换 model_providers 而不 mutate 原对象：配置对象会跨调用共享，
// 原地写会让下一次序列化看到已被清理过的状态，掩盖 bug 也难以回滚。
  const configToSerialize = hasConfigChanged
    ? {
        ...config,
        model_providers: normalizedModelProviders,
      }
    : config;
  const baseToml = stringifyToml(configToSerialize);

  let resultToml = baseToml;
  for (const [providerId, providerConfig] of Object.entries(normalizedModelProviders)) {
    if (!isObjectRecord(providerConfig)) {
      continue;
    }

    const headers = providerConfig.http_headers;
    if (!isObjectRecord(headers)) {
      continue;
    }

// [失败路径] 重写是纯文本操作，找不到目标表时函数返回原文；这里不校验结果，
// 因为失败只会退回库生成的形态，不会破坏文件结构。
    resultToml = rewriteHttpHeadersAsInlineTable({
      toml: resultToml,
      providerId,
      headers,
    });
  }

  return resultToml;
}
