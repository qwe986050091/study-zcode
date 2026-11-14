// 文档所有者（应用层）：持有已打开文档的解析结果与读取会话，向 server 暴露 open/read/search 等能力。
// 边界：不直接读盘，文件字节与解析都由注入的 files / parse 适配器提供；状态只在进程内、按文档缓存。
// 失败语义：所有领域错误保持 OfficeError code；关闭文档后其 token 立即失效，重复读取报 invalid_token。
import { randomUUID } from "node:crypto";
import {
  FILE_CHUNK_BYTES,
  OfficeError,
  type DocumentInfo,
  type DocxBlockKey,
  type FileHandle,
  type Selection,
  type ShowTarget,
  type ViewerSnapshot,
  type ViewState,
} from "#office/contract.ts";
import { formatLocator, parseLocator, splitAnchor } from "#office/domain/anchor.ts";
import type { Hit, ParsedDocument, ReadPage } from "#office/domain/model.ts";
import { cut } from "#office/domain/text.ts";
import type { LoadedFile, WorkspaceFiles } from "#office/adapters/files.ts";

// 解析器签名：接收已读取的文件，返回解析结果；失败应以 OfficeError 表示。
export type Parser = (file: LoadedFile) => Promise<ParsedDocument>;

// 缓存条目：解析 Promise 共享给并发调用者，fingerprint 用于判断磁盘内容是否变化。
interface Entry {
  file: LoadedFile;
  fingerprint: string;
  parsed: Promise<ParsedDocument>;
}

// 最多缓存 6 份解析结果、4 个 panel 文件句柄；超出按插入顺序淘汰最旧项。
const MAX_CACHED = 6;
const MAX_HANDLES = 4;

// 文档所有者：统一管理解析缓存、文件分块句柄、当前展示文档与各 viewer 上报的视图。
// 服务端工具与 panel 都只通过该对象访问文档状态，避免多处缓存不一致。
/**
 * Owns everything the viewer knows: parsed documents (cached by path and revision), file handles
 * the panel reads bytes through, the document the viewer shows and the user's last reported view.
 * Server tools and the panel only go through this owner.
 */
// 依赖注入式构造：files 提供工作区读取与分块句柄，parse 负责把字节变成 ParsedDocument。
// 返回对象是进程内唯一的文档状态入口，按 path + revision 缓存解析结果，读取会话 token 独立管理。
// 失败语义：打开失败不写入缓存；关闭文档会释放句柄并使 token 失效，重复关闭是幂等的。
export function createDocumentOwner({ files, parse }: { files: WorkspaceFiles; parse: Parser }) {
  const cache = new Map<string, Entry>();
  const handles = new Map<string, { bytes: Uint8Array; path: string; revision: string }>();
  let current: DocumentInfo | null = null;
  // 无视图时的占位状态：各字段均为 null，updatedAt 为 0 表示从未上报。
  const emptyView = (): ViewState => ({
    path: null,
    kind: null,
    at: null,
    selection: null,
    updatedAt: 0,
  });
  const views = new Map<string, ViewState>();
  const reports = new Map<string, number>();
  let sequence = 0;
  let revealSeq = 0;

  // 取缓存条目：fingerprint 一致时复用并刷新 LRU 顺序，否则重新读取并异步解析。
  // 解析失败会自动从缓存移除，避免后续调用反复命中坏结果。
  async function entry(input: string): Promise<Entry> {
    const { path } = await files.resolve(input);
    const fingerprint = await files.fingerprint(path);
    const cached = cache.get(path);
    if (cached && cached.fingerprint === fingerprint) {
      cache.delete(path);
      cache.set(path, cached);
      return cached;
    }
    const file = await files.load(path);
    const fresh: Entry = { file, fingerprint, parsed: parse(file) };
    fresh.parsed.catch(() => cache.delete(path));
    cache.set(path, fresh);
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return fresh;
  }

  // 等待解析完成并返回文件与文档；解析错误原样抛给调用方。
  async function document(input: string) {
    const item = await entry(input);
    return { file: item.file, doc: await item.parsed };
  }

  // 把文件与解析结果合并为对外 DocumentInfo；title 可能为 null，outline 可能为空数组。
  const describe = (file: LoadedFile, doc: ParsedDocument): DocumentInfo => ({
    path: file.path,
    kind: file.kind,
    title: doc.title,
    bytes: file.bytes.byteLength,
    revision: file.revision,
    units: doc.units,
    outline: doc.outline,
  });

  // 解析并校验定位符，返回文档认可的规范文本；格式不符或越界由 parseLocator/check 抛错。
  /** Validate and normalise a locator for a document; returns its canonical text. */
  function canonical(doc: ParsedDocument, at: string): string {
    return formatLocator(doc.check(parseLocator(doc.kind, at)));
  }

  // 生成 viewer 快照；有揭示请求时分配递增 seq，panel 据此区分新旧指令。
  function snapshot(reveal?: { targets: ShowTarget[]; note?: string }): ViewerSnapshot {
    return {
      document: current,
      ...(reveal ? { reveal: { ...reveal, seq: ++revealSeq } } : {}),
    };
  }

  return {
    // 只返回文档元信息，不改变当前展示文档；用于 check_document 与 get_view。
    async info(path: string): Promise<DocumentInfo> {
      const { file, doc } = await document(path);
      return describe(file, doc);
    },

    // 打开文档并设为当前展示文档；at 不给则不带揭示指令，非法定位符会先抛错、不改变状态。
    /** Make `path` the viewer's document, optionally revealing a location in it. */
    async open(path: string, at?: string | null): Promise<ViewerSnapshot> {
      const { file, doc } = await document(path);
      const target = at ? canonical(doc, at) : null;
      current = describe(file, doc);
      return snapshot(target ? { targets: [{ at: target }] } : undefined);
    },

    // 揭示一个或多个位置：所有 anchor 必须解析到同一文档，否则整体拒绝。
    // 只给路径不给位置时用格式默认首页；quote 与 note 都会裁剪到 500 字符。
    /** Point the user at one or more places in one document; opens it if needed. */
    async show(
      targets: { anchor: string; quote?: string }[],
      note?: string,
    ): Promise<ViewerSnapshot> {
      if (!targets.length)
        throw new OfficeError("invalid_anchor", "Give at least one anchor to show.");
      const split = targets.map((target) => ({
        ...splitAnchor(target.anchor),
        quote: target.quote,
      }));
      const path = split[0].path;
      const { path: resolved } = await files.resolve(path);
      for (const item of split) {
        if ((await files.resolve(item.path)).path !== resolved)
          throw new OfficeError(
            "invalid_anchor",
            "All anchors passed to show must be in the same document.",
          );
      }
      const { file, doc } = await document(resolved);
      const resolvedTargets = split.map((item) => ({
        at: item.at ? canonical(doc, item.at) : defaultAt(doc),
        ...(item.quote?.trim() ? { quote: cut(item.quote.trim(), 0, 500) } : {}),
      }));
      current = describe(file, doc);
      return snapshot({
        targets: resolvedTargets,
        ...(note?.trim() ? { note: cut(note.trim(), 0, 500) } : {}),
      });
    },

    // 按 anchor 读取一页文本：无位置时交给解析器决定默认范围，cursor 由上一页返回。
    // 返回的 at 为规范定位符，调用方可原样用于后续 read/show。
    async read(
      anchor: string,
      cursor = 0,
    ): Promise<{ info: DocumentInfo; at: string | null; page: ReadPage }> {
      const { path, at } = splitAnchor(anchor);
      const { file, doc } = await document(path);
      const locator = at ? doc.check(parseLocator(doc.kind, at)) : null;
      return {
        info: describe(file, doc),
        at: locator ? formatLocator(locator) : null,
        page: doc.read(locator, cursor),
      };
    },

    // 在单个文档内检索：空白 query 直接报错，limit 由调用方给出；命中为空时返回空数组。
    async search(
      path: string,
      query: string,
      limit: number,
    ): Promise<{ info: DocumentInfo; hits: Hit[] }> {
      if (!query.trim()) throw new OfficeError("invalid_anchor", "The search query is empty.");
      const { file, doc } = await document(path);
      return { info: describe(file, doc), hits: doc.search(query.trim(), limit) };
    },

    // panel 专用：返回渲染所需信息与分块句柄；句柄缓存原始字节，超过上限淘汰最旧 token。
    // blocks 仅在解析器提供时出现（docx 用于元素到定位符的映射）。
    /** Panel only: load bytes for rendering and hand out a token to read them in chunks. */
    async load(
      path: string,
    ): Promise<{ info: DocumentInfo; file: FileHandle; blocks?: DocxBlockKey[] }> {
      const { file, doc } = await document(path);
      const token = randomUUID();
      handles.set(token, { bytes: file.bytes, path: file.path, revision: file.revision });
      while (handles.size > MAX_HANDLES) handles.delete(handles.keys().next().value!);
      return {
        info: describe(file, doc),
        file: {
          token,
          bytes: file.bytes.byteLength,
          chunks: Math.max(1, Math.ceil(file.bytes.byteLength / FILE_CHUNK_BYTES)),
        },
        ...(doc.blocks ? { blocks: doc.blocks } : {}),
      };
    },

    // panel 专用：按 token 与 index 返回 base64 分块；token 过期或 index 越界抛 invalid_token。
    // 空文件仍允许 index=0，返回空字符串，以保证 chunks=1 的约定成立。
    chunk(token: string, index: number): string {
      const handle = handles.get(token);
      if (!handle)
        throw new OfficeError("invalid_token", "This file handle expired; reload the document.");
      const start = index * FILE_CHUNK_BYTES;
      if (!Number.isInteger(index) || index < 0 || (start >= handle.bytes.byteLength && index > 0))
        throw new OfficeError("invalid_token", "Chunk index out of range.");
      return Buffer.from(handle.bytes.subarray(start, start + FILE_CHUNK_BYTES)).toString("base64");
    },

    // panel 专用：记录用户视图；path 必须为工作区内文件，at 与 selection 为空表示清空。
    // 同一 viewId 只保留最后一次上报，先到的旧上报返回当前已知状态而不覆盖新值。
    /** Panel only: record where the user is. The path must be the panel's current document. */
    async report(input: {
      viewId?: string;
      path: string;
      at?: string | null;
      selection?: Selection | null;
    }): Promise<ViewState> {
      const viewId = input.viewId ?? "legacy";
      const ticket = ++sequence;
      reports.set(viewId, ticket);
      const { path, kind } = await files.resolve(input.path);
      const clip = (text: string) => cut(text, 0, 2000);
      const view: ViewState = {
        path,
        kind,
        at: input.at ? cut(input.at, 0, 300) : null,
        selection: input.selection?.at
          ? { at: cut(input.selection.at, 0, 300), text: clip(input.selection.text ?? "") }
          : null,
        updatedAt: Date.now(),
      };
      // 多窗口不能共用最后写者；上报也不应修改 Agent 专用 surface 的当前文档。
      // 旧上报完成时不能覆盖新上报，也不能重新创建已释放的窗口。
      if (reports.get(viewId) !== ticket) return views.get(viewId) ?? emptyView();
      views.set(viewId, view);
      return view;
    },

    // 列出所有已上报视图，附带 viewId；调用方用于消歧。
    views: () => [...views].map(([viewId, view]) => ({ viewId, ...view })),
    // 释放视图：同时删除上报票据与视图状态，之后 get_view 不再看到它。
    releaseView: (viewId: string) => {
      reports.delete(viewId);
      views.delete(viewId);
    },
    // 取指定 viewId 的视图；未指定时仅当恰好一个视图才返回它，否则返回空视图。
    view: (viewId?: string) =>
      viewId
        ? (views.get(viewId) ?? emptyView())
        : views.size === 1
          ? views.values().next().value!
          : emptyView(),
    // 当前展示文档；未打开过任何文档时为 null。
    current: () => current,
    // 生成当前快照，不含揭示指令。
    snapshot: () => snapshot(),
    // 清空当前文档与所有视图上报，返回清空后的快照；解析缓存与句柄不受影响。
    close() {
      current = null;
      reports.clear();
      views.clear();
      return snapshot();
    },
    // 枚举工作区文档；limit 为空时由 files.list 使用默认值。
    list: (limit?: number) => files.list({ limit }),
  };
}

// 各格式的默认位置：pdf 首页、pptx 首张、docx 首段、xlsx 首个工作表。
// xlsx 没有大纲时回退到 "Sheet1"，它是 Excel 默认工作表名。
function defaultAt(doc: ParsedDocument): string {
  switch (doc.kind) {
    case "pdf":
      return "page:1";
    case "pptx":
      return "slide:1";
    case "docx":
      return "p:1";
    case "xlsx":
      return doc.outline[0]?.at ?? "Sheet1";
  }
}

// 文档所有者的对外类型，server 与 main 依赖它而非具体实现。
export type DocumentOwner = ReturnType<typeof createDocumentOwner>;
