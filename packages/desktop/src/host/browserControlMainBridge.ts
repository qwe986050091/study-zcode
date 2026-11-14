// INV-01 requestId 是唯一关联键：守住位置 pending 映射；改错故障 结果交给错误调用方。
// INV-02 重复 requestId 必须拒绝：守住位置 transport 之前；改错故障 旧等待被新请求覆盖。
// INV-03 删除只走条件删除：守住位置 deletePendingIfCurrent；改错故障 旧定时器删掉新请求。
// INV-04 校验先于发送：守住位置 execute 前置；改错故障 失败请求仍产生副作用。
// INV-05 代际不符按不可用：守住位置 第二个校验；改错故障 旧 Host 命令打向新 browser。
// INV-06 clientMode 每次透传：守住位置 消息体；改错故障 连续模式退化成单次模式。
// INV-07 超时预算按命令放大：守住位置 requestTimeoutMs；改错故障 长等待被提前判超时。
// INV-08 超时后反发取消：守住位置 定时器回调；改错故障 远端动作继续执行而调用方已放弃。
// INV-09 副作用不确定要标注：守住位置 mayHaveSideEffects；改错故障 超时谎报无副作用。
// INV-10 所有分支都 resolve：守住位置 execute；改错故障 调用方 await 永久挂起。
// INV-11 发送失败清账并结算：守住位置 catch；改错故障 pending 泄漏且定时器仍在跑。
// INV-12 迟到结果直接忽略：守住位置 handleResult 首判；改错故障 已超时请求被二次结算。
// INV-13 落盘先于回传：守住位置 录制分支；改错故障 调用方拿到模板路径而非实体文件。
// INV-14 无落盘口时剥临时路径：守住位置 分支；改错故障 桌面临时路径泄露给调用方。
// INV-15 落盘失败转执行错误：守住位置 catch；改错故障 异常穿透导致消息分派中断。
// INV-16 dispose 逐个结算：守住位置 循环；改错故障 等待中的调用永久悬空。
// INV-17 dispose 不清外部监听：守住位置 注释与实现；改错故障 结果分派被摘除。
// INV-18 描述符只列可选能力：守住位置 capability 列表；改错故障 核心 API 被伪装成可选。
//
// 模块职责：在 host 侧把浏览器命令转发给 main，并关联回传结果。
// 状态所有权：pending 映射与固定 browserId、generation 归桥实例。
// 阅读顺序：先看类型与默认预算，再看 execute，最后看 handleResult 与 dispose。
// host↔main 浏览器控制桥。
//
// 职责：Host 侧把 BrowserCommand 经 parentPort 发给 main（WebContentsView + CDP 执行），
// 以 requestId 关联回传结果；同时承担录制产物的二次落盘（materializeRecording）。
// 输入输出：createBrowserControlMainBridge 返回 BrowserControlMainBridge（list/execute/
// handleResult/dispose）；execute 输出 BrowserCommandResult，任何失败都包装成结果对象而非抛错。
// 副作用：postMessage 到 main；登记 pending 与 setTimeout；在结果回传时可能写工作区文件。
// 失败语义：浏览器 backend 不可用 / requestId 重复 / 传输失败 / 超时 / 录制落盘失败都返回
// ok=false 的具体错误码；有副作用的命令超时标记 sideEffect=uncertain，不得谎报 none。
// 维护的不变量：#18 中 clientMode 必须随每次请求透传给 main（默认 desktop-continuous），
// browserGeneration 随 bridge 实例固化，旧 generation 的请求一律 backend_unavailable。

import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";
import type {
  BrowserBackendDescriptor,
  BrowserClientMode,
  BrowserCommand,
  BrowserCommandResult,
  BrowserRecordingArtifact,
} from "@zcode/shared";

/**
 * host↔main browser 执行桥。host 侧把一条命令经 parentPort 发给 main（WebContentsView+CDP 执行），
 * 按 requestId 关联回传结果。仿 createFullFeedbackLogArchiveViaMain 的 pending map 模式。
 *
 * 设计成可注入 postMessage + 无全局依赖，便于单测（假 parentPort）。
 */

export interface BrowserExecuteRequestMessage {
  type: typeof HostResponseTypes.BrowserExecuteRequest;
  requestId: string;
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
  sessionContext: "live" | "cached";
  command: BrowserCommand;
}

export interface BrowserExecuteResultMessage {
  requestId: string;
  result: BrowserCommandResult;
}

interface PendingEntry {
  resolve: (result: BrowserCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
  method: BrowserCommand["method"];
  startedAt: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  outputPath?: string;
}

/**
 * host→main browser 子命令预算。外层 node_repl MCP 工具默认 60s；这里保留 30s，给 JS
 * 收尾、图片归一化和结构化错误返回留下余量，不能让两层 deadline 同时竞争。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

// 判断命令是否可能产生不可回滚的外部副作用（用于超时场景的 sideEffect 口径）。
// 只做「保守认定」：列出的方法一律视为有副作用；locator 组合命令按 operation 细分，
// 读类操作（如 innerText/screenshot）不进入副作用集合。漏判比误判更危险，因此宁可多判。
function mayHaveSideEffects(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "finalize",
    "newTab",
  ].includes(command.method);
}

// BrowserControlMainBridge 由 desktop host 实现，renderer 只能经这层触达浏览器能力。
// list 返回固定的 IAB backend 描述符；execute 是唯一命令入口（失败以结果对象表达）；
// handleResult 由 Host 消息分派在收到 main 回包时调用；dispose 取消所有等待中的请求。
// execute 的可选参数会补默认值：workspaceKey 回落 sessionId，workspacePath 回落
// workspaceKey，clientMode 回落 desktop-continuous（#18 的显式默认）。
export interface BrowserControlMainBridge {
  list(): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId?: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode?: BrowserClientMode;
    sessionContext?: "live" | "cached";
    command: BrowserCommand;
  }): Promise<BrowserCommandResult>;
  /** main 回传结果时由 host 消息分派调用。 */
  handleResult(message: BrowserExecuteResultMessage): Promise<void>;
  dispose(): void;
}

// createBrowserControlMainBridge 用 postToMain、timeoutMs 与 materializeRecording 构造桥。
// 状态：pending（requestId → 结果 promise + timer + 落盘上下文）、固定 browserId
//（iab:<uuid>）与 browserGeneration（创建时刻），保证桥实例即一代 backend。
// 输入：postToMain、可选 timeoutMs 与 materializeRecording；两者可注入以便单测。
// 输出：BrowserControlMainBridge；dispose 后一般不应再发新命令。
// 失败语义：transport 抛错会立刻清理 pending 并 resolve backend_unavailable，不会挂起。
// 维护的不变量：pending 中同一 requestId 唯一，且所有删除路径都走 deletePendingIfCurrent，
// 防止旧 timer 误删后来登记的请求。
export function createBrowserControlMainBridge(deps: {
  postToMain: (message: BrowserExecuteRequestMessage) => void;
  timeoutMs?: number;
  materializeRecording?(input: {
    artifact: BrowserRecordingArtifact;
    localPath: string;
    outputPath: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<BrowserRecordingArtifact>;
// pending 以请求标识为键。
// 实例创建即固定 browserId。
// generation 取创建时刻。
// deletePendingIfCurrent 先比对 entry 引用再 delete，避免误删后继请求。
// capabilities.browser 只列 optional capability，不混入 core API。
// pageAssets 与 cdp 未实现，因此不出现在 capability 列表。
}): BrowserControlMainBridge {
  const pending = new Map<string, PendingEntry>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const browserId = `iab:${randomUUID()}`;
  const browserGeneration = Date.now();
  const deletePendingIfCurrent = (requestId: string, entry: PendingEntry): boolean => {
    if (pending.get(requestId) !== entry) return false;
    pending.delete(requestId);
    return true;
  };
  const descriptor: BrowserBackendDescriptor = {
    id: browserId,
    generation: browserGeneration,
    type: "iab",
    name: "ZCode In-app Browser",
    capabilities: {
      // capability collection 只列 optional capability；tabs/cua/screenshot/dialog 是 core API，
      // 不能伪装成 capability。viewport 是 Playwright-like Tab 核心 API；browser capability
      // 当前只保留 visibility，pageAssets/cdp 未实现不暴露。
      browser: [
        {
          id: "visibility",
          description:
            "Use to show or hide the browser to the user, and to determine the browser's current visibility. Keep browser work in the background unless the user asks to see it or live viewing is useful. When the browser should be visible, call set(true).",
        },
      ],
      tab: [],
    },
    apiSupportOverrides: {
      "BrowserUser.claimTab": true,
      "Tabs.finalize": true,
      "Tab.markDeliverable": true,
      "Tab.markHandoff": true,
      "BrowserRecordingAPI.start": true,
      "BrowserRecordingAPI.status": true,
      "BrowserRecordingAPI.cancel": true,
    },
    metadata: {
      provider: "zcode-desktop-iab",
    },
  };

  return {
    // 列出可用 backend：本桥只对应一个 IAB backend，因此固定返回单元素。
    // 描述符的 generation 与 browserId 必须与 execute 校验时使用的一致。
    async list(): Promise<BrowserBackendDescriptor[]> {
      return [descriptor];
    },

    // 执行一条浏览器命令并等待 main 回传。
    // 前置校验顺序：browserId → browserGeneration → requestId 唯一性，全部在 postToMain 之前
    // 完成，保证失败时没有副作用；任一不匹配直接返回错误结果。
    // 超时预算按命令类型放大（waitForTimeout / playwright 自带 timeoutMs + 2s transport 余量），
    // 否则 host 侧会先于 main 的合法长等待判超时。
    // 失败语义：超时 → timeout（副作用不确定时 uncertain）并反向发送 cancelRequest；
    // transport 异常 → backend_unavailable。所有分支都 resolve，不 reject。
    async execute({
      requestId: inputRequestId,
      browserId: requestedBrowserId,
      browserGeneration: requestedBrowserGeneration,
      sessionId,
      turnId,
      workspaceKey = sessionId,
      workspacePath = workspaceKey,
      workspaceIdentity,
      remoteSessionId,
      clientMode = "desktop-continuous",
      sessionContext = "live",
      command,
    }): Promise<BrowserCommandResult> {
      if (requestedBrowserId && requestedBrowserId !== browserId) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${requestedBrowserId}' is no longer available`,
          },
          elapsedMs: 0,
        };
      }
      if (
        requestedBrowserGeneration !== undefined &&
        requestedBrowserGeneration !== browserGeneration
      ) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${browserId}' generation ${requestedBrowserGeneration} is stale`,
          },
          elapsedMs: 0,
        };
      }
      // input.requestId 缺省时由 randomUUID 生成 requestId。
      // pending.has(requestId) 为真时在 transport 前返回 duplicate_request_id。
      // 该错误的 sideEffect 明确标注 "none"。
      // requestId 校验排在 transport 调用之前，失败不落远端。
      // 校验通过后才记录 startedAt。
      const requestId = inputRequestId ?? randomUUID();
      if (pending.has(requestId)) {
        // requestId 是结果与 Promise 的 correlation key。覆盖同 key entry
        // 会把旧结果交给新 Promise，并让旧 timer/finally 删除新请求。必须在 transport 前失败。
        return {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        };
      }
      const startedAt = Date.now();
      // 固定等待的 transport budget 为请求时长加 2 秒，覆盖等待本身和传输开销。
      // 否则 waitForTimeout(>=30s) 会在 timer 正常完成前被 host bridge 误判超时。
      // playwrightWaitForTimeout 的预算额外加 2_000 ms transport 余量。
      // playwright 命令按 action.timeoutMs 或 timeoutMs 计算。
      // 其余命令直接用桥默认 timeoutMs。
      // 两层各加 2_000 ms，避免 timer 与 host 同时到期。
      // requestTimeoutMs 只影响本地等待，不改远端执行。
      const requestTimeoutMs =
        command.method === "playwrightWaitForTimeout"
          ? command.timeoutMs + 2_000
          : command.method === "playwright"
            ? ("timeoutMs" in command.action
                ? (command.action.timeoutMs ?? timeoutMs)
                : timeoutMs) + 2_000
            : timeoutMs;
      return await new Promise<BrowserCommandResult>((resolve) => {
        let entry: PendingEntry;
        // timeout 回调先调用 deletePendingIfCurrent 条件删除。
        // pending.delete 成功后再反向发送取消命令。
        // 取消发送失败只记录，不覆盖既有超时结果。
        // sideEffect 按命令是否只读保守判定。
        // 结果始终 resolve 不 reject。
        const timer = setTimeout(() => {
          // 只允许当前 entry 结算自己的生命周期；防止未来新增路径重新引入同 key 覆盖后，
          // 旧 timer 删除或取消后来登记的请求。
          if (!deletePendingIfCurrent(requestId, entry)) return;
          // 过去 host 只结束本地等待，main/backend 中的动作仍会继续执行，调用方却已
          // 收到 timeout。现在用同一 scope 发送反向 cancel；动作是否已经下发无法证明时，
          // 必须按操作结果契约标记 uncertain，不能谎报成无副作用超时。
          const cancelRequestId = randomUUID();
          try {
            deps.postToMain({
              type: HostResponseTypes.BrowserExecuteRequest,
              requestId: cancelRequestId,
              browserId,
              browserGeneration,
              sessionId,
              turnId,
              workspaceKey,
              workspacePath,
              workspaceIdentity,
              remoteSessionId,
              clientMode,
              sessionContext,
              command: { method: "cancelRequest", requestId },
            });
          } catch {
            // 原请求已经超时；cancel transport 失败不会覆盖更有用的 timeout 结果。
          }
          resolve({
            ok: false,
            error: {
              code: "timeout",
              message: `browser 命令 ${command.method} 超时（${requestTimeoutMs}ms）`,
              sideEffect: mayHaveSideEffects(command) ? "uncertain" : "none",
            },
            elapsedMs: Date.now() - startedAt,
          });
        }, requestTimeoutMs);
        entry = {
          resolve,
          timer,
          method: command.method,
          startedAt,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...(command.method === "recordingStatus" && command.outputPath
            ? { outputPath: command.outputPath }
            : {}),
        };
        pending.set(requestId, entry);
        try {
          deps.postToMain({
            type: HostResponseTypes.BrowserExecuteRequest,
            requestId,
            browserId,
            browserGeneration,
            sessionId,
            turnId,
            workspaceKey,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            clientMode,
            sessionContext,
            command,
          });
        } catch (error) {
          clearTimeout(timer);
          deletePendingIfCurrent(requestId, entry);
          resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: Date.now() - startedAt,
          });
        }
      });
    },

    // 消费 main 回传结果：清理 pending/timer 后 resolve 原 promise。
    // 录制完成且有 outputPath 时先 materialize 再回传（替换 artifact.path）；没有 outputPath
    // 则剥掉 main 的临时 artifact，避免把桌面临时路径泄漏给调用方。
    // 失败语义：迟到结果（pending 已清）直接忽略；materialize 失败转 execution_error；
    // 缺少 materializeRecording 时转 backend_unavailable，均不抛出。
    async handleResult(message): Promise<void> {
      const entry = pending.get(message.requestId);
      if (!entry) {
        // 迟到结果（已超时清理）——忽略。
        return;
      }
      clearTimeout(entry.timer);
      if (!deletePendingIfCurrent(message.requestId, entry)) return;
      const artifact = message.result.recording?.artifact;
      if (
        message.result.ok &&
        message.result.recording?.status === "completed" &&
        artifact &&
        entry.outputPath
      ) {
        if (!deps.materializeRecording) {
          entry.resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser recording artifact materialization is unavailable",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
          return;
        }
        try {
          const materialized = await deps.materializeRecording({
            artifact,
            localPath: artifact.path,
            outputPath: entry.outputPath,
            workspacePath: entry.workspacePath,
            ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
            ...(entry.remoteSessionId ? { remoteSessionId: entry.remoteSessionId } : {}),
          });
          entry.resolve({
            ...message.result,
            recording: { ...message.result.recording, artifact: materialized },
          });
        } catch (error) {
          entry.resolve({
            ok: false,
            error: {
              code: "execution_error",
              message: error instanceof Error ? error.message : String(error),
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
        }
        return;
      }
      if (message.result.recording?.status === "completed" && artifact && !entry.outputPath) {
        const { artifact: _mainTemporaryArtifact, ...recording } = message.result.recording;
        entry.resolve({
          ...message.result,
          recording,
        });
        return;
      }
      entry.resolve(message.result);
    },

    // 销毁桥：逐个结算 pending，返回 backend_unavailable 且 sideEffect=uncertain
    //（命令可能已在 main 执行，无法证明未发生），防止调用方 Promise 永久悬空。
    // 不摘 parentPort 监听：结果消息由外部 Host 消息分派统一处理，此处只清自身账本。
    dispose(): void {
      for (const [requestId, entry] of pending) {
        if (!deletePendingIfCurrent(requestId, entry)) continue;
        clearTimeout(entry.timer);
        // 直接 clear map 会让所有正在 await 的调用永久悬空。bridge shutdown 必须
        // 结束 promise，并明确 backend 是否已执行不可判定。
        entry.resolve({
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser bridge disposed while command was pending",
            sideEffect: "uncertain",
          },
          elapsedMs: Date.now() - entry.startedAt,
        });
      }
    },
  };
}
