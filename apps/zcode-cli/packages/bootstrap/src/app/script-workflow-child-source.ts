// ============================================================
// 脚本 workflow 的子进程入口源码（以字符串形式 spawn 到独立 Node 进程）
// ============================================================
// 通信协议：argv 最后一项是 base64url 的 payload（args / budgetTotal）；stdout 只走 JSONL
// 消息（event / request / response），stderr 专用 Console 承接用户 console.*，不污染协议。
// 子进程不 import 宿主模块，只暴露全局 DSL：agent / parallel / pipeline / phase / log /
// workflow / args / budget。agent 的 callPath 由 AsyncLocalStorage 中的 path + 自增序号生成，
// 保证并行分支的同名调用可区分；parallel / pipeline 单项失败返回 null 而不是拖垮整批。
// 禁止无参 new Date() 与 Date.now()，让脚本重放 / 缓存判定不依赖墙钟。宿主侧通过
// callParent 的 request/response 配对驱动真正的模型调用、工具执行与子工作流。
export const SCRIPT_WORKFLOW_CHILD_SOURCE = String.raw`
import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import { Console } from "node:console";

const nodeProcess = process;
const payload = JSON.parse(Buffer.from(nodeProcess.argv.at(-1), "base64url").toString("utf8"));
const stderrConsole = new Console({ stdout: nodeProcess.stderr, stderr: nodeProcess.stderr });
globalThis.console = stderrConsole;

let nextRequestId = 0;
let currentPhase;
let spentTokens = 0;
const pending = new Map();
const contextStore = new AsyncLocalStorage();
const rootContext = { nextAgent: 0, nextBlock: 0, path: "root" };

const reader = createInterface({ input: nodeProcess.stdin });
reader.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    stderrConsole.error("Invalid workflow runner response", error);
    return;
  }
  if (message.kind !== "response") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(new Error(message.error || "Workflow runner request failed"));
});

function send(message) {
  nodeProcess.stdout.write(JSON.stringify(message) + "\n");
}

function notify(type, payloadValue) {
  send({ kind: "event", type, payload: payloadValue });
}

function callParent(type, payloadValue) {
  const id = "req_" + ++nextRequestId;
  send({ id, kind: "request", payload: payloadValue, type });
  return new Promise((resolve, reject) => {
    pending.set(id, { reject, resolve });
  });
}

function currentContext() {
  return contextStore.getStore() || rootContext;
}

function childContext(parent, label) {
  return { nextAgent: 0, nextBlock: 0, path: parent.path + "/" + label };
}

function nextBlockLabel(kind) {
  const context = currentContext();
  const index = context.nextBlock++;
  return kind + index;
}

globalThis.agent = async function agent(prompt, opts) {
  const context = currentContext();
  const callPath = context.path + "/agent" + context.nextAgent++;
  const result = await callParent("agent", {
    callPath,
    opts,
    phase: opts?.phase || currentPhase,
    prompt,
  });
  spentTokens += Number(result?.stats?.tokens?.total || 0);
  return result?.value;
};

globalThis.parallel = async function parallel(thunks) {
  if (!Array.isArray(thunks)) throw new Error("parallel() expects an array of thunks");
  const parent = currentContext();
  const block = nextBlockLabel("parallel");
  return Promise.all(
    thunks.map((thunk, index) =>
      contextStore
        .run(childContext(parent, block + "/item" + index), async () => thunk())
        .catch(() => null),
    ),
  );
};

globalThis.pipeline = async function pipeline(items, ...stages) {
  if (!Array.isArray(items)) throw new Error("pipeline() expects an array of items");
  const parent = currentContext();
  const block = nextBlockLabel("pipeline");
  return Promise.all(
    items.map((item, index) =>
      contextStore
        .run(childContext(parent, block + "/item" + index), async () => {
          let previous = item;
          for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
            const stage = stages[stageIndex];
            previous = await contextStore.run(
              childContext(currentContext(), "stage" + stageIndex),
              async () => stage(previous, item, index),
            );
          }
          return previous;
        })
        .catch(() => null),
    ),
  );
};

globalThis.log = function log(message) {
  notify("log", { message: String(message), phase: currentPhase });
};

globalThis.phase = function phase(title) {
  currentPhase = String(title);
  notify("phase", { title: currentPhase });
};

globalThis.workflow = async function workflow(nameOrRef, args) {
  return callParent("workflow", { args, nameOrRef });
};

globalThis.args = payload.args;
globalThis.budget = {
  total: payload.budgetTotal ?? null,
  spent() {
    return spentTokens;
  },
  remaining() {
    if (payload.budgetTotal === undefined || payload.budgetTotal === null) return Infinity;
    return Math.max(0, payload.budgetTotal - spentTokens);
  },
};

const NativeDate = Date;
class WorkflowDate extends NativeDate {
  constructor(...args) {
    if (args.length === 0) throw new Error("argless new Date() is disabled in workflows");
    super(...args);
  }
  static now() {
    throw new Error("Date.now() is disabled in workflows");
  }
  static parse(value) {
    return NativeDate.parse(value);
  }
  static UTC(...args) {
    return NativeDate.UTC(...args);
  }
}
globalThis.Date = WorkflowDate;
Math.random = function random() {
  throw new Error("Math.random() is disabled in workflows");
};

Object.defineProperty(globalThis, "process", {
  configurable: false,
  value: undefined,
  writable: false,
});

try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "workflow",
    payload.scriptBody,
  );
  const value = await contextStore.run(rootContext, async () =>
    run(agent, parallel, pipeline, phase, log, args, budget, workflow),
  );
  send({ kind: "complete", ok: true, value });
  reader.close();
} catch (error) {
  send({
    error: error instanceof Error ? error.message : String(error),
    kind: "complete",
    ok: false,
    stack: error instanceof Error ? error.stack : undefined,
  });
  reader.close();
}
`;
