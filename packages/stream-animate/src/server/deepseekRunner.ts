// DeepSeek 流式执行器：单次 run 从 HTTP 建连、SSE 增量解析到落盘归档的唯一实现点
// 边界：只负责协议消费与观测数据累积，不决定 run 是否复用、不调度队列、不渲染 UI
// 上游由 server 层传入已分配的 run 与 packageRoot，下游只通过 dataStore 与回调对外生效
// 全部外部副作用都集中在本文件内，任何新增旁路写入都会破坏 run 目录的单一事实来源
// INV-01 run 目录在首次写入前必须先经 ensureRunDir 就绪；守住位置：executeDeepseekRun 首行；改错故障：raw.ndjson 落在不存在的目录导致整次运行直接失败
// INV-02 raw 事件流按 run.started、http 事件、sse 事件、终态事件的单向顺序落盘；守住位置：rawWriter 的四处写入；改错故障：回放时事件乱序，进度与首字延迟被算错
// INV-03 首字节时间只由 fetch 返回时刻确定，不随分块到达重算；守住位置：executeDeepseekRun 的 firstByteMs 赋值；改错故障：首字节指标虚高，吞吐对比失真
// INV-04 首 token 时间仅在首个非空增量出现时锁定一次；守住位置：deltaText 判空分支；改错故障：空 reasoning 帧抢占首 token，TTFT 偏小
// INV-05 进度回调默认两百毫秒节流，强制调用不受限制；守住位置：emitProgress 的早退分支；改错故障：高频 chunk 打满回调，UI 线程卡顿
// INV-06 outputChars 与 charEvents 必须同源同步累加；守住位置：sse.data 处理分支；改错故障：字符速率与帧分桶互相矛盾，动画曲线错位
// INV-07 SSE 分帧必须跨 chunk 保留残留下行缓冲；守住位置：consumeSseBuffer 的 remaining 回写；改错故障：TCP 断帧处丢 data，回答缺字
// INV-08 空 data 事件不入事件数组；守住位置：consumeSseBuffer 的末尾判空；改错故障：心跳注释被当成数据，解析出无意义空帧
// INV-09 终止标记只记录事件并跳过计数；守住位置：executeDeepseekRun 的 DONE 分支；改错故障：事件数虚增，rawSseChars 与真实 token 流不匹配
// INV-10 JSON 解析失败降级为空值而非抛错；守住位置：safeParseJson 的 catch；改错故障：单条脏帧中断整条流，已收内容丢失
// INV-11 增量文本同时取 reasoning_content 与 content；守住位置：extractDeltaText 的拼接；改错故障：思考模型回答只剩推理段落
// INV-12 response.txt 必须在 summary.json 之前写；守住位置：完成分支的两次 await；改错故障：summary 指向尚未存在的正文文件
// INV-13 失败分支也要落盘 response.txt 与 summary；守住位置：catch 分支；改错故障：半截输出无法复盘，排障只能靠日志
// INV-14 rawWriter 的关闭只放在 finally；守住位置：finally 分支；改错故障：异常路径泄漏句柄，raw.ndjson 尾部截断
// INV-15 缺失 API key 在发起请求前显式抛出；守住位置：resolveApiKey 的空值分支；改错故障：以空 Bearer 打网关，用户看到 401 而非配置提示
// INV-16 body 固定 stream 为真且 thinking 由开关映射；守住位置：buildRequestBody；改错故障：非流式响应让解析器读不到 body，运行静止
// INV-17 帧场景按 60 与 120 两种帧率同源生成；守住位置：buildMetrics 的 frames；改错故障：桌面与移动端动画节奏不一致
// INV-18 快照以入参 run 为基底覆盖状态字段；守住位置：buildRunSnapshot 的展开；改错故障：请求侧元数据被清空，历史列表显示空白条目
// INV-19 时间指标统一经 roundMs 保留一位小数；守住位置：buildMetrics 与 raw 写入；改错故障：浮点长尾进入持久化，快照比对永远不相等
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMetrics, RunRequestInput, RunSummary } from "../shared/types.js";
import { buildFrameScenario, type TimedCharEvent } from "./frameBuckets.js";
import {
  createRawWriter,
  ensureRunDir,
  toDataRelativePath,
  writeResponseText,
  writeRunSummary,
} from "./dataStore.js";

// 执行入口的入参契约：run 由调用方预先分配，本文件只读取 id 与既有字段
// packageRoot 用于把绝对路径换算成 data 相对路径，缺失会让归档链接全部失效
// onUpdate 是可选的观测出口，缺省时执行过程完全静默但落盘照旧
// 该类型不外泄到 shared，避免 server 内部结构成为稳定接口
interface ExecuteRunInput {
  onUpdate?: (run: RunSummary) => void;
  packageRoot: string;
  request: RunRequestInput;
  run: RunSummary;
}

// [资源] 每次调用独占一个 run 目录与一个 raw writer，生命周期由本次 try/finally 界定
// [权衡] 单函数内完成建连、消费、归档，牺牲可测性换取事件顺序只有一处可写
// 起始计时先于任何 IO，因此首字节与总时长都含目录创建开销
// 返回值为终态快照，失败也返回而非抛出，调用方据 status 分流
export async function executeDeepseekRun(input: ExecuteRunInput) {
  const runDir = await ensureRunDir(input.packageRoot, input.run.id);
  const rawWriter = createRawWriter(runDir);
  const startedAt = performance.now();
  const charEvents: TimedCharEvent[] = [];
  let firstByteMs: number | null = null;
  let firstTokenMs: number | null = null;
  let outputText = "";
  let outputChars = 0;
  let rawSseChars = 0;
  let sseEvents = 0;
  let lastProgressEmitMs = 0;

  // [并发] 节流窗口按单调时钟计，避免系统时间回拨导致进度长时间不刷新
  // 强制刷新用于首字节、终止标记与完成等节点，保证 UI 不漏掉关键状态跃迁
  // 快照中的 metrics 每次重建，不缓存旧值以免速率曲线滞后
  // 预览截断到 600 字符，是回调体积与可读性的折中
  const emitProgress = (force = false) => {
    const now = performance.now();
    if (!force && now - lastProgressEmitMs < 200) {
      return;
    }
    lastProgressEmitMs = now;
    input.onUpdate?.(
      buildRunSnapshot(input, runDir, {
        metrics: buildMetrics({
          charEvents,
          durationMs: now - startedAt,
          firstByteMs,
          firstTokenMs,
          outputChars,
          rawSseChars,
          sseEvents,
        }),
        outputPreview: outputText.slice(0, 600),
        status: "running",
      }),
    );
  };

  rawWriter.write({
    at: new Date().toISOString(),
    model: input.request.model,
    type: "run.started",
  });

  try {
    // [失败路径] 网络异常与 HTTP 非 2xx 走同一 catch，最终都产出 failed 快照
    // 请求体一次性序列化，不做流式上传，消息量受内存约束
    // 授权头由 resolveApiKey 统一解析，禁止在此处再读环境变量
    // [资源] 未设置超时，连接悬挂靠上层取消或进程退出收场
    const response = await fetch(input.request.baseUrl, {
      body: JSON.stringify(buildRequestBody(input.request)),
      headers: {
        Authorization: `Bearer ${resolveApiKey(input.request)}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    firstByteMs = performance.now() - startedAt;
    rawWriter.write({
      at: new Date().toISOString(),
      elapsedMs: roundMs(firstByteMs),
      status: response.status,
      statusText: response.statusText,
      type: "http.response",
    });
    emitProgress(true);

    // HTTP 非成功或缺失 body 都视为失败，body 缺失时不能进入读取循环
    // 错误正文被完整拼进异常消息，便于在 summary 中直接看到上游原因
    // 此时已写入 http.response 事件，失败仍保留状态码证据
    if (!response.ok || !response.body) {
      const errorBody = await response.text();
      throw new Error(`DeepSeek request failed: ${response.status} ${response.statusText} ${errorBody}`);
    }

    let buffer = "";
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    // [失败路径] 读流异常由外层 catch 收敛，循环内不做局部重试以免重复计费
    // done 为真即正常收流结束，不依赖终止标记，部分代理不会发送它
    // 每次 read 的字节数记入 raw，用于核对离线回放带宽
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      // stream 解码标志必须为真，否则多字节汉字会在分块边界被截断
      // 原始文本与字节数成对落盘，二者不一致可用于定位编码问题
      // 解码结果先入 raw 再入缓冲，保证 raw 是消费顺序的完整镜像
      const chunkText = decoder.decode(value, { stream: true });
      rawWriter.write({
        at: new Date().toISOString(),
        bytes: value.byteLength,
        chars: chunkText.length,
        elapsedMs: roundMs(performance.now() - startedAt),
        text: chunkText,
        type: "http.chunk",
      });

      buffer += chunkText;
      const parsed = consumeSseBuffer(buffer);
      buffer = parsed.remaining;

      for (const data of parsed.events) {
        const receivedAtMs = performance.now() - startedAt;
        // [权衡] 终止标记只作为流终止信号记录，不参与正文与计数
        // 该分支强制刷新进度，确保最后一块内容立即出现在界面上
        // 收到终止标记后仍继续读取直到 done，容忍对端多写尾部字节
        if (data === "[DONE]") {
          rawWriter.write({
            at: new Date().toISOString(),
            elapsedMs: roundMs(receivedAtMs),
            type: "sse.done",
          });
          emitProgress(true);
          continue;
        }

        // 计数字段单调递增，只统计有效 data 事件，用于校验解析完整性
        // 解析失败不阻断后续帧，脏数据只影响单帧增益
        // charEvents 与 outputText 同批更新，二者不允许出现中间态
        sseEvents += 1;
        rawSseChars += data.length;
        const decoded = safeParseJson(data);
        const deltaText = extractDeltaText(decoded);
        if (deltaText.length > 0 && firstTokenMs === null) {
          firstTokenMs = receivedAtMs;
        }
        outputText += deltaText;
        outputChars += deltaText.length;
        charEvents.push({ chars: deltaText.length, receivedAtMs });
        rawWriter.write({
          at: new Date().toISOString(),
          data,
          deltaChars: deltaText.length,
          elapsedMs: roundMs(receivedAtMs),
          index: sseEvents,
          type: "sse.data",
        });
        emitProgress();
      }
    }

    // 完成快照的总时长在此刻定格，后续落盘耗时不计入吞吐
    // 指标与快照分别构建，便于 raw 与 summary 使用同一份数值
    // 字符速率为零除保护后的结果，极短运行不会产生无穷值
    const durationMs = performance.now() - startedAt;
    const metrics = buildMetrics({
      charEvents,
      durationMs,
      firstByteMs,
      firstTokenMs,
      outputChars,
      rawSseChars,
      sseEvents,
    });
    const completedRun = buildRunSnapshot(input, runDir, {
      completedAt: new Date().toISOString(),
      metrics,
      outputPreview: outputText.slice(0, 600),
      status: "completed",
    });
    // [事务] 先正文后摘要，读取方按 summary 存在性判断本次归档是否完整
    // 两次写入均为异步且顺序 await，失败会跳入 catch 重写失败摘要
    // 路径由 buildRunSnapshot 统一换算，避免此处手拼 data 相对路径
    await writeResponseText(runDir, outputText);
    await writeRunSummary(runDir, completedRun);
    rawWriter.write({
      at: new Date().toISOString(),
      metrics,
      type: "run.completed",
    });
    return completedRun;
  // [失败路径] 任意阶段异常都降级为 failed 快照，不向调用方抛出
  // 错误消息取 message 或字符串化，保证非 Error 抛出也有可读文本
  // 此处重新写 response.txt，覆盖可能已部分写出的正文
  } catch (error) {
    const failedRun = buildRunSnapshot(input, runDir, {
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      metrics: null,
      outputPreview: outputText.slice(0, 600),
      status: "failed",
    });
    await writeFile(join(runDir, "response.txt"), outputText, "utf-8");
    await writeRunSummary(runDir, failedRun);
    rawWriter.write({
      at: new Date().toISOString(),
      error: failedRun.error,
      type: "run.failed",
    });
    return failedRun;
  // [资源] raw writer 只在此关闭，成功与失败共用同一条释放路径
  // 关闭发生在返回之后，调用方可能已拿到快照而文件仍在收尾
  // 关闭异常会覆盖原返回值，属于已知权衡
  } finally {
    await rawWriter.close();
  }
}

// 请求体是外部 API 契约的唯一定义点，字段名不可在别处复制
// stream 恒为真，本执行器不实现非流式回退
// thinking 由布尔开关映射为字符串枚举，缺省关闭推理
function buildRequestBody(request: RunRequestInput) {
  return {
    max_tokens: request.maxTokens,
    messages: request.messages,
    model: request.model,
    reasoning_effort: request.reasoningEffort,
    stream: true,
    temperature: request.temperature,
    thinking: { type: request.thinkingEnabled ? "enabled" : "disabled" },
  };
}

function resolveApiKey(request: RunRequestInput) {
  // [权衡] 请求级 key 优先于进程环境变量，便于多租户临时覆盖
  // 空白字符先裁剪，纯空格等同未配置
  // 缺失时抛错而非静默使用空串，避免请求打到网关才暴露
  const apiKey = request.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing API key. Set DEEPSEEK_API_KEY or provide apiKey in the request.");
  }
  return apiKey;
}

// 纯函数式解析：只吃缓冲返回事件与剩余，不持有跨调用状态
// 事件以空行分隔，支持 CRLF 与 LF 两种换行风格
// 同一事件的多行 data 按换行拼接，符合 SSE 规范
function consumeSseBuffer(buffer: string) {
  const events: string[] = [];
  let remaining = buffer;

  for (;;) {
    // 找不到分隔符即返回剩余缓冲，等待下一块数据补全
    // 分隔符长度按实际匹配字符判断，CRLF 与 LF 相差一字节
    // 循环持续到缓冲耗尽，单块输入可产出多个事件
    const separator = remaining.search(/\r?\n\r?\n/u);
    if (separator < 0) {
      return { events, remaining };
    }
    const rawEvent = remaining.slice(0, separator);
    remaining = remaining.slice(separator + (remaining[separator] === "\r" ? 4 : 2));
    const data = rawEvent
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length > 0) {
      events.push(data);
    }
  }
}

// 增量文本来源有两个字段，顺序固定为推理在前正文在后
// 结构不符时返回空串，调用方据此跳过空帧而不改计数
function extractDeltaText(decoded: unknown) {
  if (!isRecord(decoded)) {
    return "";
  }
  const choices = Array.isArray(decoded.choices) ? decoded.choices : [];
  return choices
    .map((choice) => {
      if (!isRecord(choice) || !isRecord(choice.delta)) {
        return "";
      }
      return [
        readString(choice.delta, "reasoning_content"),
        readString(choice.delta, "content"),
      ].join("");
    })
    .join("");
}

// [失败路径] 解析异常全部吞掉并返回 null，流式协议里单帧无效属常态
// 返回未知类型交由下游做结构收窄，这里不做形状校验
// 不记录解析失败日志，避免逐帧日志淹没真正错误
function safeParseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

// `buildMetrics` 是速率指标的唯一定义处：同一数值不允许多处按不同公式各算一遍。
// 分桶在 `buildMetrics` 构建时就已完成：原始 `TimedCharEvent` 不进快照。
// `durationMs` 为 0 时速率直接记为 0，不走除法。
function buildMetrics(input: {
  charEvents: TimedCharEvent[];
  durationMs: number;
  firstByteMs: number | null;
  firstTokenMs: number | null;
  outputChars: number;
  rawSseChars: number;
  sseEvents: number;
}): RunMetrics {
  return {
    charsPerSecond: input.durationMs > 0 ? (input.outputChars / input.durationMs) * 1000 : 0,
    durationMs: roundMs(input.durationMs),
    firstByteMs: input.firstByteMs === null ? null : roundMs(input.firstByteMs),
    firstTokenMs: input.firstTokenMs === null ? null : roundMs(input.firstTokenMs),
    frames: {
      "60": buildFrameScenario(60, input.durationMs, input.charEvents),
      "120": buildFrameScenario(120, input.durationMs, input.charEvents),
    },
    outputChars: input.outputChars,
    rawSseChars: input.rawSseChars,
    sseEvents: input.sseEvents,
  };
}

// [权衡] 以入参 run 展开为基底，只覆盖状态与产物三类字段
// 三个文件路径统一换算，确保桌面与 Web 端拿到同一种相对形式
// completedAt 与 error 显式允许 null，状态机据此判断终态
function buildRunSnapshot(
  input: ExecuteRunInput,
  runDir: string,
  result: Pick<RunSummary, "metrics" | "outputPreview" | "status"> & {
    completedAt?: string | null;
    error?: string | null;
  },
): RunSummary {
  return {
    ...input.run,
    completedAt: result.completedAt ?? null,
    error: result.error ?? null,
    files: {
      raw: toDataRelativePath(input.packageRoot, join(runDir, "raw.ndjson")),
      responseText: toDataRelativePath(input.packageRoot, join(runDir, "response.txt")),
      summary: toDataRelativePath(input.packageRoot, join(runDir, "summary.json")),
    },
    metrics: result.metrics,
    outputPreview: result.outputPreview,
    status: result.status,
  };
}

// 统一一位小数，避免浮点长尾让相同输入产生不同持久化结果
// 只用于对外指标，内部比较仍使用原始数值
function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}
