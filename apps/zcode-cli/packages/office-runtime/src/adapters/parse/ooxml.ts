// OOXML 公共工具：zip 包打开/限流、关系（.rels）解析、preserveOrder XML 读取与 core.xml 标题提取。
// 边界：供 docx/pptx/xlsx 三个解析器复用；不关心具体文档语义，只提供按标签名取值的底层辅助。
// 失败语义：非 zip 或缺少部件 → OfficeError("corrupt_file")；解压总量超限 → "file_too_large"。
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { MAX_UNZIPPED_BYTES, OfficeError } from "#office/contract.ts";

// fast-xml-parser 的 preserveOrder 模式用「单键对象」表示元素：
// 键为标签名（#text 表示文本节点），值为子节点数组，属性单独放在 ":@" 键下。
// 本类型不做字段约束，具体读取由下面的辅助函数按标签名取值。
/** Order-preserving XML node from fast-xml-parser: `{ [tag]: children, ":@"?: attributes }`. */
export type XNode = Record<string, unknown>;

// 全局共享的解析器实例（无状态、可复用）。关键配置：
// preserveOrder 保留文档顺序（抽取文本依赖顺序）；ignoreAttributes=false 且把前缀置空，
// 使属性直接以原始属性名放在 ":@" 下；关闭实体展开与 HTML 实体，避免不必要的实体解析面；
// trimValues/parseTagValue/parseAttributeValue 全部关闭，所有值按原始字符串处理，
// 文本与属性统一由 decodeXml 解码，避免数字或布尔值被自动转型。
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Entities are never expanded: OOXML does not need them and expansion is an attack surface.
  processEntities: false,
  htmlEntities: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

// 只支持 XML 预定义的五个命名实体；其余命名实体（如 &nbsp;）保持原样，OOXML 规范不要求展开。
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// 命名实体匹配不区分大小写（&AMP; 与 &amp; 等价）；十六进制引用同时接受 x 与 X 前缀。
// 只解码五种 XML 实体与十进制/十六进制数值字符引用，未识别的引用原样保留。
// 数值引用限定在 Unicode 上限 0x10ffff 以内，越界不做替换，防止生成非法码点。
// 纯函数、幂等：已解码的 & 不会再次被识别，重复调用结果不变；不抛错。
/** Decode the five XML entities and numeric references only. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[name.toLowerCase()] ?? match;
  });
}

// 把 XML 文本解析成 preserveOrder 节点数组；语法错误会抛出 fast-xml-parser 的异常，
// 由调用方统一转成 corrupt_file，这里不做捕获。
// 入参必须是完整 XML 文本；输出为顶层节点数组，空文档返回空数组而非 null。
export function parseXml(text: string): XNode[] {
  return parser.parse(text) as XNode[];
}

// 只扫描第一层键名，耗时与键数线性相关；同一对象重复调用结果稳定，便于在循环中频繁取值。
// 取节点标签名：跳过 ":@" 属性键，返回首个键；空对象返回空串（调用方按未知节点处理）。
// 不抛错，也不校验 node 形状；非文本键（如 "@_x"）会原样返回，由调用方按名称匹配。
export function tagOf(node: XNode): string {
  for (const key of Object.keys(node)) if (key !== ":@") return key;
  return "";
}

// 对 #text 节点返回的是新建空数组，向其中 push 不会写回 XML 树，遍历时无需额外判空。
// 取节点的直接子节点数组；值不是数组（如 #text）时返回空数组，不抛错。
// 返回的是底层数组引用，调用方不得原地修改，否则会污染已解析的 XML 树。
export function kids(node: XNode): XNode[] {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as XNode[]) : [];
}

// 读取并解码元素属性；name 与解析器配置一致、直接使用原始属性名（如 "Id"，无前缀）。
// 属性不存在或值缺失时返回 undefined，区分于空字符串。
// 返回值已完成实体解码；属性名区分大小写，调用方需传入与 XML 完全一致的名称。
export function attr(node: XNode, name: string): string | undefined {
  const attrs = node[":@"] as Record<string, string> | undefined;
  const value = attrs?.[name];
  return value === undefined ? undefined : decodeXml(String(value));
}

// 仅当 #text 为字符串时按原样解码；非字符串值经 String 强转后处理，不校验其是否为合法 XML 片段。
// 读取 #text 节点的文本并解码实体；不是文本节点时返回 null，以便区分“无文本”与“空文本”。
// 只解码不归一空白，原始换行/缩进保留，交给具体解析器决定是否折叠。
/** Text value of a `#text` node. */
export function textOf(node: XNode): string | null {
  return "#text" in node ? decodeXml(String(node["#text"])) : null;
}

// 命中即短路，最多扫描一遍直接子节点；tag 比较区分大小写，不做命名空间归一。
// 第一个匹配 tag 的直接子元素；不存在时返回 undefined。
// 只查直接子元素、不递归；返回节点与 kids 的引用一致，不复制。
export function child(node: XNode, tag: string): XNode | undefined {
  return kids(node).find((item) => tagOf(item) === tag);
}

// 逐节点线性过滤，嵌套层中的同名元素不会被提升；返回数组可安全排序或截取。
// 所有匹配 tag 的直接子元素，保持文档顺序；没有时返回空数组。
// 新数组但元素仍是原引用；不递归、不按属性过滤，重复标签按出现次数保留。
export function childrenOf(node: XNode, tag: string): XNode[] {
  return kids(node).filter((item) => tagOf(item) === tag);
}

// 递归只沿子节点展开，兄弟命中后立即返回；传入空数组时直接得到 undefined。
// 深度优先查找首个匹配 tag 的元素（可穿透任意层级）；找不到返回 undefined。
// 文档顺序优先于层级：先访问当前节点及同级顺序，因此同一 tag 的嵌套节点以先出现者为准。
/** First element with the given tag in a document (depth-first). */
export function find(nodes: XNode[], tag: string): XNode | undefined {
  for (const node of nodes) {
    if (tagOf(node) === tag) return node;
    const found = find(kids(node), tag);
    if (found) return found;
  }
  return undefined;
}

// 命中节点不再向下展开，故嵌套的同名元素不计入；传入的 out 会被原地追加，调用方需自行去重。
// 深度优先收集全部匹配 tag 的元素；out 可传入已有数组做累加，返回同一引用。
// 遍历顺序与 find 一致；不处理循环引用（XML 树本身无环），也不去重。
export function findAll(nodes: XNode[], tag: string, out: XNode[] = []): XNode[] {
  for (const node of nodes) {
    if (tagOf(node) === tag) out.push(node);
    else findAll(kids(node), tag, out);
  }
  return out;
}

// OOXML 包（zip）的只读视图；路径按 zip 内相对路径处理（开头的 / 会被忽略）。
// has 用于探测部件是否存在；text 读不到时返回 null 而非抛错，由各解析器决定缺失是否致命；
// paths 返回 zip 内全部条目名，包含目录项与 _rels，调用方需自行过滤。
export interface Package {
  has(path: string): boolean;
  // 读取部件原始文本（XML）；部件不存在时返回 null。
  text(path: string): Promise<string | null>;
  // zip 内全部条目路径，保持加载顺序。
  paths(): string[];
}

// 打开 OOXML zip：JSZip 解析失败即判定为损坏，转成 OfficeError("corrupt_file")；
// 随后按各条目声明的解压后大小求和，超过 MAX_UNZIPPED_BYTES 直接拒绝（防 zip 炸弹）。
// 该检查只信声明值，真正解压仍按需读取；返回的 Package 每次调用都重新查表，不缓存内容。
/** Open an OOXML zip with a zip-bomb guard on the declared uncompressed sizes. */
export async function openPackage(bytes: Uint8Array, label: string): Promise<Package> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new OfficeError(
      "corrupt_file",
      `${label} is not a valid Office file (cannot read the zip package).`,
    );
  }
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const size =
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  }
  // 上限针对“解压后总字节”而非压缩包大小，避免高压缩比文件在后续读取时耗尽内存。
  if (total > MAX_UNZIPPED_BYTES)
    throw new OfficeError(
      "file_too_large",
      `${label} expands to more than ${MAX_UNZIPPED_BYTES / 1024 / 1024} MiB.`,
    );
  // 统一去掉前导斜杠：OOXML 的 Target 可能写成包内绝对路径，而 zip 条目名不带前导 /。
  const normalise = (path: string) => path.replace(/^\/+/, "");
  return {
    has: (path) => Boolean(zip.file(normalise(path))),
    async text(path) {
      const file = zip.file(normalise(path));
      return file ? file.async("string") : null;
    },
    paths: () => Object.keys(zip.files),
  };
}

// 把 rels 中的 Target 解析成包内绝对路径（相对 .rels 所属部件所在目录）：
// 处理 ./ 与 ../ 段；前导 / 视为包根；越出根的 ../ 被静默忽略（zip 只接受包内路径）。
// 输出是不带前导 / 的包内路径，未做 URL 解码；外部 Target 不应调用本函数。
/** Resolve a relationship target relative to the part that owns the .rels file. */
export function resolveTarget(partPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = partPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

// 读取指定部件的 .rels（路径规则：<dir>/_rels/<name>.rels），返回 id → 关系描述。
// 文件缺失返回空 Map（部件没有关系属合法情况）；缺少 Id 或 Target 的关系被跳过。
// external=true 的关系（如外部超链接）保留原始 Target，不按包内路径解析。
/** Read `<part>`'s relationships as id → { target (resolved), type, external }. */
export async function readRels(pkg: Package, partPath: string) {
  const dir = partPath.split("/").slice(0, -1).join("/");
  const name = partPath.split("/").pop();
  const xml = await pkg.text(`${dir ? `${dir}/` : ""}_rels/${name}.rels`);
  const rels = new Map<string, { target: string; type: string; external: boolean }>();
  if (!xml) return rels;
  for (const rel of findAll(parseXml(xml), "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    const external = attr(rel, "TargetMode") === "External";
    rels.set(id, {
      target: external ? target : resolveTarget(partPath, target),
      type: attr(rel, "Type") ?? "",
      external,
    });
  }
  return rels;
}

// 只拼接 #text 子节点，其他子元素被 textOf 转成空串；全空白标题与缺少部件一律返回 null。
// 读取 docProps/core.xml 的 dc:title，拼接其全部文本子节点并 trim；
// 无该部件或标题为空时返回 null（不拿文件名或正文臆测标题）。
export async function coreTitle(pkg: Package): Promise<string | null> {
  const xml = await pkg.text("docProps/core.xml");
  if (!xml) return null;
  const title = find(parseXml(xml), "dc:title");
  const text = title
    ? kids(title)
        .map((node) => textOf(node) ?? "")
        .join("")
        .trim()
    : "";
  return text || null;
}
