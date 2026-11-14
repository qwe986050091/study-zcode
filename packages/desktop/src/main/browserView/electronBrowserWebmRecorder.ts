/* eslint-disable max-lines -- Electron capture authority、renderer 消息协议与文件清理属于同一个录制事务，拆开会让 abort/close 状态跨模块竞态。 */
// ==========================================================================
// electronBrowserWebmRecorder —— IAB 页面 WebM 录制器（Electron main 进程侧的会话外壳）
//
// 职责边界：
//   本文件只做一个录制事务：为单个 WebFrameMain 建立隐藏窗口 + 专用 session + MessagePort 信令，
//   把 renderer 侧 MediaRecorder 产出的 WebM 分片按序写入调用方给定的临时文件，并在
//   stop / cancel / abort / renderer 崩溃 / 页面销毁五条路径上必须回收窗口、session、端口、文件句柄与临时 HTML。
//   不负责音频采集、转码、录制文件的生命周期、项目会话状态；outputPath 与 AbortSignal 的所有权在调用方。
//
// INV 表（改本文件前先读；每条都在唯一位置生效，跨位置改动必须两处同时改）：
// INV-01 断言：一次录制会话只允许一个 MediaRecorder 所有权，start 信令只发一次 —— 守住它的位置：createElectronBrowserWebmRecorder 主链中 started deferred 与 start 信令发送处 —— 改错故障：重复 start 会派生第二条 captureStream，分片交错写入后 WebM 无法解码。
// INV-02 断言：ready/started/stopped 三个 deferred 只能由各自的 renderer 消息结算一次 —— 守住它的位置：deferred() 的 done 标志与 onPortMessage 的分支 —— 改错故障：重复结算会覆盖已到达的阶段结果，状态机停在错误的步骤上。
// INV-03 断言：cleanup 是唯一资源出口，并用 closed 标志做幂等 —— 守住它的位置：cleanup 开头的早返回 —— 改错故障：二次清理会重复关闭端口与窗口，或在 stop 与 abort 竞态下删掉另一条路径正在写的文件。
// INV-04 断言：停止与取消都必须释放 renderer 的 video track 与 canvas 派生流 —— 守住它的位置：renderer 内 stopTracks 及其在 stop/error/cancel 分支的调用 —— 改错故障：getDisplayMedia 的捕获轨道泄漏，下一次录制复用同一画面句柄或被系统直接拒绝授权。
// INV-05 断言：取消路径不等待 renderer 的 stopped 回执 —— 守住它的位置：recorder.cancel 只调用 cleanup(true) —— 改错故障：renderer 已崩溃时取消会挂满 15 秒超时，异常还会向上冒泡成清理失败。
// INV-06 断言：abort 先 fail 再 cleanup(true)，且 abort 监听器在 cleanup 中移除 —— 守住它的位置：onAbort 与 cleanup 里的 removeEventListener —— 改错故障：abort 之后再 stop 会进入已关闭会话，抛出的新错误覆盖原本的 AbortError。
// INV-07 断言：磁盘写入失败不中断录制，只在 stop 末尾上报 —— 守住它的位置：writeChain 的 catch 记录 writeError、stop 中抛出该错误 —— 改错故障：一次瞬时写入失败让已录内容不可用，或错误被静默吞掉、返回一个截断却显示成功的文件。
// INV-08 断言：所有分片经同一条 writeChain 串行落盘，顺序等于 dataavailable 顺序 —— 守住它的位置：onPortMessage 的 chunk 分支 —— 改错故障：并发写在同一 FileHandle 上交错，WebM 头部之后的簇顺序错乱。
// INV-09 断言：输出文件句柄必须在 writeChain 排空后才关闭 —— 守住它的位置：cleanup 中先 await writeChain 再关 fileHandle —— 改错故障：最后几个分片写入已关闭的句柄，片尾丢失或抛 EBADF。
// INV-10 断言：只放行录制窗口自己 mainFrame 的纯视频 display media 请求 —— 守住它的位置：setDisplayMediaRequestHandler 内的四项前置判断 —— 改错故障：录制器捕获到自身或其它 frame，画面递归套娃或混入音频破坏 MIME 约定。
// INV-11 断言：目标 frame 在会话建立时校验一次、在授权回调时再校验一次 —— 守住它的位置：asTargetFrame 与 handler 内的 isDestroyed/detached 判断 —— 改错故障：页面在握手期间销毁时把已释放的 WebFrameMain 交给 Chromium，主进程崩溃。
// INV-12 断言：临时 HTML 只承载信令脚本，CSP 限定 default-src 全关，以 0600 写入并及时删除 —— 守住它的位置：recorderHtml 的 meta 与 writeFile/rm 调用 —— 改错故障：本地页面获得网络或文件能力，或在磁盘残留可被复用的脚本。
//
// 阅读顺序：先看 createElectronBrowserWebmRecorder 的 try/catch 主链，再把 cleanup 当作唯一交汇点，最后回到 recorderHtml 内部的 renderer 状态机。
import { randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BrowserWindow,
  MessageChannelMain,
  session,
  type MessagePortMain,
  type Session,
  type WebFrameMain,
} from "electron";
import type {
  BrowserWebmRecorderFactoryInput,
  BrowserWebmRecorderFactory,
  BrowserWebmRecorderSession,
} from "./browserVideoRecorder.js";

// [契约] 通道名是 renderer 与 main 之间唯一的握手令牌：renderer 只在 window message 的数据等于该串时接管端口。
// 主进程用同一个字符串把 rendererPort 转移进去；任意一侧改名，表现都是录制器无响应而非显式报错。
// [权衡] 两个 15 秒超时是失败路径的终点而不是重试起点——超时后只能由调用方 cleanup 并重建整个会话。
const RECORDER_PORT_CHANNEL = "zcode-browser-video-recorder:port";
const RECORDER_START_TIMEOUT_MS = 15_000;
const RECORDER_STOP_TIMEOUT_MS = 15_000;

// [契约] 这里是 renderer → main 的完整上行协议，字段名与 recorderHtml 内的上行消息一一对应。
// 新增类型必须先在此列出，否则 onPortMessage 的类型守卫会放行一个无人处理的值，表现为静默丢消息。
// 下行只有 start/stop/cancel 三种，且全部由主进程单向发起；不存在 renderer 主动询问状态的请求。
type RecorderRendererMessage =
  | { type: "ready" }
  | { type: "started"; mimeType?: unknown }
  | { type: "chunk"; data?: unknown }
  | { type: "stopped" }
  | { type: "cancelled" }
  | { type: "diagnostic"; message?: unknown }
  | { type: "error"; message?: unknown };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

// [并发] 单个 deferred 只结算一次：done 在 resolve/reject 之前置位，避免 stop 与 abort 同时到达时二次结算。
// [失败路径] 预挂 catch 是让尚未进入该阶段的 deferred 在被 fail 提前 reject 时不触发 unhandledRejection；
// 真正的 await 仍会拿到原始错误，因此这个 catch 不改变任何调用方的观测结果。
// [契约] 结算之后再调用 resolve 或 reject 都是空操作，这让任意路径都能无条件对全部阶段广播同一个错误。
function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let done = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // 某个阶段提前失败时，后续阶段 deferred 仍会被 reject；预挂 catch 防止未进入该阶段的
  // Promise 触发 unhandled rejection，真正的 await 仍会收到原始 rejection。
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: (value) => {
      if (done) return;
      done = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (done) return;
      done = true;
      rejectPromise(error);
    },
  };
}

function recorderError(message: string): Error {
  return new Error(`Electron WebM recorder failed: ${message}`);
}

function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(recorderError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toChunkBuffer(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.isBuffer(value) ? value : null;
}

// [契约] 返回的 HTML 就是 renderer 侧录制状态机本体，与上方常量、下方 preload 注入路径必须保持一致。
// 脚本只做三件事：建 MediaRecorder、把分片转成 ArrayBuffer 后经端口上行、在终态后必须停轨道并移除隐藏 video 与 canvas。
// [权衡] 内联脚本换取不额外打包 renderer bundle，代价是 CSP 必须放开 script-src 的 unsafe-inline，其余来源全部关闭。
// [事务] 页面一旦加载完成即可删除，因为脚本已进入渲染进程；临时文件只服务于这一次加载。
function recorderHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
  </head>
  <body>
    <script>
      (() => {
        const channel = ${JSON.stringify(RECORDER_PORT_CHANNEL)};
        let mediaRecorder = null;
        let mediaStream = null;
        let recordingStream = null;
        let sourceVideo = null;
        let recordingCanvas = null;
        let drawTimer = null;
        let chunkQueue = Promise.resolve();
        let cancelling = false;

        const messageText = (error) => error instanceof Error ? error.message : String(error);
        const stopTracks = () => {
          for (const track of mediaStream?.getTracks?.() ?? []) track.stop();
          for (const track of recordingStream?.getTracks?.() ?? []) track.stop();
          mediaStream = null;
          recordingStream = null;
          if (drawTimer !== null) clearInterval(drawTimer);
          drawTimer = null;
          sourceVideo?.remove();
          recordingCanvas?.remove();
          sourceVideo = null;
          recordingCanvas = null;
        };

        window.addEventListener("message", (event) => {
          if (event.source !== window || event.data !== channel) return;
          const port = event.ports[0];
          if (!port) return;
          port.onmessage = async ({ data }) => {
            if (data?.type === "start") {
              try {
                const candidates = ["video/webm;codecs=vp8", "video/webm"];
                const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
                if (!mimeType) throw new Error("Chromium does not support VP8 WebM MediaRecorder");
                const fps = Number(data.fps) || 25;
                const width = Number(data.width);
                const height = Number(data.height);
                if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
                  throw new Error("invalid recorder viewport");
                }
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                  video: { frameRate: fps },
                  audio: false,
                });
                const [videoTrack] = mediaStream.getVideoTracks();
                port.postMessage({
                  type: "diagnostic",
                  message: "track=" + JSON.stringify({
                    active: mediaStream.active,
                    muted: videoTrack?.muted,
                    readyState: videoTrack?.readyState,
                    settings: videoTrack?.getSettings?.(),
                  }),
                });
                videoTrack?.addEventListener("mute", () => port.postMessage({ type: "diagnostic", message: "track muted" }));
                videoTrack?.addEventListener("unmute", () => port.postMessage({ type: "diagnostic", message: "track unmuted" }));
                videoTrack?.addEventListener("ended", () => port.postMessage({ type: "diagnostic", message: "track ended" }));
                sourceVideo = document.createElement("video");
                sourceVideo.muted = true;
                sourceVideo.playsInline = true;
                sourceVideo.srcObject = mediaStream;
                sourceVideo.style.position = "fixed";
                sourceVideo.style.opacity = "0";
                document.body.append(sourceVideo);
                await sourceVideo.play();

                recordingCanvas = document.createElement("canvas");
                recordingCanvas.width = width;
                recordingCanvas.height = height;
                const context = recordingCanvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("2D canvas recorder is unavailable");
                const drawFrame = () => context.drawImage(sourceVideo, 0, 0, width, height);
                drawFrame();
                drawTimer = setInterval(drawFrame, Math.max(1, Math.round(1000 / fps)));
                recordingStream = recordingCanvas.captureStream(fps);
                mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
                mediaRecorder.addEventListener("dataavailable", (chunkEvent) => {
                  port.postMessage({ type: "diagnostic", message: "dataavailable bytes=" + chunkEvent.data?.size });
                  if (!chunkEvent.data || chunkEvent.data.size === 0) return;
                  chunkQueue = chunkQueue.then(async () => {
                    const bytes = await chunkEvent.data.arrayBuffer();
                    // Bug 原因：DOM MessagePort → Electron MessagePortMain 对 ArrayBuffer transfer
                    // 在部分 Electron 平台会静默丢弃整条消息；让 structured clone 复制分片才能
                    // 保证 dataavailable 与后续 stopped 都按序抵达 main。
                    port.postMessage({ type: "chunk", data: bytes });
                  });
                });
                mediaRecorder.addEventListener("error", (recorderEvent) => {
                  port.postMessage({
                    type: "error",
                    message: messageText(recorderEvent.error ?? "MediaRecorder error"),
                  });
                });
                mediaRecorder.addEventListener("stop", async () => {
                  try {
                    await chunkQueue;
                    port.postMessage({ type: cancelling ? "cancelled" : "stopped" });
                  } catch (error) {
                    port.postMessage({ type: "error", message: messageText(error) });
                  } finally {
                    stopTracks();
                  }
                }, { once: true });
                mediaRecorder.start(1000);
                port.postMessage({ type: "started", mimeType: mediaRecorder.mimeType || mimeType });
              } catch (error) {
                stopTracks();
                port.postMessage({ type: "error", message: messageText(error) });
              }
              return;
            }
            if (data?.type === "stop") {
              if (mediaRecorder?.state === "recording" || mediaRecorder?.state === "paused") {
                mediaRecorder.stop();
              } else {
                port.postMessage({ type: "error", message: "MediaRecorder is not recording" });
              }
              return;
            }
            if (data?.type === "cancel") {
              cancelling = true;
              if (mediaRecorder?.state === "recording" || mediaRecorder?.state === "paused") {
                mediaRecorder.stop();
              } else {
                stopTracks();
                port.postMessage({ type: "cancelled" });
              }
            }
          };
          port.start();
          port.postMessage({ type: "ready" });
        }, { once: true });
      })();
    </script>
  </body>
</html>`;
}

// [契约] 入参取 unknown 而非 WebFrameMain，因为调用方来自工厂输入，类型断言不可信。
// [失败路径] 已销毁或 detached 的 frame 在会话建立阶段就抛错，而不是等到授权回调才失败，缩短泄漏窗口。
// [并发] 这只是快照校验；真正的竞态窗口在加载页面与授权回调之间，所以 handler 里必须再查一次。
function asTargetFrame(value: unknown): WebFrameMain {
  const frame = value as WebFrameMain | undefined;
  if (!frame || typeof frame.isDestroyed !== "function" || frame.isDestroyed() || frame.detached) {
    throw recorderError("target WebFrameMain is unavailable");
  }
  return frame;
}

// [资源] 关闭端口是幂等的：远端 renderer 先退出时关闭可能抛错，这里吞掉异常继续回收其它资源。
// [并发] 端口关闭后仍可能收到排队消息，因此清理顺序是先移除监听器再关闭，避免回调落到已关闭会话。
// [契约] 不区分端口属于 main 还是 renderer：两侧都必须在 cleanup 中关闭，否则消息队列会拖住进程退出。
function closePort(port: MessagePortMain): void {
  try {
    port.close();
  } catch {
    // 远端 renderer 已退出时 close 允许幂等失败。
  }
}

function closeWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.destroy();
}

// [资源] display media handler 挂在 session 上而不是窗口上，销毁窗口不会自动清掉，必须显式置空。
// [并发] session 可能随 renderer 一起销毁，置空调用可能抛错，这里按可恢复异常处理。
// [契约] 该 handler 没有其它调用方，清空即等价于解绑；任何新增注册都必须复用同一个 cleanup 出口。
function clearDisplayMediaHandler(recorderSession: Session): void {
  try {
    recorderSession.setDisplayMediaRequestHandler(null);
  } catch {
    // session 可能已随 renderer 销毁；handler 没有其它调用方。
  }
}

/**
 * 使用 Electron 自带 Chromium 捕获指定 IAB WebFrameMain，并把 MediaRecorder 的 WebM 分片
 * 顺序写入主进程临时文件。这里不启动外部进程，也不读取 PATH。
 */
// [契约] 工厂返回的会话只有 stop 与 cancel 两个方法，调用方不接触端口、窗口或文件句柄。
// [事务] 函数返回即代表录制已开始：ready 与 started 两次握手都在返回之前完成，否则整条链路已经回滚。
// [权衡] 用可选的 debug 回调而不是直接写日志，让 main 在不注入诊断时完全不产生逐分片输出。
export async function createElectronBrowserWebmRecorder(
  input: BrowserWebmRecorderFactoryInput,
  debug?: (message: string) => void,
): Promise<BrowserWebmRecorderSession> {
  // [失败路径] 入口先查 signal，避免为一个已经取消的请求创建窗口、session 和临时目录。
  // [契约] 抛出的 AbortError 与 onAbort 里的失败回调同类同文案，调用方可以用同一种方式识别取消。
  // [资源] 这一行之前不允许再分配需要回收的资源；mkdir 与文件路径生成都排在检查之后。
  if (input.signal.aborted) throw abortError();
  const targetFrame = asTargetFrame(input.targetFrame);
  await mkdir(dirname(input.outputPath), { recursive: true });
  const recorderDocumentPath = join(
    dirname(input.outputPath),
    `.${randomUUID()}-browser-video-recorder.html`,
  );

  // [资源] 每次录制必须使用独立 partition，与浏览器 IAB 的 session 隔离，录制器读不到目标页的 cookie 与存储。
  // [契约] 隐藏窗口尺寸取调用方 viewport，保证 canvas 与捕获流的采样比例和页面一致。
  // [权衡] 关闭 Node 集成、开启 sandbox 与上下文隔离，是让内联脚本无法触达 Node 的前提；preload 只做端口转发。
  const recorderSession = session.fromPartition(`zcode-browser-video-recorder-${randomUUID()}`);
  const recorderWindow = new BrowserWindow({
    show: false,
    width: Math.max(1, input.viewport.width),
    height: Math.max(1, input.viewport.height),
    webPreferences: {
      session: recorderSession,
      preload: join(import.meta.dirname, "../preload/browserVideoRecorder.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  recorderWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // [并发] main 保留一侧端口，另一侧在页面加载后转移给 renderer；转移前无法上行，因此顺序必须固定，不可调换。
  // [契约] closed 与 stopping 是两个独立标志：前者表示资源已回收，后者表示停止已被某个调用方认领。
  // [资源] 文件句柄 fileHandle 只在此处 open 一次，写队列与首个写入错误是分片落盘的全部状态。
  const { port1: mainPort, port2: rendererPort } = new MessageChannelMain();
  const ready = deferred<void>();
  const started = deferred<void>();
  const stopped = deferred<void>();
  let fileHandle: FileHandle | undefined;
  let writeError: unknown;
  let writeChain = Promise.resolve();
  let closed = false;
  let stopping = false;

  // [契约] 把同一个错误广播到三个阶段，任一仍在等待的调用方都会立刻失败，而不是各自等超时。
  // [并发] 由于 deferred 自带结算标志，重复广播不会覆盖已结算的阶段，也不会抛二次结算错误。
  // [失败路径] 非 Error 值在这里统一包装，保证向上抛出的始终是带模块前缀的可读错误。
  const fail = (error: unknown): void => {
    const normalized = error instanceof Error ? error : recorderError(String(error));
    ready.reject(normalized);
    started.reject(normalized);
    stopped.reject(normalized);
  };
  // [契约] 这是 main 侧的状态机入口：按消息类型分派，每个分支都必须推进或结算某个阶段。
  // [并发] onPortMessage 分派本身不做阻塞操作，避免逐分片消息把端口事件循环拖慢——写入一律转交写队列。
  // [失败路径] 未知类型被静默忽略而不是报错，因为 renderer 会上报仅供诊断的类型。
  const onPortMessage = (event: Electron.MessageEvent): void => {
    const message = event.data as RecorderRendererMessage | undefined;
    if (!message || typeof message.type !== "string") return;
    debug?.(`[browser-recording] recorder message type=${message.type}`);
    if (message.type === "ready") {
      ready.resolve();
      return;
    }
    if (message.type === "started") {
      if (message.mimeType !== "video/webm;codecs=vp8" && message.mimeType !== "video/webm") {
        fail(recorderError(`unexpected MediaRecorder MIME type: ${String(message.mimeType)}`));
        return;
      }
      started.resolve();
      return;
    }
    // [事务] 分片是唯一写入路径：先做类型归一与空值过滤，再把写入追加到队尾。
    // [并发] 串行化保证落盘顺序严格等于 dataavailable 顺序；单次写失败只记录首个错误，队列本身继续运行。
    // [失败路径] 写失败不终止会话，是为了让已录内容仍可交付；错误在停止末尾统一抛出，调用方据此判定文件不完整。
    // [契约] 空分片只打诊断，不能写文件，避免把零字节写入计入成功分片数。
    if (message.type === "chunk") {
      const buffer = toChunkBuffer(message.data);
      if (!buffer || buffer.byteLength === 0) {
        debug?.(
          `[browser-recording] ignored empty chunk value=${Object.prototype.toString.call(message.data)}`,
        );
        return;
      }
      debug?.(`[browser-recording] received WebM chunk bytes=${buffer.byteLength}`);
      writeChain = writeChain
        .then(async () => {
          if (!fileHandle) throw recorderError("output file is already closed");
          await fileHandle.write(buffer);
        })
        .catch((error: unknown) => {
          writeError ??= error;
        });
      return;
    }
    if (message.type === "stopped") {
      stopped.resolve();
      return;
    }
    if (message.type === "error") {
      fail(recorderError(typeof message.message === "string" ? message.message : "unknown error"));
      return;
    }
    if (message.type === "diagnostic") {
      debug?.(`[browser-recording] ${String(message.message ?? "")}`);
    }
  };
  // [并发] 先挂消息再挂关闭，最后启动端口：启动前排队的消息不会丢失，关闭也能覆盖握手期的异常断开。
  // [契约] 关闭事件只在尚未清理时视为异常；正常清理会先移除监听器并置位已关闭标志。
  // [失败路径] 端口意外关闭意味着 renderer 侧已不可用，广播失败让所有等待阶段立即失败而不是挂到超时。
  mainPort.on("message", onPortMessage);
  mainPort.on("close", () => {
    if (!closed) fail(recorderError("recorder MessagePort closed unexpectedly"));
  });
  mainPort.start();

  // [失败路径] renderer 进程崩溃是页面销毁的一种表现形式，必须让录制会话失败而不是继续等终态回执。
  // [并发] 与清理的已关闭标志共享同一判据：已经主动关闭的会话不再把随后的进程退出记为错误。
  // [资源] 这里只做失败通知，不直接回收——资源统一由 cleanup 处理，避免两条路径同时关闭端口。
  const onRendererGone = (_event: unknown, details: { reason?: string }): void => {
    if (!closed) fail(recorderError(`recorder renderer exited: ${details.reason ?? "unknown"}`));
  };
  recorderWindow.webContents.on("render-process-gone", onRendererGone);
  const onConsoleMessage = (
    _event: unknown,
    details: { level?: string; message?: string },
  ): void => {
    debug?.(
      `[browser-recording] recorder console level=${details.level ?? "unknown"} message=${details.message ?? ""}`,
    );
  };
  const recorderConsoleEvents = recorderWindow.webContents as unknown as {
    on(event: "console-message", listener: typeof onConsoleMessage): void;
    removeListener(event: "console-message", listener: typeof onConsoleMessage): void;
  };
  recorderConsoleEvents.on("console-message", onConsoleMessage);

  // [事务] cleanup 是全文件唯一的资源出口，开头的已关闭早返回保证停止、取消、失败回滚与销毁兜底不会重复执行。
  // [并发] 先移除 abort 监听器再发取消：否则清理期间新的 abort 会再次进入已关闭会话，与正在进行的回收竞态。
  // [资源] 顺序是取消 renderer、排空写入、关句柄、摘监听、关端口、清 handler、销毁窗口、删临时 HTML，每步都兜住已销毁对象。
  // [失败路径] 内部失败全部吞掉：清理是尽力而为的收尾，不应把第二个错误覆盖到调用方正在处理的原始错误上。
  const cleanup = async (cancel: boolean): Promise<void> => {
    if (closed) return;
    closed = true;
    input.signal.removeEventListener("abort", onAbort);
    if (cancel) {
      try {
        mainPort.postMessage({ type: "cancel" });
      } catch {
        // renderer/port 已销毁时继续回收 main 资源。
      }
    }
    await writeChain.catch(() => undefined);
    await fileHandle?.close().catch(() => undefined);
    fileHandle = undefined;
    mainPort.removeListener("message", onPortMessage);
    closePort(mainPort);
    closePort(rendererPort);
    clearDisplayMediaHandler(recorderSession);
    recorderWindow.webContents.removeListener("render-process-gone", onRendererGone);
    recorderConsoleEvents.removeListener("console-message", onConsoleMessage);
    closeWindow(recorderWindow);
    await rm(recorderDocumentPath, { force: true }).catch(() => undefined);
  };
  // [并发] 先广播失败再清理，顺序保证等待中的启动与停止立刻收到 AbortError，而不是先看到端口关闭。
  // [契约] once 选项与清理中的移除监听双重保证 abort 监听器不会随会话泄漏。
  const onAbort = (): void => {
    fail(abortError());
    void cleanup(true);
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  try {
    // [事务] 临时 HTML 以 0600 写入，仅当前用户可读；这是承载内联脚本页面的最低权限要求。
    // [契约] handler 只应答录制窗口自己的主 frame 且必须是纯视频请求；其余请求回调空对象，等价于拒绝。
    // [并发] handler 内复查已关闭标志与目标 frame 状态，覆盖页面加载到授权之间的销毁窗口。
    await writeFile(recorderDocumentPath, recorderHtml(), { encoding: "utf8", mode: 0o600 });
    recorderSession.setDisplayMediaRequestHandler((request, callback) => {
      if (
        closed ||
        request.frame !== recorderWindow.webContents.mainFrame ||
        !request.videoRequested ||
        request.audioRequested ||
        targetFrame.isDestroyed() ||
        targetFrame.detached
      ) {
        callback({});
        return;
      }
      callback({ video: targetFrame });
    });
    // [资源] 输出文件在加载页面前打开，保证后续任何分片都有句柄可写；打开失败会直接进入回滚。
    // [事务] 页面加载完成后立即删除临时 HTML，脚本已在渲染进程中，磁盘上不再需要这份文件。
    // [并发] 端口转移发生在页面加载之后：页面尚未加载时 renderer 不存在，提前发送会丢消息。
    fileHandle = await open(input.outputPath, "w");
    await recorderWindow.loadFile(recorderDocumentPath);
    await rm(recorderDocumentPath, { force: true }).catch(() => undefined);
    recorderWindow.webContents.postMessage(RECORDER_PORT_CHANNEL, null, [rendererPort]);
    await withTimeout(ready.promise, RECORDER_START_TIMEOUT_MS, "recorder renderer did not become ready");
    mainPort.postMessage({
      type: "start",
      fps: input.fps,
      width: input.viewport.width,
      height: input.viewport.height,
    });
    await withTimeout(started.promise, RECORDER_START_TIMEOUT_MS, "MediaRecorder did not start");
  } catch (error) {
    fail(error);
    await cleanup(true);
    throw error;
  }

  const recorder: BrowserWebmRecorderSession = {
    // [契约] 停止是唯一需要等待终态回执的路径：发停止、等回执、排空写入，最后抛出首个写错误。
    // [事务] finally 中无条件清理：无论停止成功、超时还是写入失败，窗口、端口、句柄与临时文件都必须回收。
    // [失败路径] 超时抛 recorderError 但回滚照常进行；调用方看到超时错误，文件保留已写入部分。
    stop: async () => {
      if (closed) throw recorderError("recorder is already closed");
      // [并发] 第二个停止调用不重复发信令，而是等待同一个终态阶段，实现停止的幂等合流。
      // [契约] 合流分支不执行清理，资源回收由第一个调用方的 finally 负责，避免双重关闭句柄。
      // [失败路径] 若首个停止已超时并完成清理，后到调用会在已关闭检查处抛错，而不是无限等待。
      if (stopping) {
        await withTimeout(stopped.promise, RECORDER_STOP_TIMEOUT_MS, "MediaRecorder did not stop");
        return;
      }
      stopping = true;
      mainPort.postMessage({ type: "stop" });
      try {
        await withTimeout(stopped.promise, RECORDER_STOP_TIMEOUT_MS, "MediaRecorder did not stop");
        await writeChain;
        if (writeError) throw writeError;
      } finally {
        await cleanup(false);
      }
    },
    // [契约] cancel 不做优雅停止：直接发取消并回收，已写入的分片保留在输出文件中。
    // [并发] 取消与停止的竞态由清理的已关闭标志裁决，先到者生效，后到者静默返回。
    // [失败路径] 清理开始前已入队的分片仍会写入，摘除监听之后到达的分片被丢弃，因此取消产出可能缺少片尾。
    cancel: () => cleanup(true),
  };
  return recorder;
}

// 保持标准 factory 类型出口，调用方不注入诊断时不会产生按分片日志。
export const defaultElectronBrowserWebmRecorder: BrowserWebmRecorderFactory =
  createElectronBrowserWebmRecorder;

