// INV-01 截图是展示增强不是失败点：守住位置 最外层 catch；改错故障 补图失败把已成功的轮次标成失败。
// INV-02 合成 ToolPart 必须直接 completed：守住位置 persistPart 的 state；改错故障 投影停在 running 占住并发槽。
// INV-03 图片只进 display 投影：守住位置 metadata.display；改错故障 截图回灌模型上下文撑爆 token。
// INV-04 同一 turn 只补一张：守住位置 consumeBrowserTurnState；改错故障 重试后追加重复 part。
// INV-05 无 candidate 或无端口即跳过：守住位置 两处早退；改错故障 非 Browser 宿主凭空造 tab。
// INV-06 只截 active tab：守住位置 list 结果过滤；改错故障 截到后台页签，与用户所见不一致。
// INV-07 超预算先压缩再展示：守住位置 prepareForModel 分支；改错故障 复杂页面截图被静默丢弃。
// INV-08 压缩不放宽持久化预算：守住位置 复用展示常量；改错故障 存储层被大图撑爆。
// INV-09 无图不落 part：守住位置 display 判定；改错故障 UI 出现空截图或伪造成功。
// INV-10 事件顺序 scheduled→started→result：守住位置 三次 append；改错故障 投影认不出合成 part。
// INV-11 part 与事件时间同源：守住位置 timestamp；改错故障 UI 出现负耗时或时间跳变。
// INV-12 result.content 必须为空：守住位置 合成结果；改错故障 模型读到不存在的工具输出。
// INV-13 事件先落库再进内存镜像：守住位置 appendScreenshotEvent 顺序；改错故障 投影与事件流错序。
//
// 模块职责：轮次收尾时给 active tab 补一张终态截图并合成为 completed 工具 part。
// 阅读顺序：先看状态消费与端口早退，再看截图/压缩与 part 落库，最后看三条事件时序。
// ============================================================
// runtime/methods/browser-turn-screenshot.ts —— 轮次收尾时补一张 Browser 终态截图
// ============================================================
// 定位：纯展示旁支：turn 正常结束后给 active tab 拍终态图，并以合成 tool part +
//   ToolCallScheduled/Started/Result 事件进入投影。
// 输入：RegularTurnLoopState（含 turnAbortSignal 与 trace） + 挂载目标 assistantMessageId。
// 关键不变量：截图是增强，任何失败（端口缺席/无 active tab/压缩失败/事件写失败）只能 warn，
//   不得覆盖已成功的模型轮次；合成 ToolPart 必须是 completed 终态，不能停在 pending/running
//   （不变量 #1）；图片只进 display 投影，不回灌模型上下文（不变量 #4）。
// ============================================================
import {
  SessionEventType,
  createPartId,
  createToolCallId,
  type MessageId,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { consumeBrowserTurnState } from "../../repl/browser-turn-state.js";
import {
  createToolResultDisplay,
  MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES,
} from "../../tool/executor/result-display.js";
import { HOST_NODE_REPL_IMAGE_MAX_DIMENSION } from "../../mcp/image-normalization.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

// 复用 node_repl 工具名，展示层据此走同一套图片渲染与分组。
// 改名会同时影响 UI 分组与历史投影的兼容性。
const BROWSER_TURN_SCREENSHOT_TOOL_NAME = "mcp__node_repl__js";
// base64 有 4/3 膨胀，先换算成原始字节上限再交给图片处理器。
// 与展示预算严格对应，不额外放大。
const BROWSER_TURN_SCREENSHOT_MAX_RAW_BYTES = Math.floor(
  (MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES * 3) / 4,
);

function createBrowserTurnScreenshotDisplay(image: {
  base64: string;
  mimeType: string;
}) {
  const display = createToolResultDisplay(BROWSER_TURN_SCREENSHOT_TOOL_NAME, {
    images: [image],
  });
  // 构造器可能拒绝该图（超预算/不支持），非 node_repl_images 时返回 undefined 交由上层跳过。
  // 构造器拒绝（超预算/不支持）时返回 undefined，由调用方按无图处理。
  // source 标记让前端区分轮尾图与真实工具截图。
  if (display?.kind !== "node_repl_images") return undefined;
  return { ...display, source: "browser_turn_end" };
}

// 事件由 runtime 统一创建，保证 trace 与时序字段完整。
// appendEvent 落库成功后才 push 内存镜像，镜像只服务本轮投影。
async function appendScreenshotEvent(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  type: SessionEventType,
  payload: unknown,
): Promise<void> {
  const event = runtime.createEvent(type, payload, state.turnTraceContext);
  // 先落事件再记入 state.events：内存数组是本轮投影的镜像，顺序必须与事件流一致。
  await runtime.appendEvent(event, state.turnTraceContext);
  state.events.push(event);
}

export async function appendBrowserTurnScreenshot(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  assistantMessageId: MessageId,
): Promise<void> {
  // consume 是"取出即删除"：同一 turn 只补一张轮尾图，重复调用会读到 undefined。
  // take 语义：取到即从状态表删除，重复调用返回 undefined。
  // 因此上游即使重试也不会重复补图。
  const turnState = consumeBrowserTurnState(runtime.sessionId, state.turnId);
  // 本轮没用过 Browser 就没有 candidate（browserGeneration/browserId），无从定位目标。
  if (!turnState?.candidate) return;
  // 显式 emitImage 只代表工具执行过程已产出图片，不能替代轮次结束时 active tab 的
  // 最终状态截图；据此整轮跳过会让“打开页面并截图”这类真实 Browser 使用没有轮尾图。
  // 端口缺席（非 Browser 宿主/未接线）静默跳过，这是能力降级而不是失败。
  // 端口缺席表示宿主没有 Browser 能力，属能力降级而非失败。
  // 显式 emitImage 不能替代轮尾图，两者语义不同。
  const port = runtime.browserControlPort;
  if (!port) return;

  const { browserGeneration, browserId } = turnState.candidate;
  try {
    // 先 list 拿 active tab：screenshot 需要 tabId，且"轮尾图"的语义就是用户最后看到的那个页签。
    // list 与 screenshot 携带同一个 turnAbortSignal，用户取消时一起中断。
    // browserGeneration 防止重连后打到旧 browser instance。
    const listed = await port.execute({
      browserGeneration,
      browserId,
      sessionId: runtime.sessionId,
      turnId: String(state.turnId),
      command: { method: "list" },
      traceContext: state.turnTraceContext,
      signal: state.turnAbortSignal,
    });
    const activeTab = listed.ok
      ? listed.tabs?.find((tab) => tab.active === true)
      : undefined;
    // 没有 active tab（窗口已关或用户切走）就跳过：不能凭空构造 tabId，也不能报错误事件。
    // 窗口已关或用户切走都视为无 active tab，这里只记 debug 不报错误事件。
    if (!activeTab) {
      runtime.logger?.debug(
        "Browser turn screenshot skipped because no active tab is available",
        {
          event: "browser.turn_screenshot.skipped_no_active_tab",
          module: "core.runtime",
          turnId: String(state.turnId),
        },
      );
      return;
    }

    const captured = await port.execute({
      browserGeneration,
      browserId,
      sessionId: runtime.sessionId,
      turnId: String(state.turnId),
      command: { method: "screenshot", tabId: activeTab.tabId },
      traceContext: state.turnTraceContext,
      signal: state.turnAbortSignal,
    });
    // 截图本身失败时 captured.image 可能仍有值；先按 ok + image 双重判定，避免把错误响应当图。
    let displayImage: { base64: string; mimeType: string } | undefined = captured.image;
    if (
      captured.ok &&
      displayImage &&
      Buffer.byteLength(displayImage.base64, "utf8") >
        MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES &&
      runtime.imageProcessorPort
    ) {
      // 复杂页面的原始 PNG 经常超过 Node REPL 的 200 KiB 展示预算；直接
      // 交给 display 构造器后被静默丢弃，表现为第一轮能显示、后续复杂页面轮次没有截图。
      // 这里复用统一图片处理端压缩，不放宽持久化预算，也不把图片回灌模型上下文。
      const prepared = await runtime.imageProcessorPort.prepareForModel(
        {
          data: Buffer.from(displayImage.base64, "base64"),
          maxBase64Bytes: MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES,
          maxDimension: HOST_NODE_REPL_IMAGE_MAX_DIMENSION,
          maxRawBytes: BROWSER_TURN_SCREENSHOT_MAX_RAW_BYTES,
          mediaType: displayImage.mimeType,
          trace: state.turnTraceContext,
        },
        { signal: state.turnAbortSignal },
      );
      displayImage = {
        base64: Buffer.from(prepared.data).toString("base64"),
        mimeType: prepared.mediaType || displayImage.mimeType,
      };
    }
    // captured 失败或没有图就没有 display：下面明确 warn 后返回，不写"半成品" part。
    const display =
      captured.ok && displayImage
        ? createBrowserTurnScreenshotDisplay(displayImage)
        : undefined;
    // 无可展示图就不落 part：宁缺勿造，避免 UI 出现空截图或伪造成功。
    if (!display) {
      runtime.logger?.warn(
        "Browser turn screenshot capture returned no displayable image",
        {
          errorCode: captured.error?.code,
          event: "browser.turn_screenshot.capture_failed",
          module: "core.runtime",
          turnId: String(state.turnId),
        },
      );
      return;
    }

    const toolCallId = createToolCallId();
    const partId = createPartId();
    const timestamp = Date.now();
    const input = { source: "browser_turn_end" };
    // 合成 tool part 直接以 completed 落库：不变量 #1 要求 ToolPart 不能停在 pending/running。
    await runtime.persistPart(
      {
        id: partId,
        sessionID: runtime.sessionId,
        messageID: assistantMessageId,
        type: "tool",
        callID: toolCallId,
        tool: BROWSER_TURN_SCREENSHOT_TOOL_NAME,
        state: {
          status: "completed",
          input,
          output: "",
          title: BROWSER_TURN_SCREENSHOT_TOOL_NAME,
          metadata: { schemaVersion: 1, display },
          time: { start: timestamp, end: timestamp },
        },
      },
      state.turnTraceContext,
    );

    // 三条事件按真实时序补齐：投影只有看到 scheduled→started→result 才把合成 part 当普通工具展示。
    await appendScreenshotEvent(
      runtime,
      state,
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        assistantMessageId,
        toolName: BROWSER_TURN_SCREENSHOT_TOOL_NAME,
        input,
        dependencies: [],
        canRunParallel: false,
        schedule: {
          parallelGroups: [[toolCallId]],
          executionOrder: [toolCallId],
        },
      },
    );
    // started/result 与 part 的 time.start/end 同源（timestamp），避免 UI 耗时出现负数或跳变。
    await appendScreenshotEvent(
      runtime,
      state,
      SessionEventType.ToolCallStarted,
      {
        toolCallId,
        toolName: BROWSER_TURN_SCREENSHOT_TOOL_NAME,
        startedAt: new Date(timestamp),
      },
    );
    // result 带 success:true 与同一 display：合成调用没有真实模型可见输出，content 必须为空。
    await appendScreenshotEvent(
      runtime,
      state,
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        result: { success: true, content: "", display },
        duration: 0,
      },
    );
    runtime.logger?.debug("Browser turn screenshot appended", {
      event: "browser.turn_screenshot.appended",
      module: "core.runtime",
      turnId: String(state.turnId),
    });
  } catch (error) {
    // 自动截图是展示增强，失败不能覆盖已经成功完成的模型轮次。
    runtime.logger?.warn("Browser turn screenshot failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "browser.turn_screenshot.failed",
      module: "core.runtime",
      turnId: String(state.turnId),
    });
  }
}
