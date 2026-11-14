// 工作流快照采集：把会话里的 workflow 运行（事件日志、产物元数据、产物字节）
// 折叠成两个可分享的产物——一张合成的 assistantText 摘要行 + 一份 workflow content block。
// 存在的理由：workflow 的 UI 卡片依赖本地运行态，公开页无法重放，只能把定稿后的结果序列化进去。
// INV-01：所有读取都必须在原 workspace/session authority 下进行，禁止按 sourcePath 猜文件（守住它：统一用 ...input 透传）。
// INV-02：事件必须按 sequence 严格递增消费，出现乱序或空洞即判快照不完整（守住它：事件循环里的 sequence 检查）。
// INV-03：预算（max_artifact_bytes / max_total_artifact_bytes / max_artifact_count）只在字节真正登记时扣减，失败项不得残留占用（守住它：resource 提交块）。
// INV-04：单个产物的 spec/字节异常只降级该产物为 unavailable，不抹掉其它已采集内容（守住它：内层 try/catch）。
// 改错后果：分享出半截工作流（模型看到一个声称成功但产物缺失的运行），或预算被失败项吃掉导致后续产物全被拒。
// [权衡] 合成一行 assistantText 而不是新增 row kind：老客户端不认识新 kind，会把整轮丢掉；
// 复用既有 kind 并加 entityId 前缀，老客户端至少能看到文字摘要（isWorkflowShareFallbackRow 就是为此）。
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import {
  shareWorkflowRunSchema,
  shareWorkflowPayloadSchema,
  shareArtifactSpecSchemas,
  type ShareWorkflowPayload,
  type ShareWorkflowArtifact,
  type ConversationShareCapabilities,
} from "@zcode/shared";
import {
  reduceWorkflowRunsState,
  type ConversationRow,
  type ArtifactRow,
  type WorkflowRunsState,
  type ToolCallCreateWorkflowCausalityGraph,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { PublishTextConversationInput } from "./conversationShare.js";

// 只声明需要的五个只读方法，便于在 connection scope 里替换成可信 Agent 的同一批方法。
export type ShareWorkflowReader = Pick<
  IZCodeAgentService,
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
>;
// draft 是 content block 的中间形态：productTurnId 尚未映射成公开 ID，
// resourceId 也还是本地占位，真正的 ID 映射发生在公开投影阶段。
export interface ShareContentDraft {
  version?: 1 | 2;
  entityId: string;
  productTurnId: string;
  capturedAt: number;
  payload: ShareWorkflowPayload;
}
// 一个 Source 对应「一次要采集的运行」，可能来自 turnHeader（通知/启动）
// 或 toolCall（create/resume）；completion 表示这次运行在会话里已看到终态。
interface Source {
  row: ConversationRow;
  runId?: string;
  name: string;
  graph?: ToolCallCreateWorkflowCausalityGraph;
  completion: boolean;
  summary?: string;
  duration?: number;
}
// 事件上限是防御性的：事件日志理论上无限，读到超过 2 万条说明这不是可分享的规模，
// 继续读会长时间占住 RPC 并可能把 Host 内存打满。
// CHUNK_SIZE 与 PAGE_SIZE 分别对应「字节分块」与「条目分页」两种 RPC 限制，不能混用。
const MAX_EVENTS = 20000;
const PAGE_SIZE = 200;
const CHUNK_SIZE = 512 * 1024;
const WORKFLOW_FALLBACK_PREFIX = "workflow-share-fallback-";

/** 合成摘要只用于展示，不能把产物标题再解释为工作区文件引用。 */
// 合成摘要行的识别靠 entityId 前缀，而不是额外字段：Row 类型是跨版本协议，
// 加字段需要服务端协同；前缀只在本模块内约定，改动代价最低。
// 下游用它把合成行排除在「预览卡片发现」之外，避免把摘要里的产物标题当成文件引用。
export function isWorkflowShareFallbackRow(row: ConversationRow): boolean {
  return (
    row.kind === "assistantText" && Boolean(row.entityId?.startsWith(WORKFLOW_FALLBACK_PREFIX))
  );
}

// 按目标 schema 的键做白名单投影：运行态对象里有大量本地字段（句柄、路径），
// 直接展开会把它们带进公开载荷。undefined 键必须剔除，否则 schema 会因「显式 undefined」拒绝。
function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => keys.includes(key) && entry !== undefined),
  );
}

/** 发布/预检共用。所有读取在原 workspace/session authority 下进行，不按 sourcePath 猜文件。 */
// 预检与发布共用：preflight=true 时只做元数据预算判断，不下载产物字节，
// 避免用户仅仅是打开分享面板就触发大量远端传输。
// allRows 与 rows 分开：rows 是已选轮次（用于产出），allRows 是全量（用于补齐图关系），
// 因为 causalityGraph 可能记在未选中的 Create 行上。
export async function collectConversationShareWorkflowSnapshot(options: {
  agent: ShareWorkflowReader;
  input: Pick<
    PublishTextConversationInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >;
  rows: ConversationRow[];
  allRows: readonly ConversationRow[];
  capabilities: ConversationShareCapabilities;
  capturedAt: number;
  preflight?: boolean;
}): Promise<{
  rows: ConversationRow[];
  drafts: ShareContentDraft[];
  bytes: Map<string, Uint8Array>;
}> {
  const { agent, input, capabilities } = options;
// 只挑四类入口：带 workflowLaunch/backgroundSource 的 turnHeader，
// 以及 create_workflow / resume_workflow_run 两种 toolCall。
// 其余行不可能携带 `workflowLaunch` 或 `backgroundSource` 运行身份，提前过滤能让后续每步少一层判断。
  const candidates = options.rows.filter(
    (row) =>
      (row.kind === "turnHeader" &&
        (row.workflowLaunch || row.originMeta?.backgroundSource === "workflow")) ||
      (row.kind === "toolCall" &&
        (row.display?.kind === "create_workflow" || row.display?.kind === "resume_workflow_run")),
  );
// 常见路径提前返回：没有任何 workflow 时不做任何 RPC，
// 这对普通会话是零成本，也是本模块能被无条件调用的前提。
  if (candidates.length === 0) return { rows: options.rows, drafts: [], bytes: new Map() };
  // 目录仅辅助 Create 行关联；通知/启动/Resume 的明确 runId 不受最近目录窗口限制。
// [失败路径] 运行目录查询失败时退化为空列表而不是抛错：目录只是「辅助关联」，
// 通知类与显式 runId 的入口不依赖它，不能因为一次辅助查询失败就毁掉整次分享。
// limit 64 是经验值：单会话同时活跃的工作流远超这个数并不现实，
// 截断只会让最早的历史运行失去自动关联，仍可由显式 runId 找回。
  const directory = await Promise.resolve()
    .then(() => agent.conversationWorkflowRunsV4({ ...input, limit: 64 }))
    .catch(() => ({ runs: [] }));
// seen 以 productTurnId + runId 去重：同一个运行可能同时被 turnHeader 与 toolCall 命中，
// 重复采集会产生两份 draft 与两份 artifact 行。
  const sources: Source[] = [];
  const seen = new Set<string>();
// 每个候选先解析成 Source（身份 + 展示信息），身份解析失败的行在后面统一跳过。
  for (const row of candidates) {
    let source: Source | undefined;
// turnHeader 来源：运行身份可能在 workflowLaunch.runId，也可能只在 originMeta.workId，
// 名称同理有三层回退；终态判断只看 workflowNotification 的 terminal 状态。
    if (row.kind === "turnHeader") {
      const launch = row.workflowLaunch;
      const meta = row.originMeta;
      const notification = meta?.workflowNotification;
      source = {
        row,
        runId: launch?.runId ?? meta?.workId,
        name: launch?.name ?? meta?.title ?? "Workflow",
        completion: notification?.kind === "terminal" && notification.status === "completed",
        ...(notification?.kind === "terminal"
          ? { summary: (notification.error ?? notification.summary).slice(0, 2048) }
          : {}),
        ...(launch?.display?.causalityGraph ? { graph: launch.display.causalityGraph } : {}),
        ...(notification?.kind === "terminal" && notification.durationMs !== undefined
          ? { duration: Math.floor(notification.durationMs) }
          : {}),
      };
// toolCall 来源：runId 优先取 resume_workflow_run 自带的，其次用工具调用 id 反查目录。
// 名称优先取工具入参 name，其次目录 label——入参是用户当次输入，最能代表意图。
    } else if (row.kind === "toolCall") {
      const entry = directory.runs.find((run) => run.toolCallId === row.toolCallId);
      // 编译失败且未产生 run 时只有工具诊断，不能凭空补一张 unavailable 运行卡。
// 编译失败且未产生 run 的 Create 行只有工具诊断，没有可分享内容：
// 若仍生成一张 unavailable 卡片，会把本地失败当成分享内容展示给接收者。
      if (!entry && row.display?.kind === "create_workflow" && !row.display.ok) continue;
      const name =
        typeof row.input === "object" &&
        row.input &&
        "name" in row.input &&
        typeof row.input.name === "string"
          ? row.input.name
          : (entry?.label ?? "Workflow");
      source = {
        row,
        name,
        completion: false,
        runId: row.display?.kind === "resume_workflow_run" ? row.display.runId : entry?.runId,
        ...(row.display?.kind === "create_workflow" && row.display.causalityGraph
          ? { graph: row.display.causalityGraph }
          : {}),
      };
    }
// 没有 productTurnId 就无法把内容挂到某一轮，公开投影会直接拒绝；
// 这里先跳过，避免把它带到后面才失败。
    if (!source || !row.productTurnId) continue;
// 无 runId 时用 rowId 兜底，保证同一行重复出现时仍能去重，同时不与有 runId 的条目互撞。
    const key = `${row.productTurnId}:${source.runId ?? row.rowId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = directory.runs.find((run) => run.runId === source.runId);
    const origin = options.allRows.find(
      (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === entry?.toolCallId,
    );
    if (!source.graph && origin?.kind === "toolCall" && origin.display?.kind === "create_workflow")
      source.graph = origin.display.causalityGraph;
    sources.push(source);
  }
// 三个累加器分开维护：bytes 供上传按 resourceId 取，artifactRows 供插入会话，
// drafts 供 content block。它们必须同步增长，否则投影会出现「有块无行」或「有行无字节」。
// totalResourceBytes / resourceCounter 是预算账本，只在提交成功时推进。
  const bytes = new Map<string, Uint8Array>();
  const artifactRows: ArtifactRow[] = [];
  const drafts: ShareContentDraft[] = [];
  const tails = new Map<string, ConversationRow[]>();
  const cache = new Map<string, ShareWorkflowPayload>();
// 新行从现有最大 rowId 起增，保持全局 rowId 严格递增；
// 插入阶段会把这些行按 productTurnId 分组塞到该轮末尾，序号必须已经大于原有行。
// [权衡] 用 ...spread 求最大值在超大会话上有参数数量风险，但 rows 已按 RPC 上限分页过，
// 实际长度有界；改成 reduce 会多一次遍历，收益不大。
  let nextRow = Math.max(0, ...options.rows.map((row) => row.rowId));
  let resourceCounter = 0;
  let totalResourceBytes = 0;

// 逐运行采集，串行执行：同一 run 的事件与产物读取本就有序依赖，并行只会让日志更难读。
  for (const source of sources) {
    const producer = source.row;
    const productTurnId = producer.productTurnId!;
// 先构造「外壳」payload（名称/完成态/摘要/图/时长），运行详情随后填充；
// 外壳字段在缓存命中时也要保留，因为它们来自通知行而不是运行日志。
// name 截断到 512 是服务端字段长度约束，空名回退为 Workflow 保证必填字段非空。
    let payload: ShareWorkflowPayload = {
      name: source.name.slice(0, 512) || "Workflow",
      completion: source.completion,
      ...(source.summary ? { summary: source.summary } : {}),
      artifacts: [],
      ...(source.graph ? { graph: source.graph } : {}),
      ...(source.duration === undefined ? {} : { duration_ms: source.duration }),
    };
    try {
      if (!source.runId) throw new Error("Missing workflow identity");
// 同一 runId 可能在多轮各出现一次（例如先启动、后收到终态通知）；
// 运行日志只读一次，后续命中缓存，只把「这一行更新鲜的外壳字段」覆盖上去。
// [权衡] 缓存的是完整 payload 而不是事件状态：重复折叠事件成本高，且结果与顺序强相关，
// 缓存结果比缓存中间态更不容易出错。
      const cached = cache.get(source.runId);
      if (cached)
        payload = {
          ...cached,
          completion: source.completion,
          name: payload.name,
          ...(source.summary ? { summary: source.summary } : {}),
          ...(source.graph ? { graph: source.graph } : {}),
          ...(source.duration === undefined ? {} : { duration_ms: source.duration }),
        };
      else {
        // RPC 受条数和字节双重分页限制；读到末页后才得到可重放的完整前缀。
// 事件分页用 afterSequence 游标推进；sequence 从 -1 开始表示「尚未读到任何事件」。
// eventCount 独立累计，因为每页可能返回 0 条但 hasMore=true，只靠页数无法感知空转。
        let state: WorkflowRunsState | undefined;
        let sequence = -1;
        let eventCount = 0;
        for (;;) {
          const page = await agent.conversationWorkflowRunEventsV4({
            ...input,
            runId: source.runId,
            ...(sequence < 0 ? {} : { afterSequence: sequence }),
          });
// [失败路径] 两种判死条件：超过事件上限，或「空页但仍声称有更多 / 一页都没拿到」。
// 后者是服务端游标异常的信号，继续循环会变成无退出的忙等。
          eventCount += page.events.length;
          if (
            eventCount > MAX_EVENTS ||
            (!page.events.length && (page.hasMore || eventCount === 0))
          )
            throw new Error("Incomplete workflow snapshot");
// sequence 必须严格递增：等于或小于上一个 sequence 都说明日志乱序或重复，
// 折叠进 reducer 会得出与真实运行不同的状态，且无法事后察觉。
// reducer 返回 undefined 时保留旧状态（用于该类型事件不改变状态的情况）。
          for (const event of page.events) {
            if (event.sequence <= sequence) throw new Error("Unordered workflow journal");
            sequence = event.sequence;
            state =
              reduceWorkflowRunsState(state, {
                runId: source.runId,
                eventType: event.type,
                sequence: event.sequence,
                payload: event.payload,
              }) ?? state;
          }
          if (!page.hasMore) break;
        }
// 拿不到运行状态说明日志不完整；这里抛错由外层把整条 source 标为 unavailable，
// 而不是产出一个字段全空的运行卡片。
        const run = state?.runs[0];
        if (!run) throw new Error("Missing workflow state");
        if (!payload.summary && run.error) payload.summary = run.error.slice(0, 2048);
// 运行态对象含本地字段，必须按 schema 的键逐层 pick 后重建；
// actors/nodes 是数组，需用各自的 element.shape 再做一层投影。
// 直接 spread run 会在服务端被未知字段拒绝（schema 非 strip 模式）。
        payload.run = shareWorkflowRunSchema.parse({
          ...pick(run, Object.keys(shareWorkflowRunSchema.shape)),
          actors: run.actors.map((actor) =>
            pick(actor, Object.keys(shareWorkflowRunSchema.shape.actors.element.shape)),
          ),
          nodes: run.nodes.map((node) =>
            pick(node, Object.keys(shareWorkflowRunSchema.shape.nodes.element.shape)),
          ),
        });
// 元数据与事件日志是两次独立读取：前者给 title/description/contentType/sourcePath，
// 后者给产物列表与版本号，二者用 id 对齐；缺失时用事件里的 title 兜底。
        const metadata = await agent.conversationWorkflowRunArtifactsV4({
          ...input,
          runId: source.runId,
        });
// 逐产物处理，每个产物有独立的失败域：一个产物坏掉只影响它自己，
// 因此下面的解析/下载都包在内层 try 里，catch 只往 payload.artifacts 追一条 unavailable。
// version 缺失视为「元数据与事件不一致」，同样走降级而不是中断整轮。
        for (const summary of run.artifacts ?? []) {
          const record = metadata.artifacts.find((artifact) => artifact.id === summary.id);
          const version = record?.versions.find(
            (candidate) => candidate.version === summary.version,
          );
          const base = {
            id: summary.id,
            kind: summary.kind,
            title: version?.title ?? summary.title ?? summary.id,
            version: summary.version,
            ...(summary.primary ? { primary: true as const } : {}),
            ...(version?.description ? { description: version.description } : {}),
          };
          let artifact: ShareWorkflowArtifact;
          let resource: { id: string; data: Uint8Array; row: ArtifactRow } | undefined;
          try {
            if (!version) throw new Error("Missing artifact version");
// 文件/文本类产物按字节上传；mime 优先取版本元数据，markdown 缺省 text/markdown。
// 扩展名优先取源路径后缀，其次按 kind 推断，不靠 title（title 里的版本号不是文件类型）。
            if (base.kind === "file" || base.kind === "markdown") {
              const mime =
                version.contentType ??
                (base.kind === "markdown" ? "text/markdown" : "application/octet-stream");
              const extension =
                extname(version.sourcePath ?? "").slice(1) ||
                (base.kind === "markdown" ? "md" : "");
              const allowed = capabilities.allowed_artifacts.find(
                (entry) =>
                  entry.mime_types.includes(mime) &&
                  entry.extensions.some((ext) => ext.replace(/^\./u, "") === extension),
              );
// 不在能力清单里的类型直接标 unsupported 并跳过：这不是错误，而是服务端明确不支持，
// 继续读字节只会白白消耗带宽。
              if (!allowed) {
                payload.artifacts.push({ ...base, kind: base.kind, unavailable: "unsupported" });
                continue;
              }
// 预算是「剩余总额度」而非「单个上限」：三个条件任一不满足都标 limit_exceeded，
// 且必须用 Math.min(单文件上限, 剩余额度) 判断，否则单文件合规但总额会超。
// 注意此处只判断不扣减；真正扣减在字节成功登记时，避免失败项虚占额度。
              const remainingBytes = capabilities.max_total_artifact_bytes - totalResourceBytes;
              if (
                resourceCounter >= capabilities.max_artifact_count ||
                remainingBytes <= 0 ||
                (version.bytes ?? 0) > Math.min(capabilities.max_artifact_bytes, remainingBytes)
              ) {
                payload.artifacts.push({ ...base, kind: base.kind, unavailable: "limit_exceeded" });
                continue;
              }
              // 预检只检查元数据预算；文件物化与完整性校验留到发布，避免远程重复传输。
// 预检只按声明的 size 记账并写 manifest，不读字节：用户点开分享面板时不该触发大文件传输。
// 先推进 `preflight` 的预算账本，同一批次里后续产物看到一致的剩余额度。
              if (options.preflight) {
                const declaredBytes = version.bytes ?? 0;
                payload.artifacts.push({
                  ...base,
                  kind: base.kind,
                  bytes: declaredBytes,
                  content_type: mime,
                });
                totalResourceBytes += declaredBytes;
                resourceCounter += 1;
                continue;
              }
// 按 nextOffset 游标循环读，直到服务端返回 null 表示结束；
// 每次都要校验：总长不超预算、不越界、非空块、游标必须连续前进。
              const chunks: Uint8Array[] = [];
              let offset = 0;
              for (;;) {
                const part = await agent.conversationWorkflowRunArtifactReadV4({
                  ...input,
                  runId: source.runId,
                  artifactId: summary.id,
                  version: summary.version,
                  offset,
                  limit: CHUNK_SIZE,
                });
                const data = Buffer.from(part.dataBase64, "base64");
                if (part.totalBytes > Math.min(capabilities.max_artifact_bytes, remainingBytes))
                  throw new RangeError("Artifact size limit");
                if (offset + data.length > part.totalBytes || !data.length)
                  throw new Error("Invalid artifact bytes");
                chunks.push(data);
                offset += data.length;
                if (part.nextOffset === null) {
                  if (offset !== part.totalBytes) throw new Error("Incomplete artifact bytes");
                  break;
                }
                if (part.nextOffset !== offset) throw new Error("Invalid artifact cursor");
              }
// 此时长度已由上面的校验保证等于 totalBytes；concat 只做一次汇总复制。
              const data = Buffer.concat(chunks);
              const resourceId = `workflow-resource-${resourceCounter + 1}`;
              // 标题中的版本号不是文件类型；仅已有正确后缀时不再重复追加。
              const title = basename(base.title).replace(/[\\/]/gu, "_") || "artifact";
              const name = title.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
                ? title
                : `${title}.${extension}`;
// 为产物造一条正式的 artifact Row：公开投影只认这种行，后续 manifest 也由它派生。
// displayName 里的目录分隔符被替换成下划线，防止导入端把它当路径拼接。
// sha256 在采集当场算定，与上传字节同源，供导入端做完整性校验。
              const row: ArtifactRow = {
                rowId: nextRow + 1,
                turnId: producer.turnId,
                productTurnId,
                createdAt: options.capturedAt,
                createdAtSeq: nextRow + 1,
                kind: "artifact",
                artifactVersionId: resourceId,
                logicalArtifactKey: resourceId,
                displayName: name,
                artifactType: allowed.type,
                mimeType: mime,
                sizeBytes: data.length,
                sha256: createHash("sha256").update(data).digest("hex"),
                ref: resourceId,
                state: "current",
              };
              resource = { id: resourceId, data, row };
              artifact = {
                ...base,
                kind: base.kind,
                resource_id: resourceId,
                content_type: mime,
                ...((capabilities.content_block_versions?.workflow ?? 0) >= 2 &&
                (mime === "text/markdown" || mime === "text/plain") &&
                data.length <= 65536
                  ? {
                      preview_text: new TextDecoder("utf-8", {
                        fatal: true,
                        ignoreBOM: true,
                      }).decode(data),
                    }
                  : {}),
                bytes: data.length,
              };
            } else {
              const kind = base.kind;
// 非文件类产物（表格/清单等结构化结果）不走字节通道，而是把 spec 与条目序列化进 payload。
// 条目分页有 256 条上限：超过说明这不是给模型看的摘要级数据，硬塞会让 payload 超限。
// 只收集 sequence <= 事件日志末位序号的条目，保证「产物内容」与「运行终态」是同一时刻的快照。
              const spec = shareArtifactSpecSchemas[kind].parse(version.spec);
              const items = [];
              let afterSequence: number | undefined;
              for (;;) {
                const page = await agent.conversationWorkflowRunArtifactDataV4({
                  ...input,
                  runId: source.runId,
                  artifactId: summary.id,
                  limit: PAGE_SIZE,
                  ...(afterSequence === undefined ? {} : { afterSequence }),
                });
                for (const entry of page.items) {
                  if (entry.sequence <= (afterSequence ?? -1))
                    throw new Error("Invalid artifact item cursor");
                  afterSequence = entry.sequence;
                  if (entry.sequence <= sequence) items.push(entry);
                }
                if (items.length > 256) throw new Error("Artifact item limit");
                if (!page.hasMore || (afterSequence ?? -1) >= sequence) break;
                if (!page.items.length) throw new Error("Incomplete artifact items");
              }
              artifact = { ...base, kind, spec, items };
            }
            // 单个产物的坏 spec/条目只降级自己，不抹掉已经成功采集的其它内容。
// [失败路径] 组装完再整体过一遍 schema：字段级校验分散在各分支时容易漏，
// 一次 parse 能同时兜住「缺字段」与「多余字段」两类错误，且失败只影响该产物。
// 必须在登记字节之前校验，否则失败产物会留下无法回收的预算占用。
            const checked = shareWorkflowPayloadSchema.shape.artifacts.element.parse(artifact);
            // 解码或 schema 校验失败时不能残留附件、字节或预算；通过后一次登记。
// 四个账本一次性提交：字节、行、总字节、计数、下一个 rowId。
// 只有走到这里才说明该产物完整通过了解码与 schema，前面的失败分支都不会留下痕迹。
            if (resource) {
              bytes.set(resource.id, resource.data);
              artifactRows.push(resource.row);
              totalResourceBytes += resource.data.length;
              resourceCounter += 1;
              nextRow += 1;
            }
            payload.artifacts.push(checked);
          } catch (error) {
            payload.artifacts.push({
              ...base,
              kind: base.kind,
              unavailable: error instanceof RangeError ? "limit_exceeded" : "source_unavailable",
            });
          }
        }
// 缓存写在产物处理之后：后续同 runId 的行直接复用，不再重复读事件与元数据。
        cache.set(source.runId, payload);
      }
    } catch {
// 外层 catch 覆盖「身份缺失、事件不完整、运行态缺失」等整轮级失败：
// 保留 name 等外壳字段，只标 unavailable，让接收者看到「有这个运行但内容不可用」。
      payload.unavailable = "source_unavailable";
    }
// 合成行需要一个稳定且可识别的 entityId：前缀 + 递增序号，
// 序号用 drafts.length 而不是全局计数，保证同一次采集内不重复且从 1 开始。
// 它同时是 content block 的 fallback 锚点，投影阶段靠它找到对应行。
    const entityId = `${WORKFLOW_FALLBACK_PREFIX}${drafts.length + 1}`;
// 摘要文本是纯展示用：运行状态、阶段名、参与者、产物标题各自成段，
// 缺字段就自然省略，不做「暂无」之类的填充，保持老客户端也能读懂。
    const status = payload.run?.status ?? "unavailable";
    const summary = [
      payload.name,
      `Workflow · ${status}`,
      ...(payload.summary ? [payload.summary] : []),
      ...(payload.run?.phases?.map((phase) => phase.name) ?? []),
      ...(payload.run?.actors.map((actor) => actor.name ?? actor.siteId) ?? []),
      ...payload.artifacts.map(
        (artifact) => `${artifact.title}${artifact.unavailable ? " (未包含 / not included)" : ""}`,
      ),
      ...(payload.unavailable ? ["Workflow snapshot unavailable / 工作流快照不可用"] : []),
    ].join("\n\n");
// tail 按 productTurnId 暂存，等最后统一插到该轮末尾；
// 不能边遍历边插入，否则会边构造边修改正在遍历的数组。
    const tail = tails.get(productTurnId) ?? [];
    tail.push({
      rowId: ++nextRow,
      entityId,
      turnId: producer.turnId,
      productTurnId,
      createdAt: options.capturedAt,
      createdAtSeq: nextRow,
      kind: "assistantText",
      state: "complete",
      text: summary,
    });
    tails.set(productTurnId, tail);
// version 由服务端能力决定：支持 workflow v2 content block 时写 2，否则写 1。
// 这决定 payload 里能否带 preview_text 等新字段，写错会被服务端按版本拒绝。
    drafts.push({
      version: (capabilities.content_block_versions?.workflow ?? 0) >= 2 ? 2 : 1,
      entityId,
      productTurnId,
      capturedAt: options.capturedAt,
      payload,
    });
  }
// 组装输出：去掉 workflowLaunch 的用户输入行（它只是启动指令，没有分享价值），
// 并在每轮最后一行之后插入该轮的摘要行与产物行，保持「行属于其轮」的局部性。
  const rows: ConversationRow[] = [];
// 判定「本轮最后一行」用下一行的 productTurnId 与当前不同，而不是预扫索引表：
// 单次线性扫描即可，且对相邻同轮行天然正确。
// 只在该行有 productTurnId 时才插入，无身份的行不归属任何轮。
  for (const [index, row] of options.rows.entries()) {
    if (!(row.kind === "userInput" && row.origin === "workflowLaunch")) rows.push(row);
    if (row.productTurnId !== options.rows[index + 1]?.productTurnId && row.productTurnId)
      rows.push(
        ...(tails.get(row.productTurnId) ?? []),
        ...artifactRows.filter((artifact) => artifact.productTurnId === row.productTurnId),
      );
  }
// 三者必须成对使用：rows 进投影、drafts 进 content block、bytes 进上传；
// 调用方若只用其中一部分，就会得到「有卡片没字节」或反之的不一致快照。
  return { rows, drafts, bytes };
}
