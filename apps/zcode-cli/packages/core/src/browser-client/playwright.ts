/* eslint-disable max-lines -- 与对外暴露的 Playwright 对象图一一对应，集中可避免 builder/终结操作契约漂移。 */

/**
 * Playwright 风格浏览器对象 API 的适配层：把 locator 链式调用翻译成 BrowserCommand，
 * 再经 transport 交给 host 侧真正执行。本文件不持有页面状态，owner 对象只用于校验同 tab。
 * 所有 builder 方法（locator/first/nth/filter 等）都是纯构造，不发命令、不产生副作用；
 * 只有终结操作（click/fill/count/evaluate 等）才会下发命令并可能改变页面。
 * 失败语义：命令失败统一经 expectOk 抛 BrowserCommandError；终结操作再用 withContext 补上
 * selector/操作名，便于模型定位是哪一步超时。对象经 Proxy 白名单包装，避免暴露内部符号。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 职责边界
// 本文件只做「Playwright 风格对象到浏览器命令」的翻译：把链式定位、等待与事件句柄
// 翻译成 host 侧可执行的命令，并把失败包装成带选择器上下文的错误。
// 不负责：浏览器进程启停、标签页创建与关闭、页面句柄生命周期、下载落盘、超时计时与重试，
// 这些能力全部由 host 侧的浏览器会话持有；本层任何状态都不得超过一次命令调用。
// INV 不变量（改动前先读，违反任意一条都会造成会话泄漏、串页或句柄悬挂）：
// INV-01 断言：链式构造方法只拼接选择器、不发送命令 —— 守住它的位置：派生对象与子元素构造 —— 改错故障：每次构造都触发一次浏览器往返，超时与并发翻倍，页面在构造期被意外滚动。
// INV-02 断言：终结操作一律经统一执行入口判错 —— 守住它的位置：命令执行与取值封装 —— 改错故障：失败被当作成功继续执行，页面崩溃后后续定位空等至超时。
// INV-03 断言：一个会话实例只绑定一个归属对象，跨归属组合被拒 —— 守住它的位置：组合前置校验 —— 改错故障：甲标签页的选择器拼进乙标签页，点击命中错误元素且不可复现。
// INV-04 断言：对外可见成员只能来自白名单表 —— 守住它的位置：默认对象包装器 —— 改错故障：内部执行器与归属字段泄漏给脚本，可绕过审批直接驱动浏览器。
// INV-05 断言：每次派生都必须重新套用包装 —— 守住它的位置：派生构造与 frame 派生 —— 改错故障：链式对象绕过白名单，缺口只出现在深链路径上极难发现。
// INV-06 断言：超时参数只透传，本层不自行计时、不重试 —— 守住它的位置：命令装配与各等待方法 —— 改错故障：两层超时叠加，一次点击阻塞数分钟，取消后句柄仍未释放。
// INV-07 断言：事件句柄只持有标识，不缓存路径或内容 —— 守住它的位置：下载句柄路径查询 —— 改错故障：返回下载未完成时的空路径，落盘任务覆盖用户文件。
// INV-08 断言：导航等待必须先注册再执行动作 —— 守住它的位置：并发导航等待 —— 改错故障：瞬时导航在注册前完成，等待悬挂至超时，页面已跳转却被判失败。
// INV-09 断言：错误必须保留原始原因，且消息只出现一次 —— 守住它的位置：错误上下文包装 —— 改错故障：堆栈整段拼接，工具结果里同一超时出现两遍，挤占模型上下文。
// INV-10 断言：文本匹配器必须用原生类型判定识别正则 —— 守住它的位置：匹配器序列化 —— 改错故障：跨 Realm 正则被误判而抛错，或非法对象拼进选择器造成空匹配。
// INV-11 断言：过滤条件拼接顺序固定 —— 守住它的位置：过滤条件装配 —— 改错故障：同参数生成不同选择器，缓存与重放测试全部失效。
// INV-12 断言：frame 链只拼接进入指令，不持有 frame 句柄 —— 守住它的位置：frame 作用域构建器 —— 改错故障：缓存句柄在导航后失效，后续定位全部落在已销毁文档上。
// INV-13 断言：有副作用的终结操作不承诺幂等 —— 守住它的位置：点击、填写、提交文件与页面求值 —— 改错故障：自动重试导致重复提交表单、重复上传文件。
// INV-14 断言：句柄用尽即由 host 侧回收，本层不留引用 —— 守住它的位置：事件等待返回处 —— 改错故障：文件选择监听未移除，下一次弹窗被旧句柄截获，界面卡在等待文件。
// ─────────────────────────────────────────────────────────────────────────────
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserMouseButton,
  BrowserPlaywrightAction,
  BrowserPlaywrightModifier,
} from "@zcode/contracts/browser-control";
import { isRegExp } from "node:util/types";
import { base64ToBytes, expectOk } from "./result.js";

type Run = (command: BrowserCommand) => Promise<BrowserCommandResult>;
type ObjectWrapper = <T extends object>(value: T, objectName: string) => T;
const locatorDetails = Symbol("zcode.playwright.locatorDetails");
const setObjectWrapper = Symbol("zcode.playwright.setObjectWrapper");
// 每个对外对象允许暴露的成员白名单：Proxied 对象只有列在这里的属性可读，
// 这样内部字段（run/owner/selector）与私有方法不会泄漏给 node_repl 里的脚本。
// 新增公开方法时必须同步登记，否则运行期会被 Proxy 直接返回 undefined。
// [契约] 白名单是对外可见性的唯一事实来源，不是可随手补的装饰表。
// 新增公开方法必须同时登记在这里，否则读取会得到空值，
// 看起来像「漏登记，顺手补上」就能修，实际会放宽既有对象图的暴露面，
// 让脚本读到内部状态并绕过审批下发命令。
// 改错后的线上表现：脚本能直接操作未审批的浏览器能力，审计里看不到入口。
const publicMembers: Record<string, ReadonlySet<string>> = {
  PlaywrightAPI: new Set([
    "domSnapshot",
    "elementInfo",
    "elementScreenshot",
    "evaluate",
    "expectNavigation",
    "frameLocator",
    "getByLabel",
    "getByPlaceholder",
    "getByRole",
    "getByTestId",
    "getByText",
    "locator",
    "waitForEvent",
    "waitForLoadState",
    "waitForTimeout",
    "waitForURL",
  ]),
  PlaywrightFrameLocator: new Set([
    "frameLocator",
    "getByLabel",
    "getByPlaceholder",
    "getByRole",
    "getByTestId",
    "getByText",
    "locator",
  ]),
  PlaywrightLocator: new Set([
    "all",
    "allTextContents",
    "and",
    "check",
    "click",
    "count",
    "dblclick",
    "downloadMedia",
    "evaluate",
    "fill",
    "filter",
    "first",
    "getAttribute",
    "getByLabel",
    "getByPlaceholder",
    "getByRole",
    "getByTestId",
    "getByText",
    "innerText",
    "isEnabled",
    "isVisible",
    "last",
    "locator",
    "nth",
    "or",
    "press",
    "selectOption",
    "setChecked",
    "textContent",
    "type",
    "uncheck",
    "waitFor",
  ]),
  PlaywrightDownload: new Set(["path"]),
  PlaywrightFileChooser: new Set(["isMultiple", "setFiles"]),
};

// 默认包装器：按白名单裁剪属性访问、has 判定与 ownKeys，函数成员绑定到原对象，
// 保证方法被解构后仍能正确访问私有状态。包装只做可见性收口，不改变对象行为。
// [契约] 包装只在读取、存在判断、枚举三个入口做裁剪，其余语义一律透传。
// 方法必须绑定到原对象，否则解构后私有执行器丢失，
// 终结操作会在下发前就抛错，看起来像 host 侧故障，实际是包装层的问题。
// 不要改成「只包装一层」：每个派生对象都要重新套 defaultObjectWrapper，缺一层等于没有白名单。
// 改错后的线上表现：链式对象泄漏归属字段，跨标签页组合的校验被绕过。
const defaultObjectWrapper: ObjectWrapper = <T extends object>(value: T, objectName: string): T =>
  new Proxy(value, {
    get(target, property) {
      if (typeof property === "string" && !publicMembers[objectName]?.has(property)) {
        return undefined;
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
    has(target, property) {
      if (typeof property === "string" && !publicMembers[objectName]?.has(property)) return false;
      return Reflect.has(target, property);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(
        (property) => typeof property !== "string" || publicMembers[objectName]?.has(property),
      );
    },
  });

// 文本匹配器：支持普通字符串与正则；正则来自独立 VM Realm，必须用 isRegExp 判定而非 instanceof。
// [权衡] 正则跨 VM Realm 传递，原型判定在这里不可靠，必须走原生类型判定。
// 改成鸭子类型判定会把普通对象误判为正则，拼出空匹配的选择器，
// 表现为「元素明明存在却一直等到超时」，排查成本极高。
export type TextMatcher = string | RegExp;
export type LoadState = "load" | "domcontentloaded" | "networkidle";
export type WaitUntil = LoadState | "commit";
export type WaitForState = "attached" | "detached" | "visible" | "hidden";
export type KeyboardModifier = BrowserPlaywrightModifier;

// 元素信息快照：命中坐标下的元素结构、可访问性名称、testId 与候选 selector。
// preview 是给人/模型看的短文本，selector.primary 可能为空，调用方需回退到 candidates。
export interface ElementInfo {
  nodeId?: number | null;
  tagName: string;
  role?: string | null;
  visibleText?: string | null;
  ariaName?: string | null;
  testId?: string | null;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  preview: string;
  selector: { primary?: string | null; candidates: string[]; frameSelectors?: string[] };
}

export type SelectOptionInput = string | { value?: string; label?: string; index?: number };

interface LocatorClickOptions {
  button?: BrowserMouseButton;
  force?: boolean;
  modifiers?: KeyboardModifier[];
  timeoutMs?: number;
}

interface LocatorCheckOptions {
  force?: boolean;
  timeoutMs?: number;
}

interface LocatorFilterOptions {
  has?: PlaywrightLocator;
  hasNot?: PlaywrightLocator;
  hasNotText?: TextMatcher;
  hasText?: TextMatcher;
  visible?: boolean;
}

// 命令构造与执行的最小封装：统一 method 字段，确保 host 侧按同一入口分发。
// [契约] 所有 playwright 分支共用同一 method 字段，host 侧按该入口统一分发。
// 若为某个 action 单独新开 method，超时、取消、审批与审计会绕开统一通道，
// 表现为个别操作不受会话级超时约束，取消后仍继续驱动页面。
function playwrightCommand(action: BrowserPlaywrightAction): BrowserCommand {
  return { method: "playwright", action };
}

// 下发命令并校验结果：expectOk 在非 ok 时抛错，因此返回结果必然带有可用 payload。
// 有副作用（驱动浏览器）；调用方不得假设命令幂等，重试需自行评估页面状态变化。
// [失败路径] 失败必须在这里统一转成异常，不能返回「带错误字段的结果」。
// 一旦允许下游自行判断，某个分支漏判就会把失败当成功继续操作，
// 页面已经崩溃时后续定位会一直等到超时，最终错误指向完全无关的选择器。
async function runAction(run: Run, action: BrowserPlaywrightAction): Promise<BrowserCommandResult> {
  const command = playwrightCommand(action);
  return expectOk(command, await run(command));
}

// 同上，但直接把 result.value 作为返回值；value 缺失时得到 undefined，由各方法自行兜底。
async function runValue<T>(run: Run, action: BrowserPlaywrightAction): Promise<T> {
  return (await runAction(run, action)).value as T;
}

// 在错误 message 后追加 selector/操作上下文，并保留原始错误为 cause。
// stack 只继承原 frames、不重复 message，避免 tool result 里同一个 timeout 出现两遍。
// [失败路径] 只继承原始堆栈的帧、不重复消息，这是刻意的取舍。
// 直接把整段堆栈拼接会让同一个超时在工具结果里出现两遍，挤占模型上下文，
// 关键的选择器上下文反而在截断时最先丢失。
function withContext(error: unknown, context: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${message}\n${context}`, { cause: error });
  if (error instanceof Error && error.stack) {
    // 把包含 message 的完整原始 stack 接到新 stack 后，tool result 会把同一个
    // timeout 输出两遍。只继承 stack frames，message 保留一次并通过 cause 保存原始错误。
    const frames = error.stack.split("\n").slice(1).join("\n");
    if (frames) wrapped.stack = `${wrapped.name}: ${wrapped.message}\n${frames}`;
  }
  return wrapped;
}

// 把 TextMatcher 序列化成 Playwright internal selector 里可用的字面量。
// 字符串加 s/i 后缀表示精确/忽略大小写；非字符串必须是真实 RegExp，否则抛错而非静默降级，
// 避免把非法对象拼进 selector 后出现难以定位的空匹配。
// [契约] 非法的匹配器必须立即抛错，不能静默降级成字符串匹配。
// 静默降级会把非法对象拼进 internal 选择器，host 侧解析失败或匹配到空集合，
// 表现成「操作成功但什么都没点中」，比直接报错更难定位。
function serializeMatcher(value: TextMatcher, exact: boolean, method: string): string {
  if (typeof value === "string") {
    const suffix = exact ? "s" : "i";
    return `${JSON.stringify(value)}${suffix}`;
  }
  // node_repl 在独立 VM Realm 中创建 matcher，跨 Realm 正则无法通过 instanceof。
  // 使用 Node 原生类型判定，既支持真实跨 Realm RegExp，也不会被 Symbol.toStringTag 冒充。
  if (isRegExp(value)) return value.toString();
  throw new Error(`${method} requires a string or RegExp`);
}

function roleSelector(role: string, options: { exact?: boolean; name?: TextMatcher }): string {
  if (!role) throw new Error("getByRole requires a role");
  const name =
    options.name === undefined
      ? ""
      : `[name=${serializeMatcher(options.name, Boolean(options.exact), "getByRole")}]`;
  return `internal:role=${role}${name}`;
}

function textSelector(text: TextMatcher, exact: boolean): string {
  return `internal:text=${serializeMatcher(text, exact, "getByText")}`;
}

function labelSelector(text: TextMatcher, exact: boolean): string {
  return `internal:label=${serializeMatcher(text, exact, "getByLabel")}`;
}

function placeholderSelector(text: TextMatcher, exact: boolean): string {
  return `internal:attr=[placeholder=${serializeMatcher(text, exact, "getByPlaceholder")}]`;
}

function testIdSelector(testId: string): string {
  if (!testId) throw new Error("getByTestId requires a testId");
  return `internal:testid=[data-testid=${JSON.stringify(testId)}s]`;
}

// 统一 evaluate 入参：字符串直接作为表达式下发，函数取 toString 交给 host 侧求值。
// 空串与非法类型都立即抛错，避免发送无意义命令浪费一次 turn。
// [权衡] 函数统一转成源码交给 host 求值，闭包变量不会随命令传递。
// 因此页面函数只能依赖入参与页面全局，捕获外部状态会在浏览器里得到空值，
// 表现为同一段脚本在本地跑得通、在页面里结果全为空。
function evaluateSource(
  method: "playwright.evaluate" | "locator.evaluate",
  pageFunction: string | ((...args: never[]) => unknown),
): { expression: string; expressionKind: "string" | "function" } {
  if (typeof pageFunction === "string") {
    if (!pageFunction) throw new Error(`${method} requires a pageFunction`);
    return { expression: pageFunction, expressionKind: "string" };
  }
  if (typeof pageFunction === "function") {
    return { expression: pageFunction.toString(), expressionKind: "function" };
  }
  throw new Error(`${method} requires a string or function`);
}

// 坐标必须为有限数值：NaN/Infinity 会让 host 侧命中判定失效，属于调用方错误，直接抛。
function validateCoordinates(method: string, options: { x: number; y: number }): void {
  if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) {
    throw new Error(`${method} requires numeric x and y coordinates`);
  }
}

// 规整 selectOption 入参：字符串视为按 value 选择，对象必须至少带 value/label/index 之一。
// 全部字段都做类型与范围校验，任何非法项整批拒绝，不做"跳过坏项"的部分成功。
// [失败路径] 任一选项非法就整批拒绝，不做部分成功。
// 部分成功会让下拉框停留在中间态，后续提交的数据与用户预期不一致，
// 调用方也拿不到「哪些被跳过」的信息，只能重试整批。
function normalizeSelections(input: SelectOptionInput | SelectOptionInput[]) {
  const values = Array.isArray(input) ? input : [input];
  if (values.length === 0) throw new Error("locator.selectOption requires at least one value");
  return values.map((selection) => {
    if (typeof selection === "string") return { value: selection };
    if (!selection || typeof selection !== "object") {
      throw new Error("locator.selectOption requires a string or { value?, label?, index? }");
    }
    if (selection.value !== undefined && typeof selection.value !== "string") {
      throw new Error("locator.selectOption value must be a string");
    }
    if (selection.label !== undefined && typeof selection.label !== "string") {
      throw new Error("locator.selectOption label must be a string");
    }
    if (
      selection.index !== undefined &&
      (!Number.isInteger(selection.index) || selection.index < 0)
    ) {
      throw new Error("locator.selectOption index must be a non-negative integer");
    }
    if (
      selection.value === undefined &&
      selection.label === undefined &&
      selection.index === undefined
    ) {
      throw new Error("locator.selectOption requires value, label, or index for each selection");
    }
    return { ...selection };
  });
}

// Locator 是不可变的 selector 构建器：每次派生（locator/nth/filter）都返回新实例，
// 原实例的 selector 永不改变，因此可以安全复用于多个操作。
// owner 是创建它的 tab/API 身份对象，跨 owner 组合（and/or/filter）会被拒绝，防止把
// 两个不同页面上的 selector 拼到一起。终结方法把 selector+operation 下发为一条命令。
// [契约] Locator 是不可变构建器：派生只产生新实例，原实例的选择器永不改变。
// 之所以不缓存元素句柄，是因为导航、重排、遮罩都会让旧句柄失效，
// 每次终结操作都按选择器重新定位，超时与重试语义才能留在 host 侧。
// 改成缓存句柄后，页面一刷新，所有既有 locator 会操作已销毁的文档节点。
export class PlaywrightLocator {
  // run/owner/selector/wrap 均为构造期注入且只读；wrap 允许 host 侧替换可见性策略。
  constructor(
    private readonly run: Run,
    private readonly owner: object,
    private readonly selector: string,
    private readonly wrap: ObjectWrapper = defaultObjectWrapper,
  ) {}

  // 派生新 locator 并立即套用包装器：保证调用方拿到的对象与 API 顶层一致，
  // 否则链式派生出的对象会绕过白名单直接暴露内部成员。
  // [资源] 每个派生对象都要立刻套包装，不能等返回给调用方时再套。
  // 少套一层就等于把内部字段暴露给脚本，且缺口只出现在链式调用路径上，
  // 单看顶层对象完全正常，评审时很难发现。
  private create(selector: string): PlaywrightLocator {
    return this.wrap(
      new PlaywrightLocator(this.run, this.owner, selector, this.wrap),
      "PlaywrightLocator",
    );
  }

  [locatorDetails](): { owner: object; selector: string } {
    return { owner: this.owner, selector: this.selector };
  }

  // 所有终结操作共用的命令装配：固定 name 与 selector，operation 及附加字段由调用方给出。
  // 不在这里加超时或重试，语义完全交给 host 侧统一处理。
  // 本地再加一层计时会与 host 超时叠加，最坏情况下一次点击阻塞数分钟，
  // 用户取消后 host 侧的页面句柄仍在等待，释放顺序被打乱。
  private action(
    operation: Extract<BrowserPlaywrightAction, { name: "locator" }>["operation"],
    fields: Omit<
      Extract<BrowserPlaywrightAction, { name: "locator" }>,
      "name" | "selector" | "operation"
    > = {},
  ): Promise<BrowserCommandResult> {
    return runAction(this.run, {
      name: "locator",
      selector: this.selector,
      operation,
      ...fields,
    });
  }

  // 读值型操作的封装：返回 result.value，不额外校验类型，类型由调用方声明负责。
  private async value<T>(
    operation: Extract<BrowserPlaywrightAction, { name: "locator" }>["operation"],
    fields: Omit<
      Extract<BrowserPlaywrightAction, { name: "locator" }>,
      "name" | "selector" | "operation"
    > = {},
  ): Promise<T> {
    return (await this.action(operation, fields)).value as T;
  }

  // 点击命中元素：失败时把 selector 与操作补进错误，模型能直接看出是哪条 locator 超时。
  // [并发] 点击是终结操作，不保证幂等，失败后页面可能已经跳转或提交。
  // 补上下文只为定位，不要顺手加重试：重试会造成重复提交、重复下载。
  // 也不要在这里先做可见性轮询再点击，那会把 host 侧的自动等待拆成两段，
  // 中间出现的遮罩会让等待语义错位，表现为偶发点击落空。
  async click(options: LocatorClickOptions = {}): Promise<void> {
    try {
      await this.action("click", options);
    } catch (error) {
      throw withContext(error, `waiting on click for selector ${this.selector}`);
    }
  }

  async dblclick(options: LocatorClickOptions = {}): Promise<void> {
    try {
      await this.action("dblclick", options);
    } catch (error) {
      throw withContext(error, `waiting on dblclick for selector ${this.selector}`);
    }
  }

  // [事务] 多选下拉必须整批下发，拆成多次单选项会触发多次变更事件。
  // 页面若在变更事件里做级联加载，拆分会打断中间态，
  // 表现为选项被重置，或第二项定位到已被重建的节点上。
  async selectOption(
    input: SelectOptionInput | SelectOptionInput[],
    { timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<void> {
    try {
      await this.action("selectOption", { selections: normalizeSelections(input), timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.selectOption failed for selector ${this.selector}`);
    }
  }

  // fill 与 type 共用同一条命令，差异只在 replace：fill 整体替换，type 追加并逐字输入语义。
  // 两者都必须显式传值，undefined/null 直接拒绝，避免清空输入框这类隐式副作用。
  // [事务] 整体替换与逐字追加共用一条命令，靠替换标记区分，不要合并语义。
  // 把追加改成替换会清掉用户已有输入，且不产生任何错误，
  // 表现成「填写成功但内容少了前半段」，只能靠对比截图发现。
  async fill(value: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    if (value == null) throw new Error("locator.fill requires a value");
    try {
      await this.action("fill", { value, replace: true, timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.fill failed for selector ${this.selector}`);
    }
  }

  // [权衡] 逐字输入的语义由 host 侧保证，本层只透传替换标记。
  // 若在这里做输入去抖或分段发送，会引入多次焦点切换，
  // 页面监听输入的校验逻辑会看到中间态并触发误报。
  async type(value: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    if (value == null) throw new Error("locator.type requires a value");
    try {
      await this.action("fill", { value, replace: false, timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.type failed for selector ${this.selector}`);
    }
  }

  async press(value: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    if (value == null) throw new Error("locator.press requires a value");
    try {
      await this.action("press", { value, timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.press failed for selector ${this.selector}`);
    }
  }

  async setChecked(checked: boolean, options: LocatorCheckOptions = {}): Promise<void> {
    if (typeof checked !== "boolean") throw new Error("locator.setChecked requires a boolean");
    try {
      await this.action("setChecked", { checked, ...options });
    } catch (error) {
      throw withContext(
        error,
        `locator.setChecked(${checked}) failed for selector ${this.selector}`,
      );
    }
  }

  check(options: LocatorCheckOptions = {}): Promise<void> {
    return this.setChecked(true, options);
  }

  uncheck(options: LocatorCheckOptions = {}): Promise<void> {
    return this.setChecked(false, options);
  }

  // [失败路径] 等待状态必须由调用方显式给出，缺省值会让语义不可预测。
  // 这里补默认状态会让「等待元素消失」被误当成「等待元素出现」，
  // 超时耗尽后仍继续操作，错误被推迟到更靠后的步骤。
  async waitFor(options: { state: WaitForState; timeoutMs?: number }): Promise<void> {
    if (!options?.state) throw new Error("locator.waitFor requires a state");
    try {
      await this.action("waitFor", options);
    } catch (error) {
      throw withContext(
        error,
        `locator.waitFor(${options.state}) timed out for selector ${this.selector}`,
      );
    }
  }

  count(): Promise<number> {
    return this.value<number>("count");
  }

  // 先取 count 再按序号派生：返回的是"此刻"的静态快照，页面后续增减元素不会反映到数组里。
  // 每个元素都是独立 locator（nth=i），因此可以在快照上逐个重新定位，不受列表变动影响。
  // [并发] 先取数量再按下标派生，得到的是此刻的静态快照，不是实时集合。
  // 若改成返回惰性集合，遍历期间页面增删元素会导致下标漂移，
  // 表现为读到错位元素的文本，且每次运行结果不同。
  async all(): Promise<PlaywrightLocator[]> {
    const count = await this.count();
    return Array.from({ length: count }, (_unused, index) => this.nth(index));
  }

  textContent({ timeoutMs }: { timeoutMs?: number } = {}): Promise<string | null> {
    return this.value("textContent", { timeoutMs });
  }

  innerText({ timeoutMs }: { timeoutMs?: number } = {}): Promise<string> {
    return this.value("innerText", { timeoutMs });
  }

  getAttribute(name: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<string | null> {
    if (!name) throw new Error("locator.getAttribute requires a name");
    return this.value("getAttribute", { attribute: name, timeoutMs });
  }

  isVisible(): Promise<boolean> {
    return this.value("isVisible");
  }

  isEnabled(): Promise<boolean> {
    return this.value("isEnabled");
  }

  allTextContents({ timeoutMs }: { timeoutMs?: number } = {}): Promise<string[]> {
    return this.value("allTextContents", { timeoutMs });
  }

  evaluate<TResult, TArg = unknown>(
    pageFunction: string | ((element: Element, arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg,
    options?: { timeoutMs?: number },
  ): Promise<TResult> {
    return this.value("evaluate", {
      ...evaluateSource("locator.evaluate", pageFunction as never),
      arg,
      timeoutMs: options?.timeoutMs,
    });
  }

  // [资源] 媒体下载是终结操作，命令返回不代表文件已经落盘。
  // 不要在这里补一次「等待文件存在」的轮询，落盘时机与路径由 host 决定，
  // 本层轮询只会与 host 的清理顺序竞争，拿到半写文件。
  async downloadMedia({ timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    try {
      await this.action("downloadMedia", { timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.downloadMedia failed for selector ${this.selector}`);
    }
  }

  locator(
    selector: string,
    options: Omit<LocatorFilterOptions, "visible"> = {},
  ): PlaywrightLocator {
    if (!selector) throw new Error("locator.locator requires a selector");
    return this.create(`${this.selector} >> ${selector}`).filter(options);
  }

  first(): PlaywrightLocator {
    return this.create(`${this.selector} >> nth=0`);
  }

  last(): PlaywrightLocator {
    return this.create(`${this.selector} >> nth=-1`);
  }

  nth(index: number): PlaywrightLocator {
    if (typeof index !== "number") throw new Error("locator.nth requires a numeric index");
    return this.create(`${this.selector} >> nth=${index}`);
  }

  and(locator: PlaywrightLocator): PlaywrightLocator {
    const selector = this.compatibleSelector(locator, "locator.and");
    return this.create(`${this.selector} >> internal:and=${JSON.stringify(selector)}`);
  }

  or(locator: PlaywrightLocator): PlaywrightLocator {
    const selector = this.compatibleSelector(locator, "locator.or");
    return this.create(`${this.selector} >> internal:or=${JSON.stringify(selector)}`);
  }

  // 组合过滤：各条件按 Playwright internal selector 语法追加到 ">>" 链上，顺序固定为
  // hasText → hasNotText → has → hasNot → visible，保证同样入参产生完全一致的 selector。
  // [契约] 过滤条件的拼接顺序固定，任何重排都会让相同入参生成不同选择器。
  // 顺序稳定是为了让缓存、重放与问题复现能对上同一条定位链。
  // 子 locator 必须先校验归属，否则会把两个标签页的选择器拼在一起，
  // 表现成偶发命中错误页面的同名元素。
  filter(options: LocatorFilterOptions = {}): PlaywrightLocator {
    const selectors = [this.selector];
    if (options.hasText !== undefined) {
      selectors.push(
        `internal:has-text=${serializeMatcher(options.hasText, false, "locator.filter")}`,
      );
    }
    if (options.hasNotText !== undefined) {
      selectors.push(
        `internal:has-not-text=${serializeMatcher(options.hasNotText, false, "locator.filter")}`,
      );
    }
    if (options.has !== undefined) {
      const selector = this.compatibleSelector(options.has, "locator.filter has");
      selectors.push(`internal:has=${JSON.stringify(selector)}`);
    }
    if (options.hasNot !== undefined) {
      const selector = this.compatibleSelector(options.hasNot, "locator.filter hasNot");
      selectors.push(`internal:has-not=${JSON.stringify(selector)}`);
    }
    if (options.visible !== undefined) {
      if (typeof options.visible !== "boolean") {
        throw new Error("locator.filter visible must be a boolean");
      }
      selectors.push(`visible=${options.visible}`);
    }
    return this.create(selectors.join(" >> "));
  }

  getByRole(
    role: string,
    options: { exact?: boolean; name?: TextMatcher } = {},
  ): PlaywrightLocator {
    return this.child(roleSelector(role, options));
  }

  getByText(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.child(textSelector(text, Boolean(options.exact)));
  }

  getByLabel(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.child(labelSelector(text, Boolean(options.exact)));
  }

  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.child(placeholderSelector(text, Boolean(options.exact)));
  }

  getByTestId(testId: string): PlaywrightLocator {
    return this.child(testIdSelector(testId));
  }

  private child(selector: string): PlaywrightLocator {
    return this.create(`${this.selector} >> ${selector}`);
  }

  // and/or/filter 的组合前置校验：必须是 Locator 且属于同一 owner（同一 tab）。
  // 跨 tab 组合在 host 侧无法解析，这里提前抛错，避免下发后才失败、浪费一次往返。
  // [契约] 归属校验放在下发之前，失败只花一次本地判断，不消耗浏览器往返。
  // 去掉校验会让跨标签页组合静默通过，host 侧无法解析时才报错，
  // 错误信息里只有拼接后的长选择器，看不出是两个上下文混用。
  // 也不要放宽成「标签页名字相同即可」，归属是对象身份而不是字符串。
  private compatibleSelector(locator: PlaywrightLocator, method: string): string {
    if (!(locator instanceof PlaywrightLocator)) {
      throw new Error(`${method} requires a PlaywrightLocator`);
    }
    const details = locator[locatorDetails]();
    if (details.owner !== this.owner) throw new Error("Locators must belong to the same tab");
    return details.selector;
  }
}

// Frame 作用域构建器：所有派生 selector 都会带上 "internal:control=enter-frame" 前缀，
// 保证后续 locator 在正确的 iframe 内执行。与 Locator 一样使用同一 owner 校验归属。
// 只做 selector 拼接，不持有 frame 句柄；frame 内容变化不影响已构造的 locator。
// [契约] frame 链只拼接进入指令，不持有 frame 句柄，这是刻意设计。
// 缓存句柄在导航后会失效，后续定位全部落在已销毁的文档上，
// 表现成「frame 明明还在，定位却一直超时」。
export class PlaywrightFrameLocator {
  constructor(
    private readonly run: Run,
    private readonly owner: object,
    private readonly frameSelector: string,
    private readonly wrap: ObjectWrapper = defaultObjectWrapper,
  ) {}

  // 进入 frame 后再定位：前缀层层叠加，嵌套 frame 会形成连续多个 enter-frame 段。
  // 空 selector 直接抛错，避免生成 "frame >> " 这类无法解析的悬空链。
  locator(selector: string): PlaywrightLocator {
    if (!selector) throw new Error("frameLocator.locator requires a selector");
    return this.wrap(
      new PlaywrightLocator(
        this.run,
        this.owner,
        `${this.frameSelector} >> internal:control=enter-frame >> ${selector}`,
        this.wrap,
      ),
      "PlaywrightLocator",
    );
  }

  frameLocator(selector: string): PlaywrightFrameLocator {
    if (!selector) throw new Error("frameLocator.frameLocator requires a selector");
    return this.wrap(
      new PlaywrightFrameLocator(
        this.run,
        this.owner,
        `${this.frameSelector} >> internal:control=enter-frame >> ${selector}`,
        this.wrap,
      ),
      "PlaywrightFrameLocator",
    );
  }

  getByRole(
    role: string,
    options: { exact?: boolean; name?: TextMatcher } = {},
  ): PlaywrightLocator {
    return this.locator(roleSelector(role, options));
  }
  getByText(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(textSelector(text, Boolean(options.exact)));
  }
  getByLabel(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(labelSelector(text, Boolean(options.exact)));
  }
  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(placeholderSelector(text, Boolean(options.exact)));
  }
  getByTestId(testId: string): PlaywrightLocator {
    return this.locator(testIdSelector(testId));
  }
}

// 下载句柄：只暴露 path()，每次调用都会向 host 询问当前落盘路径。
// 不缓存路径是刻意的：下载可能尚未完成或尚未保存，缓存会返回过期值。
// [资源] 路径每次都要向 host 询问，不能缓存。
// 下载可能尚未完成或尚未保存，缓存会返回过期值，
// 落盘任务据此覆盖同名文件，造成用户数据丢失。
export class PlaywrightDownload {
  constructor(
    private readonly run: Run,
    private readonly downloadId: string,
  ) {}

  path({ timeoutMs }: { timeoutMs?: number } = {}): Promise<string | null> {
    return runValue(this.run, { name: "downloadPath", downloadId: this.downloadId, timeoutMs });
  }
}

// 文件选择器句柄：isMultiple 来自等待事件回传的元数据，只读不再变更；
// setFiles 是终结操作，失败时补上下文后抛出，调用方需自行判断是否重试。
export class PlaywrightFileChooser {
  constructor(
    private readonly run: Run,
    private readonly fileChooserId: string,
    private readonly multiple: boolean,
  ) {}

  isMultiple(): boolean {
    return this.multiple;
  }

  // 提交文件路径：接受单文件或数组，空数组与 null 直接拒绝。
  // 路径由 host 侧解析，本层不做存在性校验；失败会附加 "fileChooser.setFiles failed" 上下文。
  // [事务] 空数组与空值都直接拒绝，避免把「取消选择」当成「清空已选文件」。
  // host 侧解析路径失败时不能降级为跳过，否则表单会带着旧文件提交，
  // 表现为上传结果与界面显示不一致。
  async setFiles(
    files: string | string[],
    { timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (files == null) throw new Error("fileChooser.setFiles requires files");
    const normalized = Array.isArray(files) ? files : [files];
    if (normalized.length === 0) throw new Error("fileChooser.setFiles requires at least one file");
    try {
      await runAction(this.run, {
        name: "fileChooserSetFiles",
        fileChooserId: this.fileChooserId,
        files: normalized,
        timeoutMs,
      });
    } catch (error) {
      throw withContext(error, "fileChooser.setFiles failed");
    }
  }
}

// API 根对象：一个实例对应一个浏览器会话上下文，owner 标识用于绑定它派生出的
// Locator/FrameLocator，跨上下文组合会被 compatibleSelector 拒绝。
// wrap 可在运行期被 configurePlaywrightObjectWrapper 替换，用于定制可见性策略。
// [契约] 一个实例对应一个会话上下文，归属对象用于约束它派生出的所有对象。
// 把归属换成会话标识字符串会削弱校验强度，同名会话重连后旧 locator 会被误认。
// 包装器可在运行期替换，但替换只影响之后派生与返回的对象。
export class PlaywrightAPI {
  private readonly owner = {};
  private wrap: ObjectWrapper = defaultObjectWrapper;

  constructor(private readonly run: Run) {}

  [setObjectWrapper](wrap: ObjectWrapper): void {
    this.wrap = wrap;
  }

  // 页面级 evaluate：不绑定元素，直接在页面上下文里执行表达式或函数。
  // 与 locator.evaluate 的区别仅在页面函数签名与执行位置，错误语义一致。
  evaluate<TResult, TArg = unknown>(
    pageFunction: string | ((arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg,
    options?: { timeoutMs?: number },
  ): Promise<TResult> {
    return runValue(this.run, {
      name: "evaluate",
      ...evaluateSource("playwright.evaluate", pageFunction as never),
      arg,
      timeoutMs: options?.timeoutMs,
    });
  }

  // API 顶层 locator：以本实例的 owner 为归属创建，后续派生/组合都受同一 owner 约束。
  // 空 selector 直接抛错，避免构造出无法定位任何元素的对象。
  locator(selector: string): PlaywrightLocator {
    if (!selector) throw new Error("playwright.locator requires a selector");
    return this.wrap(
      new PlaywrightLocator(this.run, this.owner, selector, this.wrap),
      "PlaywrightLocator",
    );
  }
  getByRole(
    role: string,
    options: { exact?: boolean; name?: TextMatcher } = {},
  ): PlaywrightLocator {
    return this.locator(roleSelector(role, options));
  }
  getByText(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(textSelector(text, Boolean(options.exact)));
  }
  getByLabel(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(labelSelector(text, Boolean(options.exact)));
  }
  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(placeholderSelector(text, Boolean(options.exact)));
  }
  getByTestId(testId: string): PlaywrightLocator {
    return this.locator(testIdSelector(testId));
  }
  frameLocator(selector: string): PlaywrightFrameLocator {
    if (!selector) throw new Error("playwright.frameLocator requires a selector");
    return this.wrap(
      new PlaywrightFrameLocator(this.run, this.owner, selector, this.wrap),
      "PlaywrightFrameLocator",
    );
  }

  // 等待 URL 变化/加载完成：url 为空直接拒绝；timeoutMs/waitUntil 透传给 host，不在本地兜底。
  // 有副作用（阻塞直到导航完成），超时由 host 侧返回错误，方法本身不重试。
  // [失败路径] 超时与等待条件全部透传给 host，本层不做兜底重试。
  // 追加一次本地重试会让「导航失败」变成「导航变慢」，错误被吞掉，
  // 后续操作在新旧页面之间摇摆，症状难以复现。
  async waitForURL(
    url: string,
    options: { timeoutMs?: number; waitUntil?: WaitUntil } = {},
  ): Promise<void> {
    if (!url) throw new Error("playwright.waitForURL requires a url");
    await runAction(this.run, { name: "waitForURL", url, ...options });
  }

  async waitForLoadState(options: { state?: LoadState; timeoutMs?: number } = {}): Promise<void> {
    await runAction(this.run, { name: "waitForLoadState", ...options });
  }

  // 显式等待：参数必须是"非负整数"，小数/负数/NaN 一律抛错，避免 host 侧 setTimeout 被静默取整。
  // 该方法走独立 method（playwrightWaitForTimeout），与其他 playwright action 分开计费与取消。
  // [权衡] 显式等待走独立入口，与其他 playwright 操作分开计费与取消。
  // 把它合并进通用动作会让长等待占用同一条取消通道，
  // 用户取消会话后等待仍在计时，页面状态与工具结果出现时间差。
  async waitForTimeout(timeoutMs: number): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error("playwright.waitForTimeout requires a non-negative integer");
    }
    const command: BrowserCommand = { method: "playwrightWaitForTimeout", timeoutMs };
    expectOk(command, await this.run(command));
  }

  // 等待一次性浏览器事件（download / filechooser），返回对应句柄。
  // 不支持的事件名立即抛错，而不是返回空句柄；句柄的后续终结操作由调用方负责。
  async waitForEvent(
    event: "download",
    options?: { timeoutMs?: number },
  ): Promise<PlaywrightDownload>;
  async waitForEvent(
    event: "filechooser",
    options?: { timeoutMs?: number },
  ): Promise<PlaywrightFileChooser>;
  // [资源] 事件句柄只保留标识，事件本身在 host 侧一次性消费，本层不持有监听。
  // 若在本地缓存句柄或复用监听，下一次弹窗会被旧句柄截获，
  // 表现为界面一直停在「等待文件选择」，而浏览器早已弹出新窗口。
  // 因此句柄用尽即弃，调用方不能跨步骤复用同一个下载或文件选择器。
  async waitForEvent(
    event: "download" | "filechooser",
    options: { timeoutMs?: number } = {},
  ): Promise<PlaywrightDownload | PlaywrightFileChooser> {
    if (event !== "download" && event !== "filechooser") {
      throw new Error("playwright.waitForEvent only supports 'download' and 'filechooser'");
    }
    const value = await runValue<{ id: string; isMultiple?: boolean }>(this.run, {
      name: "waitForEvent",
      event,
      timeoutMs: options.timeoutMs,
    });
    return event === "download"
      ? this.wrap(new PlaywrightDownload(this.run, value.id), "PlaywrightDownload")
      : this.wrap(
          new PlaywrightFileChooser(this.run, value.id, Boolean(value.isMultiple)),
          "PlaywrightFileChooser",
        );
  }

  // 并发执行"动作"与"等待导航"：先发起 wait 再调用 action，避免漏掉瞬间完成的导航。
  // 用 Promise.all 同时消费两者，action 抛错时会一起 reject；返回值取 action 的结果。
  // 这不是事务语义：action 可能已产生副作用，失败后调用方需自行判断页面当前状态。
  // [并发] 必须先挂等待再执行动作，顺序反了会漏掉瞬间完成的导航。
  // 两个异步分支并行消费，动作抛错时等待一起结束，不会留下悬挂的监听。
  // 这不是事务：动作可能已产生副作用，页面状态需调用方自行判断。
  // 改成串行执行会让「先等待后点击」永远等不到导航，白耗一个完整超时。
  async expectNavigation<T>(
    action: () => Promise<T>,
    options: { timeoutMs?: number; url?: string; waitUntil?: LoadState } = {},
  ): Promise<T> {
    const wait = options.url
      ? this.waitForURL(options.url, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
        })
      : this.waitForLoadState({
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.waitUntil === undefined ? {} : { state: options.waitUntil }),
        });
    const result = action();
    const [actionResult] = await Promise.all([result, wait]);
    return actionResult;
  }

  // 坐标命中查询：返回该点下可交互元素的候选集合，供模型选择点击目标。
  // 坐标非有限数直接抛错；includeNonInteractable 透传给 host 决定是否放宽筛选。
  elementInfo(options: {
    x: number;
    y: number;
    includeNonInteractable?: boolean;
  }): Promise<ElementInfo[]> {
    validateCoordinates("playwright.elementInfo", options);
    return runValue(this.run, { name: "elementInfo", ...options });
  }

  // 截取命中元素区域：host 返回 base64，这里解码为 Uint8Array 供 artifact 落盘。
  // 结果缺 image 视为协议违例，直接抛错；调用方需保证坐标来自 elementInfo 的同一快照。
  // [事务] 坐标必须来自同一次元素快照，截取与命中之间页面不得滚动。
  // 缺图视为协议违例而不是返回空字节，否则产物落盘会留下 0 字节文件，
  // 下游只能看到「截图成功」却打不开图片。
  async elementScreenshot(options: {
    x: number;
    y: number;
    includeNonInteractable?: boolean;
  }): Promise<Uint8Array> {
    validateCoordinates("playwright.elementScreenshot", options);
    const result = await runAction(this.run, { name: "elementScreenshot", ...options });
    if (!result.image) throw new Error("Browser result missing image");
    return base64ToBytes(result.image.base64);
  }

  // [资源] 快照是只读查询，不改变页面，但结果可能非常大。
  // 不要在这里做截断或分页，截断会让调用方拿到结构不完整的文档树，
  // 据此生成的选择器会在真实页面上定位失败。
  domSnapshot(): Promise<string> {
    return runValue(this.run, { name: "domSnapshot" });
  }
}

// 工厂：创建 API 并立刻套白名单包装；返回类型声明为 PlaywrightAPI，但运行期是 Proxy。
// 这是唯一推荐的构造入口，直接 new 会得到未包装对象并暴露内部成员。
// [契约] 这是唯一推荐的构造入口，直接实例化会得到未包装对象。
// 未包装对象不会报错，只会在脚本里多出一些看似可用的内部成员，
// 表现成同一份脚本在不同入口下行为不一致。
export function createPlaywrightAPI(run: Run): PlaywrightAPI {
  return defaultObjectWrapper(new PlaywrightAPI(run), "PlaywrightAPI");
}

// 替换 API 的包装策略并重新包装：host 可借此放宽/收紧对外可见成员。
// 注意它修改传入实例（设置私有 wrap 字段），不是纯函数；重复调用以后一次为准。
// [权衡] 替换包装策略会修改传入实例，不是纯函数，重复调用以后一次为准。
// host 据此放宽可见性时，旧对象仍持有旧的包装器引用，
// 所以不要在会话中途反复替换，否则同一会话的对象暴露面不一致。
export function configurePlaywrightObjectWrapper(
  api: PlaywrightAPI,
  wrap: ObjectWrapper,
): PlaywrightAPI {
  api[setObjectWrapper](wrap);
  return wrap(api, "PlaywrightAPI");
}
