// MCP server 适配层：把文档所有者与导入器包装成工具、资源与 UI 资源路由，供宿主调用。
// 边界：工具参数在此做 schema 校验并转成领域调用；不直接读写文件，文件访问全部委托 owner/importer。
// 失败语义：领域错误统一编码为结构化 error（code + message），资源不存在返回宿主可识别的错误。
// MCP 适配层：DocumentOwner 与文档导入器的唯一对外入口，把领域能力暴露为模型工具、panel 工具与 UI 资源。
// 边界：本层只做参数 schema 收敛、可见性声明、结果良构化与错误归一化，不持有文档状态、不碰磁盘字节。
// 不负责：字节读写与缓存（由 owner / importer 承担）、进程与传输生命周期（main.ts 负责）、面板渲染与前端逻辑。
//
// 改动前必须守住的不变量：
// INV-01 断言：任何工具都必须经 register 包装后注册 —— 守住它的位置：register 内的 server.registerTool —— 改错故障：绕过后缺 _meta.ui，panel 收不到结果且模型侧看不到可见性。
// INV-02 断言：readOnly 未显式声明时按只读处理 —— 守住它的位置：register 的 annotations.readOnlyHint —— 改错故障：写工具被当成只读，宿主跳过确认直接改盘。
// INV-03 断言：工具执行抛出的任何异常都转成 isError 结果而非冒泡 —— 守住它的位置：register 的 catch 分支 —— 改错故障：异常穿透 MCP 帧，宿主侧表现为整轮会话中断。
// INV-04 断言：非 OfficeError 一律编码为 corrupt_file 并写 stderr —— 守住它的位置：catch 内的 code 选择与 stderr 写入 —— 改错故障：真实根因被吞掉，排查时只剩一句没有堆栈的报错。
// INV-05 断言：返回的 text 与 structuredContent 都必须良构化 —— 守住它的位置：textResult —— 改错故障：文档里的孤立代理项进入 JSON-RPC，整条响应被判非法。
// INV-06 断言：document 为空的快照只回一句提示 —— 守住它的位置：describeSnapshot 的首个 return —— 改错故障：空文档时仍拼接大纲段，模型收到自相矛盾的视图描述。
// INV-07 断言：get_view 遇多 viewer 且无 viewId 时返回歧义列表 —— 守住它的位置：views.length 大于 1 的分支 —— 改错故障：默认挑第一个视图，模型把回答建立在用户没在看的文档上。
// INV-08 断言：未知 viewId 必须报 invalid_token —— 守住它的位置：views.some 校验 —— 改错故障：静默回退到其他视图，用户选区与模型引用不一致。
// INV-09 断言：导入类工具只对 app 可见且 readOnly 为 false —— 守住它的位置：begin/write/finish/cancel 四处注册 —— 改错故障：模型可自造导入，绕过用户显式选择文件的授权。
// INV-10 断言：导入必须按 begin 到 chunk 到 finish 的顺序推进 —— 守住它的位置：importer 分支内的四个工具 —— 改错故障：offset 校验失效，最终文件字节错位或被截断。
// INV-11 断言：静态资源名必须过 isAssetName 白名单后才拼路径 —— 守住它的位置：assets 资源回调 —— 改错故障：路径穿越可读到 assetRoot 之外的任意文件。
// INV-12 断言：文件分块的 token 与 index 合法性由 owner.chunk 裁决 —— 守住它的位置：file 资源回调 —— 改错故障：越界 index 返回空 blob，panel 渲染出残缺文档且不报错。
// INV-13 断言：panel 资源的 CSP 元数据必须同时挂在资源与内容上 —— 守住它的位置：panelMeta 的两处引用 —— 改错故障：pdf.js 拿不到 wasm 与 eval 许可，PDF 页白屏。
// INV-14 断言：anchor 上限 1200 且描述里的示例必须可解析 —— 守住它的位置：anchor 的 zod 定义 —— 改错故障：模型照抄摘要示例构造定位符却解析失败。
// INV-15 断言：describeDocument 只读 DocumentInfo 快照、不触发文档读取 —— 守住它的位置：describeDocument 全函数 —— 改错故障：摘要变成隐式 IO，get_view 等高频调用被拖慢。
// INV-16 断言：outlineLimit 只影响展示条数、不改变返回语义 —— 守住它的位置：describeDocument 的 slice —— 改错故障：把限额当成截断点，模型误判文档只有前 N 个条目。
// INV-17 断言：新增 DocKind 必须同步三张名称表 —— 守住它的位置：KIND_NAMES、UNIT_NAMES、LOCATION_HELP —— 改错故障：摘要出现 undefined 或错误定位语法，模型持续产出坏 anchor。
import type { createDocumentImporter } from "#office/adapters/files.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_PREFIX,
  FILE_PREFIX,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  HTML_MIME,
  OfficeError,
  PANEL_URI,
  PLUGIN_VERSION,
  SERVER_NAME,
  SURFACE_ID,
  type DocKind,
  type DocumentInfo,
  type ViewerSnapshot,
} from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { truncateBytes } from "#office/domain/model.ts";
import { wellFormed, wellFormedDeep } from "#office/domain/text.ts";
import type { DocumentOwner } from "#office/app/documents.ts";
import { isAssetName } from "#office/adapters/assets.ts";
import {
  EXAMPLE_ANCHORS,
  EXAMPLE_LOCATIONS,
  EXTENSIONS_OR,
  FILE_NOUN,
  FILES_NOUN,
  QUOTE_BEST_FOR,
  READ_FORMS,
  TARGET_NOUNS,
  TITLE,
} from "#office/wording.ts";

// [契约] 可见性同时写进 _meta.ui，是宿主判断模型能否调用该工具的唯一依据。
// 不要指望用工具名或 description 表达可见性，宿主不解析自然语言描述。
// 把 app 专属工具开放给模型，等于把文件导入这类用户授权动作变成模型可自触发。
// 工具的可见性：model 表示模型可调用，app 表示仅 panel 可调用。
type Visibility = ("model" | "app")[];

// 格式的可读名称，用于模型摘要。
const KIND_NAMES: Record<DocKind, string> = {
  docx: "Word document",
  xlsx: "Excel workbook",
  pptx: "PowerPoint presentation",
  pdf: "PDF",
};
// units 字段在各格式下的计量单位名称。
const UNIT_NAMES: Record<DocKind, string> = {
  docx: "blocks",
  xlsx: "sheets",
  pptx: "slides",
  pdf: "pages",
};
// [契约] 这些示例必须与 domain/anchor.ts 的解析分支一一对应，改一侧就要同步另一侧。
// 模型会把摘要当成文档说明照抄，语法写错就会持续产出解析失败的 anchor。
// 带空格的工作表名是 xlsx 最容易写错的地方，示例里已用单引号包裹，不要改成双引号。
// 各格式定位符语法说明，直接拼进模型摘要，帮助模型构造合法 anchor。
const LOCATION_HELP: Record<DocKind, string> = {
  docx: "Locations: p:N (paragraph), p:N-M, t:N (table), t:N/rRcC (table cell).",
  xlsx: "Locations: Sheet, Sheet!A1, Sheet!A1:D20 (quote names with spaces: 'Q3 data'!A1).",
  pptx: "Locations: slide:N, slide:N-M, slide:N/shape:ID.",
  pdf: "Locations: page:N, page:N-M.",
};

// 生成面向模型的文档摘要：格式、规模、修订号、按层级缩进的大纲与定位符语法。
// outlineLimit 只限制展示条数，超出部分以 “… N more” 提示；空大纲不输出该段。
// 纯字符串拼接，不读文档正文；输出长度受 TEXT_BUDGET 约束由调用方负责裁剪，本函数不自行截断。
/** Model-facing summary of a document: what it is, its outline and how to address it. */
// [契约] 只消费 DocumentInfo 快照：这些数据在 open 与 read 时已算好，这里再读盘会让高频 get_view 变慢。
// [权衡] outlineLimit 默认 60 是模型上下文预算，不是正确性边界，调用方可以按场景收紧。
// 空大纲时整段不输出，避免模型把「文档没有标题」误读成「文档为空」。
// 缩进按 level 减 1 推导，level 为 0 的脏数据用 Math.max 兜底，不要改成直接乘层级。
export function describeDocument(info: DocumentInfo, outlineLimit = 60): string {
  const lines = [
    `${info.path}: ${KIND_NAMES[info.kind]}, ${info.units} ${UNIT_NAMES[info.kind]}, ${(info.bytes / 1024).toFixed(0)} KiB, revision ${info.revision}.`,
  ];
  if (info.title) lines.push(`Title: ${info.title}`);
  if (info.outline.length) {
    lines.push(info.kind === "xlsx" ? "Sheets:" : info.kind === "pptx" ? "Slides:" : "Outline:");
    for (const item of info.outline.slice(0, outlineLimit))
      lines.push(
        `${"  ".repeat(Math.max(0, item.level - 1))}- ${formatAnchor(info.path, item.at)}  ${item.label}`,
      );
    if (info.outline.length > outlineLimit)
      lines.push(`  … ${info.outline.length - outlineLimit} more`);
  }
  lines.push(LOCATION_HELP[info.kind]);
  return lines.join("\n");
}

// 描述一次 open/show 之后 viewer 的状态：带动作词的首行、揭示的目标与文档摘要。
// 无文档时只返回一句提示，不拼接后面的段落。
// 首个分支必须提前返回：没有文档时拿不到 path，继续拼装只会抛异常而不是给出提示。
// reveal 里的 quote 只在该定位符内高亮，格式化时必须带上定位符，否则用户不知道高亮落在哪。
// 结尾固定引导 read_document：视图描述只讲「看到了什么」，不讲「内容是什么」。
function describeSnapshot(snapshot: ViewerSnapshot, verb: string): string {
  if (!snapshot.document) return `The ${TITLE} viewer has no document open.`;
  const parts = [`${verb} ${snapshot.document.path} in the ${TITLE} panel.`];
  if (snapshot.reveal?.targets.length)
    parts.push(
      `Showing: ${snapshot.reveal.targets.map((target) => formatAnchor(snapshot.document!.path, target.at) + (target.quote ? ` ("${target.quote}")` : "")).join(", ")}.`,
    );
  parts.push(
    "",
    describeDocument(snapshot.document),
    "",
    "Use read_document to read content; the user sees the rendered file in the panel.",
  );
  return parts.join("\n");
}

// 统一包装工具结果：对 text 做良构处理，避免文档内的孤立代理项破坏传输。
// structuredContent 仅在传入时才出现，且同样做深度良构化。
/** Tool results leave the server well formed even if a document's own text is broken. */
// [契约] text 必须良构化：文档正文来自任意文件，孤立代理项会让序列化出的 JSON 非法。
// structuredContent 用 wellFormedDeep 逐层处理，只处理顶层会让嵌套的选区文本漏网。
// 条件展开是为让无 structured 的工具不产生空对象，避免宿主侧 schema 校验出现多余字段。
const textResult = (text: string, structuredContent?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: wellFormed(text) }],
  ...(structuredContent ? { structuredContent: wellFormedDeep(structuredContent) } : {}),
});

// 组装 MCP server：注册模型工具、panel 工具与三类资源（panel 页面、静态资源、文件分块）。
// owner 负责文档状态，importer 为空时（例如只读场景）不会注册导入相关工具。
// 返回值是构造完成的 Server 实例，尚未 connect；连接与传输由 main.ts 负责，避免本层持有 stdout。
// [权衡] 这里只组装不 connect：传输与 stdout 归属 main.ts，本层持有连接会让测试无法单独构造实例。
// importer 可选是刻意的，只读宿主不注册导入工具，攻击面随之收敛。
// assetRoot 只被两个资源回调使用，不缓存 html 内容，改完面板重启即生效。
// 三个资源的 uri 前缀取自 contract.ts，不要在此写死字符串，否则 panel 与宿主路由会错位。
export function createOfficeServer({
  owner,
  assetRoot,
  importer,
}: {
  owner: DocumentOwner;
  assetRoot: string;
  importer?: ReturnType<typeof createDocumentImporter>;
}) {
  // 名称与版本取自 contract.ts，宿主据此做插件识别与兼容判断，不要在本层覆盖。
  // 实例创建后立即注册工具，顺序无关，但 register 闭包捕获的必须是这个实例。
  const server = new McpServer({ name: SERVER_NAME, version: PLUGIN_VERSION });

  // 注册工具的公共封装：统一写入 description、inputSchema 与 annotations，并把异常转成带错误码的结果。
  // 非 OfficeError 视为未预期错误，额外写 stderr（含堆栈），仍以 corrupt_file 返回给调用方。
  // [契约] 工具的统一入口：description、inputSchema、annotations、_meta 四件套必须同时给出。
  // readOnlyHint 默认 true 是保守选择，有副作用的工具必须显式 readOnly 为 false 才能被宿主正确审批。
  // panel 为真才挂 ui 资源路由，否则 panel 无法渲染该工具结果；openPanel 只在需要抢占视图时置真。
  // 泛型 Shape 已让 execute 入参由 zod 推断，不要在回调里再手工收窄或另建类型。
  const register = <Shape extends z.ZodRawShape>(
    name: string,
    config: {
      description: string;
      input: Shape;
      visibility: Visibility;
      /** Route results to the panel (and open it when `openPanel`). */
      panel?: boolean;
      openPanel?: boolean;
      readOnly?: boolean;
    },
    execute: (
      input: z.infer<z.ZodObject<Shape>>,
    ) => Promise<{ text: string; structured?: Record<string, unknown> }>,
  ) => {
    server.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.input,
        annotations: { readOnlyHint: config.readOnly ?? true },
        _meta: {
          ui: config.panel
            ? { resourceUri: PANEL_URI, surface: SURFACE_ID, visibility: config.visibility }
            : { visibility: config.visibility },
          ...(config.openPanel ? { "openai/ui": { preferredModelDisplayMode: "fullscreen" } } : {}),
        },
      },
      (async (input: z.infer<z.ZodObject<Shape>>) => {
        try {
          const { text, structured } = await execute(input);
          return textResult(text, structured);
        // [失败路径] 这里是唯一的异常出口：execute 内抛出的领域错误全部在此转成 isError 结果。
        // [契约] 非 OfficeError 一律兜底为 corrupt_file，因为调用方只认识 contract.ts 里定义的错误码。
        // 只有未预期错误才写 stderr 并带堆栈，领域错误已由 owner 编码，重复打印只会污染日志。
        // 不要在此吞掉错误后返回成功文本：宿主会基于空白结果继续推理，症状比直接报错更难排查。
        } catch (error) {
          const code = error instanceof OfficeError ? error.code : "corrupt_file";
          const message = error instanceof Error ? error.message : String(error);
          if (!(error instanceof OfficeError))
            process.stderr.write(
              `[${SERVER_NAME}] ${name}: ${(error as Error)?.stack ?? message}\n`,
            );
          return {
            isError: true,
            ...textResult(`[${code}] ${message}`, { error: { code, message } }),
          };
        }
      }) as never,
    );
  };

  // 通用定位符 schema：`<路径>#<位置>`，省略 #位置 表示整篇；长度上限 1200 防止异常输入。
  // [契约] 定位符是模型与 owner 之间的稳定协议：路径加 #位置，省略位置表示整篇。
  // 1200 的上限用于挡住异常长输入，与 owner 侧解析器的限制保持一致，不要单边放宽。
  // describe 文本会原样进入模型可见的 schema，其中的示例必须保持可解析。
  const anchor = z
    .string()
    .min(1)
    .max(1200)
    .describe(
      `Document anchor: <workspace-relative path>#<location>, e.g. ${EXAMPLE_ANCHORS}. Omit #<location> for the whole document.`,
    );

  // panel 与 openPanel 同时为真：用户必须真的看到文件，否则模型声称「已打开」就是假话。
  // structured 直接展开快照，panel 依赖其中字段还原揭示目标，删字段会让跳转静默失效。
  // at 为可选，缺省位置由 owner 决定，本层不要补默认值，否则不同格式的起始语义会被抹平。
  // open_document：打开文档并可跳转到指定位置，同时开启 panel；返回快照供模型描述当前视图。
  register(
    "open_document",
    {
      description: `Open a ${EXTENSIONS_OR} file from the workspace in the ${TITLE} viewer panel, which the user sees. Optionally jump to a location. Returns the document's outline and how to address locations in it. Use this when the user wants to view, review or discuss ${FILE_NOUN}.`,
      input: {
        path: z.string().min(1).max(1000).describe("Workspace-relative path of the file."),
        at: z
          .string()
          .max(300)
          .optional()
          .describe(`Optional location to show, e.g. ${EXAMPLE_LOCATIONS}.`),
      },
      visibility: ["model", "app"],
      panel: true,
      openPanel: true,
    },
    async ({ path, at }) => {
      const snapshot = await owner.open(path, at);
      return { text: describeSnapshot(snapshot, "Opened"), structured: { ...snapshot } };
    },
  );

  // [契约] next 为 null 是唯一的「读完」信号，不能用空文本判断，空文档与空分页都会误判。
  // head 必须带 revision：内容可能被外部改动，模型需要据此判断既有引用是否仍然有效。
  // 分页游标由 owner 生成，本层只透传，不要自己按字节切分，否则会和 owner 的分页边界冲突。
  // read_document：按定位符读取文本，长结果分页；next 为 null 表示已到末尾。
  register(
    "read_document",
    {
      description: `Read the content of a document or of one location in it as text: ${READ_FORMS}. Each block is prefixed with its location so you can cite or show it. Long results are paged: call again with the returned cursor.`,
      input: {
        anchor,
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Cursor from a previous result to continue reading."),
      },
      visibility: ["model"],
    },
    async ({ anchor: target, cursor }) => {
      const { info, at, page } = await owner.read(target, cursor ?? 0);
      const head = `${formatAnchor(info.path, at)} (${KIND_NAMES[info.kind]}, revision ${info.revision})`;
      const tail =
        page.next === null
          ? "[end]"
          : `[more: call read_document with anchor "${formatAnchor(info.path, at)}" and cursor ${page.next}]`;
      return {
        text: `${head}\n\n${page.text || "(no text)"}\n\n${tail}`,
        structured: { path: info.path, at, revision: info.revision, next: page.next },
      };
    },
  );

  // 无命中返回自然语言而非 OfficeError：搜不到是正常结果，抛错会让模型误以为文件损坏。
  // limit 默认 20、上限 100 与 schema 一致；structured 里补 anchor 便于 panel 直接渲染成可点击项。
  // search_document：大小写不敏感检索，返回命中定位符与片段；无命中时也正常返回而非报错。
  register(
    "search_document",
    {
      description:
        "Find text in a document (case-insensitive). Returns matching locations as anchors with a snippet each; pass them to read_document or show_in_viewer.",
      input: {
        path: z.string().min(1).max(1000).describe("Workspace-relative path of the file."),
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).optional(),
      },
      visibility: ["model"],
    },
    async ({ path, query, limit }) => {
      const { info, hits } = await owner.search(path, query, limit ?? 20);
      const text = hits.length
        ? [
            `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" in ${info.path}:`,
            ...hits.map((hit) => `- ${formatAnchor(info.path, hit.at)}  ${hit.snippet}`),
          ].join("\n")
        : `No matches for "${query}" in ${info.path}.`;
      return {
        text,
        structured: {
          path: info.path,
          hits: hits.map((hit) => ({ ...hit, anchor: formatAnchor(info.path, hit.at) })),
        },
      };
    },
  );

  // [契约] 同文档约束由 owner.show 校验，本层不要提前取首个 target 的路径自行判断。
  // quote 只在该定位符范围内高亮，跨段引用应拆成多个 target，而不是给一个很长的 quote。
  // note 只是 panel 旁的说明，不会重定向用户手动打开的窗口，description 里已明确这一点。
  // targets 上限 20 与 schema 对齐，超限直接拒绝而不是静默截断，截断会让用户漏看引用。
  // show_in_viewer：让 panel 滚动到首个目标并高亮全部目标；所有目标必须属于同一文档。
  register(
    "show_in_viewer",
    {
      description: `Point the user at specific places in a document: the ${TITLE} panel opens the document, scrolls to the first target and highlights all targets. Use it whenever your answer refers to a particular ${TARGET_NOUNS}. All anchors must be in the same document. \`quote\` highlights that exact text inside the location (best for ${QUOTE_BEST_FOR}).`,
      input: {
        targets: z
          .array(z.object({ anchor, quote: z.string().max(500).optional() }))
          .min(1)
          .max(20),
        note: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Optional short caption shown in the dedicated Agent panel next to the highlight; manual document windows are not retargeted.",
          ),
      },
      visibility: ["model"],
      panel: true,
      openPanel: true,
    },
    async ({ targets, note }) => {
      const snapshot = await owner.show(targets, note);
      return { text: describeSnapshot(snapshot, "Showing"), structured: { ...snapshot } };
    },
  );

  // [契约] 歧义时返回列表而非抛错：模型需要这份清单才能向用户反问，抛错会让它无从继续。
  // viewId 校验先于取视图，否则未知 id 会落到 owner.view 的默认分支，行为不可预测。
  // structured 里保留 ambiguous 标志，panel 与客户端据此决定是否弹出选择器。
  // get_view：读取用户当前视图；多个 viewer 且未指定 viewId 时返回歧义列表，让模型先问用户。
  // xlsx 选区额外附上文件存储值（含公式），弥补 panel 只显示计算结果的信息差。
  register(
    "get_view",
    {
      description: `See what the user is looking at in the ${TITLE} panel: the open document, the visible location and the user's current selection with its text. Call this when the user says "this", "here" or "the selected …" about a document.`,
      input: {
        viewId: z
          .string()
          .max(300)
          .optional()
          .describe("Viewer ID from a previous ambiguous get_view result."),
      },
      visibility: ["model"],
    },
    async ({ viewId }) => {
      const views = owner.views();
      // [失败路径] 不要改成「取最近更新的视图」：用户可能同时在两个文档里工作，猜错代价是整段回答引错。
      // 列表文案要求模型带上 viewId 重试，改这句话会直接削弱模型的下一步行为。
      // structured 必须带完整 views，缺字段时客户端无法渲染可选项，用户也就无从选择。
      if (!viewId && views.length > 1)
        return {
          text:
            "Multiple document viewers have reported views. Ask the user which document they mean, then call get_view with its viewId.\n" +
            views.map((view) => `${view.viewId}: ${view.path}`).join("\n"),
          structured: { ambiguous: true, views },
        };
      // [契约] 未知 viewId 抛 invalid_token 而不是回退：回退会让模型引用用户根本没在看的选区。
      // 错误文案给出补救路径（不带 viewId 重新列举），保持对模型可执行。
      // views 是快照，panel 可能刚好释放了视图，所以这是正常失败路径而非异常分支。
      if (viewId && !views.some((view) => view.viewId === viewId))
        throw new OfficeError(
          "invalid_token",
          "Unknown viewer. Call get_view without viewId to list viewers.",
        );
      const view = owner.view(viewId);
      const current = view.path ? await owner.info(view.path) : owner.current();
      if (!current && !view.path)
        return {
          text: `The ${TITLE} viewer has no document open. Use open_document to open one.`,
          structured: { view, document: null },
        };
      const path = view.path ?? current!.path;
      const lines = [`Open document: ${path}`];
      if (view.at) lines.push(`Visible location: ${formatAnchor(path, view.at)}`);
      if (view.selection) {
        lines.push(`User selection: ${formatAnchor(path, view.selection.at)}`);
        if (view.selection.text) lines.push(`Selected text: """${view.selection.text}"""`);
        if (view.kind === "xlsx") {
          // xlsx 选区必须补文件存储值：panel 只显示计算结果，模型看不到公式就会错误解释数字来源。
          // 读取失败时 catch 成 null 并跳过该段，不阻断整次 get_view：单元格可能刚好被清空或表格被删。
          // 4096 字节截断用于防止大范围选区的原始值撑爆上下文，不要改成按行截断。
          // The panel shows computed values; add what the file stores (values and formulas).
          const stored = await owner.read(formatAnchor(path, view.selection.at)).catch(() => null);
          if (stored)
            lines.push(
              "Selected cells as stored in the file:",
              truncateBytes(stored.page.text, 4096),
            );
        }
      } else lines.push("No selection.");
      if (view.updatedAt)
        lines.push(
          `(reported ${Math.max(0, Math.round((Date.now() - view.updatedAt) / 1000))} s ago)`,
        );
      if (current) lines.push("", describeDocument(current, 30));
      return { text: lines.join("\n"), structured: { view, document: current } };
    },
  );

  // [事务] 四个工具构成 begin 到 chunk 到 finish 的会话，缺任一步都会留下半成品文件。
  // [契约] visibility 固定为 app：导入必须由用户在 panel 显式选文件发起，模型不能自行触发。
  // readOnly 全为 false，宿主据此要求用户确认；改成默认只读会让写盘绕过审批。
  // cancel 是失败路径的收尾，不要在 chunk 失败时自动 cancel，是否重试应由调用方决定。
  // 导入相关工具仅在挂载 importer 时注册；它们只对 panel 可见，模型不能直接调用。
  if (importer) {
    register(
      "begin_file_import",
      {
        description:
          "Begin importing a file explicitly selected by the user into a workspace copy.",
        input: {
          name: z.string().min(1).max(255),
          size: z.number().int().min(1).max(MAX_FILE_BYTES),
        },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ name, size }) => ({
        text: "Import started",
        structured: { id: await importer.begin(name, size) },
      }),
    );
    // [契约] offset 由调用方按上一块长度累加，owner 侧会校验连续性，本层不做重排或补齐。
    // 长度上限按 base64 的 4/3 膨胀向上取整换算，改公式会让合法分块被 schema 直接拒绝。
    // 正则拒绝非法 base64 字符，避免 Buffer 解码静默丢字节，最终表现为文件损坏却无报错。
    // write_file_import：按 offset 追加 base64 分块；数据长度上限与 FILE_CHUNK_BYTES 对齐。
    register(
      "write_file_import",
      {
        description: "Append a selected file chunk at its expected offset.",
        input: {
          id: z.string().uuid(),
          offset: z.number().int().min(0),
          data: z
            .string()
            .max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id, offset, data }) => {
        await importer.chunk(id, offset, Buffer.from(data, "base64"));
        return { text: "Chunk imported" };
      },
    );
    // 只有 finish 才确认完整并产出路径：chunk 阶段写的是临时文件，提前返回路径会让用户打开空文件。
    // 调用方拿到路径后仍需自行 open，本层不做隐式打开，否则会凭空改变 panel 的当前文档。
    // finish_file_import：校验字节完整后返回工作区内的副本路径。
    register(
      "finish_file_import",
      {
        description: "Finish a selected file import and return the workspace copy path.",
        input: { id: z.string().uuid() },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id }) => ({
        text: "Import complete",
        structured: { path: await importer.finish(id) },
      }),
    );
    // [资源] 取消必须真正关句柄并删临时文件，否则长会话会累积 fd 与磁盘垃圾。
    // 重复取消应保持幂等，幂等性由 importer 保证，本层不要自建状态表来判断。
    // cancel_file_import：清理未完成的导入，释放写入句柄。
    register(
      "cancel_file_import",
      {
        description: "Remove an incomplete file import.",
        input: { id: z.string().uuid() },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id }) => {
        await importer.cancel(id);
        return { text: "Import cancelled" };
      },
    );
  }

  // 以下工具只对 panel 开放，用于文件选择、渲染、变更轮询与视图上报。
  // Panel-only tools.

  // 只对 panel 可见：模型不需要全量列举，开放会浪费上下文并放大越权读取面。
  // limit 默认 500 是选择器体验参数，不影响 owner 的排序语义。
  // 返回数量与列表同时给出，便于客户端提示「仅显示前 N 项」。
  // list_documents：枚举工作区文档，供 panel 的文件选择器展示。
  register(
    "list_documents",
    {
      description: `List ${FILES_NOUN} in the workspace for the viewer's file picker.`,
      input: { limit: z.number().int().min(1).max(1000).optional() },
      visibility: ["app"],
    },
    async ({ limit }) => {
      const documents = await owner.list(limit ?? 500);
      return { text: `${documents.length} documents`, structured: { documents } };
    },
  );

  // [契约] 这里只发句柄不发字节：原始字节走 file 资源分块，避免工具响应被二进制内容撑爆。
  // 摘要上限 10 对比模型侧的 60，panel 只展示少量条目，不要随手改成同一默认值。
  // 句柄由 owner 持有并有生命周期，本层不要缓存 loaded 结果，否则会读到过期的字节来源。
  // load_document：返回文档信息与分块句柄，panel 据此按块拉取原始字节渲染。
  register(
    "load_document",
    {
      description:
        "Load a document for rendering in the viewer: returns its info and a handle to read the bytes.",
      input: { path: z.string().min(1).max(1000) },
      visibility: ["app"],
    },
    async ({ path }) => {
      const loaded = await owner.load(path);
      return { text: describeDocument(loaded.info, 10), structured: { ...loaded } };
    },
  );

  // 只回 revision 不回正文：轮询频率高，返回内容会成倍放大 IO 与传输成本。
  // revision 由 owner 依据文件状态计算，本层不要用时间戳或文件大小自行伪造。
  // check_document：只返回 revision，供 panel 轮询判断磁盘文件是否变化。
  register(
    "check_document",
    {
      description:
        "Return a document's current revision so the viewer can tell when the file changed on disk.",
      input: { path: z.string().min(1).max(1000) },
      visibility: ["app"],
    },
    async ({ path }) => {
      const info = await owner.info(path);
      return { text: info.revision, structured: { path: info.path, revision: info.revision } };
    },
  );

  // 方向与 get_view 相反：这里读「应展示什么」，get_view 读「用户实际在看什么」，不要合并。
  // 快照是 owner 的唯一真源，本层不做合并或补全，补全会让 panel 与实际状态悄悄分叉。
  // get_viewer：返回 panel 应展示的文档与揭示指令（由 agent 或用户设置）。
  register(
    "get_viewer",
    {
      description: "Return the document the viewer should show (set by the agent or the user).",
      input: {},
      visibility: ["app"],
    },
    async () => {
      const snapshot = owner.snapshot();
      return { text: describeSnapshot(snapshot, "Viewer has"), structured: { ...snapshot } };
    },
  );

  // [契约] null 与 undefined 语义不同：null 表示显式清空，undefined 表示本次不改动。
  // path 必填，防止 panel 在文档关闭后上报孤儿视图，污染后续 get_view 的结果。
  // selection.text 上限 20000 用于控制传输体积，这段文本会直接进入模型上下文。
  // report_view：记录用户当前位置与选区；path 必填，at 与 selection 可为 null 表示清空。
  register(
    "report_view",
    {
      description: "Record the user's current location and selection in the viewer.",
      input: {
        viewId: z.string().min(1).max(300).optional(),
        path: z.string().min(1).max(1000),
        at: z.string().max(300).nullable().optional(),
        selection: z
          .object({ at: z.string().min(1).max(300), text: z.string().max(20000) })
          .nullable()
          .optional(),
      },
      visibility: ["app"],
      readOnly: false,
    },
    async (input) => {
      const view = await owner.report(input);
      return { text: "ok", structured: { view } };
    },
  );

  // [资源] 卸载即释放：残留视图会让模型引用一个已经关闭的窗口，用户却无法核对。
  // 释放是正常路径，不抛错也不重试，页面离开时失败不应中断卸载流程。
  // release_view：panel 卸载时释放上报，避免 get_view 看到已失效的视图。
  register(
    "release_view",
    {
      description: "Release a viewer report when its page leaves.",
      input: { viewId: z.string().min(1).max(300) },
      visibility: ["app"],
      readOnly: false,
    },
    async ({ viewId }) => {
      owner.releaseView(viewId);
      return { text: "ok" };
    },
  );

  // 资源：panel 页面、静态资源与文件分块；三者都通过 ui:// 前缀由宿主转发。
  // Resources: the panel, its assets and file chunks.

  // [权衡] CSP 放宽是 pdf.js 的硬需求，只放开 wasm 与 eval，不要在此追加通配来源。
  // 元数据必须同时挂资源级与 contents 级：部分宿主只读其中一处，漏挂会让策略整体丢失。
  // panel.html 每次请求都读盘，热更新面板无需重启进程，不要把内容提成模块级缓存。
  // panel 页面允许 wasm 与 eval，pdf.js 渲染需要；元数据同时写在资源与内容上。
  const panelMeta = { "zcode/csp": { wasmUnsafeEval: true } };
  server.registerResource(
    "panel",
    PANEL_URI,
    { mimeType: HTML_MIME, _meta: panelMeta },
    async () => ({
      contents: [
        {
          uri: PANEL_URI,
          mimeType: HTML_MIME,
          text: await readFile(join(assetRoot, "panel.html"), "utf8"),
          _meta: panelMeta,
        },
      ],
    }),
  );

  // [失败路径] 校验必须先于路径拼接：先 join 再校验时，路径归一化可能已经跳出 assetRoot。
  // 未知资源抛 invalid_resource 而不是返回空内容，宿主据此区分「缺资源」与「传输失败」。
  // 文本类按扩展名给 MIME，字体与 wasm 走 base64，扩展名判断要精确匹配而非模糊包含。
  // 白名单集中在 assets.ts，新增资源类型改那里，不要在这个回调里追加正则。
  // 静态资源：名字经 isAssetName 白名单校验后才拼接路径，防止目录穿越。
  // 文本类资源按扩展名给 MIME；其余（字体、wasm 等）以 base64 blob 返回。
  server.registerResource(
    "assets",
    new ResourceTemplate(`${ASSET_PREFIX}{+name}`, { list: undefined }),
    {},
    async (uri) => {
      const name = decodeURIComponent(uri.href.slice(ASSET_PREFIX.length));
      if (!isAssetName(name))
        throw new OfficeError("invalid_resource", `Unknown UI asset: ${name}`);
      const path = join(assetRoot, name);
      if (/\.(txt|css|json|js)$/.test(name)) {
        const mimeType = name.endsWith(".json")
          ? "application/json"
          : name.endsWith(".css")
            ? "text/css"
            : "text/plain";
        return { contents: [{ uri: uri.href, mimeType, text: await readFile(path, "utf8") }] };
      }
      const bytes = await readFile(path);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/octet-stream", blob: bytes.toString("base64") },
        ],
      };
    },
  );

  // [契约] index 来自 URI 模板，必须先转成数字，字符串直接下传会让越界判断失效。
  // token 失效属于正常过期路径，由 owner 抛领域错误，本层不缓存也不重试。
  // 分块同步返回字符串，是资源回调签名要求的；改成异步读取会打乱 panel 的拼装顺序。
  // 不要在此校验 token 格式，格式与有效期都归 owner 管，重复校验只会让两处规则漂移。
  // 文件分块：token 由 owner.load 分配，index 越界或 token 失效时由 owner.chunk 抛出 OfficeError。
  server.registerResource(
    "file",
    new ResourceTemplate(`${FILE_PREFIX}{token}/{index}`, { list: undefined }),
    {},
    async (uri, { token, index }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/octet-stream",
          blob: owner.chunk(String(token), Number(index)),
        },
      ],
    }),
  );

  return server;
}
