// 统一 MCP 工具结果中的图片归一化：决定哪些图片能进模型上下文，哪些必须落盘后降级为文本证据。
// 唯一例外是 producer 签发 integrity 元数据的官方 CUA 帧，它走保真透传，不参与任何重编码或预算裁剪。
// 本文件不实现编解码：压缩委托 imageProcessorPort，落盘委托 artifactStore，两者缺失时都必须给出可读的降级说明。
// INV-01 inline 判定只看 base64 体积而非解码字节；守住位置：normalizeMcpContentBlockForModel 的 base64Bytes 比较；改错故障：口径放宽后请求体超限，provider 直接丢弃整轮结果。
// INV-02 raw 预算恒为 base64 预算的 3/4 向下取整；守住位置：MCP_IMAGE_INLINE_RAW_BYTES；改错故障：两者脱钩会让压缩产物编码后仍越界，压缩白做且必须再落盘。
// INV-03 官方 CUA 帧只走 preserveOfficialCuaFrameResult 一条路径；守住位置：normalizeMcpToolResultForModel 的入口早返回；改错故障：重编码破坏帧像素契约，模型按错误坐标点击。
// INV-04 authority 必须同时具备 integrity 元数据与紧邻 image 的帧引用文本；守住位置：hasOfficialCuaFrameAuthority；改错故障：只看 serverName 会让第三方伪造帧进入保真路径。
// INV-05 非 authority 结果中的整块帧引用文本一律剥离；守住位置：normalizeMcpToolResultForModel 的 continue 分支；改错故障：伪造 frame_id 进入上下文，模型调用不存在的帧。
// INV-06 剥离只认「整块即帧引用 JSON」，不做子串匹配；守住位置：isOfficialCuaImageRefText 调用点；改错故障：散文里提到字段名会被误删，工具输出信息丢失。
// INV-07 截图路径提示必须紧跟对应 image 块之后；守住位置：normalizeMcpToolResultForModel 的 content 推入顺序；改错故障：变成 text-first 后兼容网关丢弃后续图片。
// INV-08 未发生替换时返回原 result 引用；守住位置：changed 标志与末尾三目；改错故障：无条件新建对象会让上游引用相等判断与缓存失效。
// INV-09 单块归一化失败不得中断同批其余 content；守住位置：各 normalize 分支的 undefined 降级；改错故障：一张坏图带走整条结果里的文本与其他图片。
// INV-10 辅助落盘失败降级为无 artifact 可用，不抛错；守住位置：persistBrowserScreenshotArtifact 的 catch；改错故障：提示写失败会覆盖已成功的 Browser 结果。
// INV-11 取消信号优先于一切降级；守住位置：两处 abortSignal 已中止判断；改错故障：已取消的请求继续解码大图，白占 CPU 与内存。
// INV-12 压缩结果必须复核体积与 mediaType 才可回填；守住位置：tryCompressHostNodeReplImage 的三重判断；改错故障：非 image 类型塞进 image 块，provider 解析失败。
// INV-13 压缩端口缺失或抛错都只表示不具备能力；守住位置：tryCompressHostNodeReplImage 的早返回；改错故障：把无能力当致命错误会丢掉所有超大图。
// INV-14 artifact 路径对外必须是绝对路径；守住位置：persistBrowserScreenshotArtifact 的 resolve 兜底；改错故障：相对路径在模型侧不可定位，提示指向错误目录。
// INV-15 mimeType 必须先剥离参数并小写化再映射扩展名；守住位置：extensionForMimeType；改错故障：带 charset 的 PNG 落到 .bin，预览失败。
// INV-16 data URL 只按第一个逗号切出 payload；守住位置：base64PayloadFromMcpImageData；改错故障：整串解码得到乱码字节，落盘文件损坏。
// INV-17 空 payload 视为无图；守住位置：persist 与 compress 的 byteLength 判断；改错故障：0 字节文件被当成截图，模型收到空白画面。
// INV-18 browser 截图索引必须落在 content 长度内；守住位置：readBrowserScreenshotContentIndices 的过滤；改错故障：越界索引读到 undefined 并抛错中断整条结果。
import { isAbsolute, resolve } from "node:path";
import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  type McpContentBlock,
  type McpToolCallResult,
  type McpToolDescriptor,
  type TraceContext,
} from "@zcode/contracts";
import {
  isOfficialCuaImageRefText,
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
} from "@zcode/zcode-cua/frame-contract";
import type { ToolExecutionContext } from "../tool/types.js";
// 帧像素契约（integrity gate + inline 上限）的唯一定义在 producer；宿主经
// plugin re-export 消费，不再镜像实现。core 对 CUA 的感知收敛为：authority
// 分支调用 producer gate，非 authority 分支用 contracts scanner 剥伪造引用。
import { preserveOfficialCuaFrameResult } from "@zcode/zcode-cua/frame-contract";

// 通用 MCP 图片 inline 预算与官方帧 200 KiB 上限历史上同值，但语义独立：
// 这里独立定义，避免"通用预算由 CUA 常量定义"的倒置耦合。
// [权衡] 200 KiB 是请求体预算与截图可读性的折中：再大则多图并发时整轮请求超限，再小则 1280 宽的截图细节被压没。
// 预算按 base64 字符数计，所以这里写的是编码后长度，与解码后字节数属于两个口径。
// [失败路径] provider 的 body 上限若调整，只需改这一个常量；散落的字面量无法一次校准，必然漏改。
export const MCP_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;
// 3/4 是 base64 膨胀比的上界，向下取整保证最坏 padding 下编码后仍不越界。
// [并发] 模块加载时一次算定，之后只读，多个工具调用并发读取无需同步。
export const MCP_IMAGE_INLINE_RAW_BYTES = Math.floor((MCP_IMAGE_INLINE_BASE64_BYTES * 3) / 4);
export const HOST_NODE_REPL_IMAGE_MAX_DIMENSION = 2048;
// Provider 的模型图片上限是 2000px；Browser 轮尾展示仍沿用独立的 2048px 预算。
// [权衡] 2000 与 Browser 侧的 2048 刻意分开：前者是 provider 硬上限，后者是展示侧预算，混用必有一侧越界。
// 缩放由 imageProcessorPort 执行，这里只传参数，不替调用方决定采样策略。
const HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION = 2000;

export async function normalizeMcpToolResultForModel(input: {
  compressOversizedImages: boolean;
  context: ToolExecutionContext;
  descriptor: McpToolDescriptor;
  preserveOfficialCuaFrames?: boolean;
  result: McpToolCallResult;
  toolName: string;
// [并发] 同一 result 的并发调用安全：只读 content，所有改动都落在新建数组上。
}): Promise<McpToolCallResult> {
  // node_repl 是通用入口，不能把整个 server 标成 official CUA；但 CUA SDK 会在
  // 结构化结果中携带 producer 签发的 integrity metadata。只对这一条结果动态进入
  // exact-raster 路径，既保留 CUA 帧，又不影响同一 server 的 Browser Use 图片。
  // node_repl 是共享 server：同一进程既跑 Browser Use 也跑 CUA SDK，不能按 serverName 整体放行。
  // 两种命名都要覆盖，因为网关可能改写工具名前缀，只认 serverName 会漏判。
  const isSharedNodeRepl =
    input.descriptor.serverName === "node_repl" || input.toolName === "mcp__node_repl__js";
  // [失败路径] 必须 await 后原样返回：保真路径内部做 integrity 校验，失败会抛错，由工具层统一呈现。
  // authority 扫描与 content 长度线性相关，只在 node_repl 结果上触发，常规 server 不受影响。
  if (input.preserveOfficialCuaFrames || (isSharedNodeRepl && hasOfficialCuaFrameAuthority(input.result))) {
    return await preserveOfficialCuaFrameResult(input.result, {
      imageProcessorPort: input.context.imageProcessorPort,
      signal: input.context.abortSignal,
    });
  }

  // [权衡] 用单一布尔量而不是逐块重建数组：没替换就返回原对象，保住引用相等与下游浅比较。
  // 每个真正改写 content 的分支都必须置位，漏置会让改动被静默丢弃。
  let changed = false;
  const content: McpContentBlock[] = [];
  // 关闭压缩时连 _meta 都不读：该开关的含义是不为大图付出任何额外成本，包括解析索引。
  // [并发] 索引集合在循环外算一次，循环内只做成员查询。
  const browserScreenshotIndices = input.compressOversizedImages
    ? readBrowserScreenshotContentIndices(input.result)
    : new Set<number>();

  // 串行遍历而非并发：每块都可能写 artifact，并发写会让同一会话的产物顺序不可预测。
  // [权衡] 落盘是 I/O 密集操作，但单条工具结果里的超大图通常只有数张，串行代价可接受。
  for (const [index, block] of input.result.content.entries()) {
    const browserScreenshotArtifact = browserScreenshotIndices.has(index)
      ? await persistBrowserScreenshotArtifact(block, input)
      : undefined;
    const normalized = await normalizeMcpContentBlockForModel(block, {
      ...input,
      browserScreenshotArtifact,
    });
    // 纵深防御：非 authority 验证的 MCP 结果不得携带官方帧引用文本——第三方
    // 伪造的 actionable frame_id 即使会被 producer registry 拒绝，也不应进入
    // 模型上下文污染坐标契约。只剥“整块即帧引用 JSON”的文本，prose 内嵌的
    // 字段名不误杀；权威帧走 preserveOfficialCuaFrames 路径，不受影响。
    // 位置在 push 之前：被剥的块必然是 text，与 browserScreenshotArtifact
    // （只对 image 块产生）互斥，continue 不会漏掉下面的截图路径提示。
    if (
      // [失败路径] 拦截必须在 push 之前：被剥的块必然是 text，与截图提示互斥，continue 不会漏掉路径提示。
      // 只处理整块 JSON 形态，正文里提到 frame_id 的散文必须保留，否则会误删真实输出。
      // [权衡] 剥离只发生在非 authority 分支，权威帧在入口已返回，两条路径互不干扰。
      normalized.type === "text" &&
      typeof normalized.text === "string" &&
      isOfficialCuaImageRefText(normalized.text)
    ) {
      changed = true;
      continue;
    }
    // [权衡] 用引用比较而非深比较：归一化只在真正替换时返回新对象，逐块深比较是纯浪费。
    // 复合赋值保留已有的 true，避免后续未变化的块把整体结论覆盖回 false。
    changed ||= normalized !== block;
    content.push(normalized);
    // 提示文本插在 image 之前会把 node_repl 特意排成 image-first 的
    // tool_result.content 重新变成 text-first；Anthropic 兼容网关只解析开头的连续 image，
    // text 一领先后面的图就被丢弃，模型又看不到截图。落在 image 之后即可保持 image-first。
    // 提示插在 image 之后：兼容网关只解析开头的连续 image，text 抢先会让后面的图被丢弃。
    // [权衡] 路径写进独立 text 块而不是块内 metadata，因为只有 text 会进模型上下文。
    if (browserScreenshotArtifact) {
      content.push({
        type: "text",
        text: `Browser screenshot saved to: ${browserScreenshotArtifact.absolutePath}`,
      });
      changed = true;
    }
  }

  // [权衡] 未变化时返回原引用，上游据此判断本轮没有图片被改写，省掉一次整包复制。
  return changed ? { ...input.result, content } : input.result;
}

export function hasOfficialCuaFrameAuthority(result: unknown): result is McpToolCallResult {
  // [失败路径] 入参来自跨进程的工具结果边界，任何形状都可能出现，必须容错返回 false。
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const candidate = result as {
    content?: unknown;
    _meta?: Record<string, unknown>;
  };
  // integrity 元数据是 producer 签发的凭证，缺失时只能按普通图片处理，不能凭 image 块猜测。
  if (!Array.isArray(candidate.content) || !candidate._meta?.[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]) {
    return false;
  }
  const blocks = candidate.content;
  // 要求帧引用文本紧随 image 块是 producer 的固定排版契约，不是启发式猜测。
  // [失败路径] 找不到相邻文本即返回 false，宁可走通用图片路径，也不误判成权威帧。
  return blocks.some(
    (block, index) => {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") {
        return false;
      }
      // [失败路径] 用可选链读邻居：最后一个 image 块没有后继，越界不应抛错。
      const nextText = (blocks[index + 1] as { text?: unknown } | undefined)?.text;
      return typeof nextText === "string" && isOfficialCuaImageRefText(nextText);
    },
  );
}

async function normalizeMcpContentBlockForModel(
  block: McpContentBlock,
  input: {
    compressOversizedImages: boolean;
    context: ToolExecutionContext;
    descriptor: McpToolDescriptor;
    toolName: string;
    browserScreenshotArtifact?: BrowserScreenshotArtifact;
  },
): Promise<McpContentBlock> {
  // 非 image 块原样返回，其体积由各自预算约束，不在本文件处理。
  if (block.type !== "image") return block;

  const data = typeof block.data === "string" ? block.data : undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  // [失败路径] 缺字段既无法判体积也无法定扩展名，透传让问题在 provider 侧更早暴露。
  if (!data || !mimeType) return block;

  const base64Payload = base64PayloadFromMcpImageData(data);
  // [权衡] 不解码只量长度：判定只需体积，解码一张数 MB 的图是纯粹的浪费。
  const base64Bytes = Buffer.byteLength(base64Payload, "utf8");
  // 边界取闭区间，等于预算的图片允许内联，provider 的语义是不超过。
  if (base64Bytes <= MCP_IMAGE_INLINE_BASE64_BYTES) return block;

  // [权衡] 压缩优先于落盘：保住视觉信息比留下完整原图更有价值，模型判断截图依赖像素。
  // 压缩失败会落到下面的 artifact 分支，两条路径共享同一份 summary，文本数字才一致。
  if (input.compressOversizedImages) {
    // browser screenshot 由可信宿主 node_repl 产生，不能和第三方 MCP 图片一样直接
    // 落 artifact，导致模型失去视觉结果；这里复用统一图片端口压到 200 KiB，而不另造编解码器。
    const compressed = await tryCompressHostNodeReplImage({
      base64Payload,
      context: input.context,
      mimeType,
    });
    if (compressed) return compressed;
  }

  // summary 同时喂给落盘元数据与降级文本，是体积事实的唯一来源。
  const summary = {
    base64Bytes,
    inlineLimitBytes: MCP_IMAGE_INLINE_BASE64_BYTES,
    mimeType,
  };

  // 截图已持久化，这里不再重复写 artifact，避免同一张图落两份。
  // [权衡] 文本保留体积与上限，用户能自行判断是否该调大预算，而不是只看到已省略。
  if (input.browserScreenshotArtifact) {
    return {
      type: "text",
      text: [
        `MCP image content omitted: ${mimeType}, base64=${formatByteSize(base64Bytes)} exceeds inline limit ${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
        "The original browser screenshot remains available at the adjacent absolute path.",
      ].join("\n"),
    };
  }

  // [失败路径] 无 store 时必须显式告知无法保存，不能返回空内容让模型以为工具没有产出。
  if (!input.context.artifactStore) {
    return {
      type: "text",
      text: [
        `MCP image content omitted: ${mimeType}, base64=${formatByteSize(base64Bytes)} exceeds inline limit ${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
        "No artifact store is configured, so the original image could not be saved.",
      ].join("\n"),
    };
  }

  // [并发] 每次落盘都带 trace 与 toolCallId，产物可按会话归因，互不覆盖。
  // [失败路径] 这里不做兜底：store 写失败属于基础设施故障，应抛给工具层统一呈现。
  const artifact = await writeMcpImageArtifact({
    base64Payload,
    context: input.context,
    dataUrl: asDataUrl(data, mimeType),
    descriptor: input.descriptor,
    summary,
    toolName: input.toolName,
  });

  return {
    type: "text",
    text: [
      `MCP image content saved instead of being inlined: ${mimeType}, base64=${formatByteSize(base64Bytes)}, inlineLimit=${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
      `Artifact: ${artifact.path ?? artifact.uri}`,
      `Artifact URI: ${artifact.uri}`,
    ].join("\n"),
  };
}

interface BrowserScreenshotArtifact {
  absolutePath: string;
}

function readBrowserScreenshotContentIndices(result: McpToolCallResult): Set<number> {
  // _meta 是跨进程的弱契约字段，形状不可信，必须先做数组判定再逐项校验。
  const value = result._meta?.[ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY];
  if (!Array.isArray(value)) return new Set<number>();
  // 转成 Set 是为了循环内常数时间成员查询，索引数组通常个位数，块数却可能上千。
  return new Set(
    value.filter(
      (index): index is number =>
        Number.isInteger(index) && index >= 0 && index < result.content.length,
    ),
  );
}

async function persistBrowserScreenshotArtifact(
  block: McpContentBlock,
  input: {
    context: ToolExecutionContext;
    toolName: string;
  },
): Promise<BrowserScreenshotArtifact | undefined> {
  // 非 image 块没有可持久化的二进制，返回 undefined 让上层继续常规归一化。
  if (block.type !== "image") return undefined;
  const data = typeof block.data === "string" ? block.data : undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  const artifactStore = input.context.artifactStore;
  const writeBinary = artifactStore?.writeToolResultBinaryArtifact;
  // [失败路径] 四个条件缺一不可，退化成 JSON 包装会把 base64 再膨胀一次。
  // 静默降级而非报错：截图路径属于增强信息，缺失时主结果仍应正常返回。
  if (!data || !mimeType || !artifactStore || !writeBinary) return undefined;

  // 解码前必须去掉 data URL 前缀，否则 Buffer 遇到非法字符会静默截断。
  const content = Buffer.from(base64PayloadFromMcpImageData(data), "base64");
  if (content.byteLength === 0) return undefined;
  try {
    const artifact = await writeBinary.call(
      artifactStore,
      {
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        toolCallId: input.context.toolCallId,
        toolName: input.toolName,
        content,
        contentType: mimeType,
        extension: extensionForMimeType(mimeType),
        retention: "session",
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
    // [失败路径] 只有 URI 没有路径时给不出可打开的绝对路径，宁可不提示也不要给假地址。
    if (!artifact.path) return undefined;
    return {
      // [权衡] 相对路径按进程工作目录解析，store 若返回相对路径，说明它没做归一化，这里兜底。
      absolutePath: isAbsolute(artifact.path) ? artifact.path : resolve(artifact.path),
    };
  } catch (error) {
    // 额外截图路径写入失败不应覆盖已成功的 Browser 结果；
    // 但工具取消时仍需立即退出，不继续处理大图。
    if (input.context.abortSignal.aborted) throw error;
    return undefined;
  }
}

async function tryCompressHostNodeReplImage(input: {
  base64Payload: string;
  context: ToolExecutionContext;
  mimeType: string;
}): Promise<McpContentBlock | undefined> {
  const imageProcessorPort = input.context.imageProcessorPort;
  // [失败路径] 未注入图片端口意味着宿主没有压缩能力，直接让上层走落盘降级。
  if (!imageProcessorPort) return undefined;

  // 端口接收二进制而不是 base64，避免每次压缩都重复做字符串到字节的转换。
  const decoded = Buffer.from(input.base64Payload, "base64");
  if (decoded.byteLength === 0) return undefined;

  try {
    const prepared = await imageProcessorPort.prepareForModel(
      {
        data: decoded,
        // [权衡] 三个上限同时下发，端口才能在维度与体积之间取舍；缺一项它只能盲目压到最小。
        // [权衡] 预算在调用前一次讲清而不是压完再量：端口可同时收敛 base64 体积与维度，压完才发现超标的路径在下方兜底为 undefined。
        maxBase64Bytes: MCP_IMAGE_INLINE_BASE64_BYTES,
        maxDimension: HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION,
        maxRawBytes: MCP_IMAGE_INLINE_RAW_BYTES,
        mediaType: input.mimeType,
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
    const compressedBase64 = Buffer.from(prepared.data).toString("base64");
    // [失败路径] 端口可能原样返回或返回空结果，这里必须自己复核，不能假设下游守约。
    const compressedBase64Bytes = Buffer.byteLength(compressedBase64, "utf8");
    if (
      compressedBase64Bytes === 0 ||
      compressedBase64Bytes > MCP_IMAGE_INLINE_BASE64_BYTES ||
      !prepared.mediaType.startsWith("image/")
    ) {
      return undefined;
    }
    return {
      type: "image",
      data: compressedBase64,
      mimeType: prepared.mediaType,
    };
  // [失败路径] 端口抛错（解码失败、格式不支持）时降级为落盘，不把异常传播成工具失败。
  // [并发] 取消检查放在最前：用户已取消还继续处理只会白占资源，并掩盖真正的取消原因。
  } catch (error) {
    if (input.context.abortSignal.aborted) throw error;
    return undefined;
  }
}

async function writeMcpImageArtifact(input: {
  base64Payload: string;
  context: ToolExecutionContext;
  dataUrl: string;
  descriptor: McpToolDescriptor;
  summary: {
    base64Bytes: number;
    inlineLimitBytes: number;
    mimeType: string;
  };
  toolName: string;
}): Promise<{
  bytes: number;
  contentType: string;
  path?: string;
  uri: string;
}> {
  const artifactStore = input.context.artifactStore;
  // [失败路径] 上层已判空，这里再抛是防御性断言：说明有人绕过归一化直接调用。
  if (!artifactStore) {
    throw new Error("MCP image artifact store is not configured");
  }

  // [权衡] 二进制优先：JSON 包装要把整图 base64 进一个字符串字段，产物放大约 4/3。
  // 旧 store 只实现 JSON 写入，保留回退分支是为了不破坏宿主兼容性。
  if (artifactStore.writeToolResultBinaryArtifact) {
    return artifactStore.writeToolResultBinaryArtifact(
      {
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        toolCallId: input.context.toolCallId,
        toolName: input.toolName,
        content: Buffer.from(input.base64Payload, "base64"),
        contentType: input.summary.mimeType,
        extension: extensionForMimeType(input.summary.mimeType),
        retention: "session",
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
  }

  return artifactStore.writeToolResultArtifact(
    {
      sessionId: input.context.sessionId,
      turnId: input.context.turnId,
      toolCallId: input.context.toolCallId,
      toolName: input.toolName,
      // [权衡] 回退格式保留 dataUrl 与 summary，即便只能存 JSON，下游也能还原图片并知道原始体积。
      content: JSON.stringify(
        {
          type: "mcp-image-artifact",
          createdAt: new Date().toISOString(),
          dataUrl: input.dataUrl,
          registeredToolName: input.toolName,
          serverName: input.descriptor.serverName,
          toolName: input.descriptor.toolName,
          ...input.summary,
        },
        null,
        2,
      ),
      contentType: "application/json",
      retention: "session",
      trace: traceFromToolContext(input.context),
    },
    { signal: input.context.abortSignal },
  );
}

export function asDataUrl(data: string, mimeType: string): string {
  // [失败路径] 已带 data: 前缀则原样返回，避免在带前缀的串上再拼一次前缀与编码标记，得到坏串。
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

export function base64PayloadFromMcpImageData(data: string): string {
  if (!data.startsWith("data:")) return data;
  const commaIndex = data.indexOf(",");
  // [失败路径] 没有逗号的畸形 data URL 直接返回原串，交给体积检查兜底。
  return commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
}

function extensionForMimeType(mimeType: string): string {
  // 先剥参数再小写：带 charset 的 image/PNG 必须与 image/png 落到同一扩展名。
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      // [失败路径] 未知类型统一 .bin，保留原始字节而不猜扩展名，避免给出错误的预览方式。
      return ".bin";
  }
}

function traceFromToolContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as TraceContext;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;
  // [权衡] 手写换算而不是本地化格式化，输出要稳定可断言，不受 locale 与 ICU 版本影响。
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    // 大于等于 10 取整、否则保留一位小数，让 200 KiB 与 1.5 MiB 都保持三位有效数字。
    value >= 10 || unitIndex === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}
