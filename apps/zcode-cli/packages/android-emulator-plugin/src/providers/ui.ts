/**
 * Android UI 自动化能力：基于 adb + uiautomator dump 的元素树，提供描述、定位、点击、滑动、输入与按键。
 *
 * 职责边界：只负责 UI 查询与输入事件；设备准备交给 ensureDevice，截图在 screenshot.ts。
 * 副作用：describe 会在设备 sdcard 写 /sdcard/window.xml；tap/swipe/typeText/keyevent 会真实改变前台 UI。
 * 失败语义：adb 命令失败或超时抛 Error；查询为空/无匹配抛带原文的错误，便于模型修正 query；
 * 输入超长或编码非法抛错，但不做 UI 层面的「元素不存在」校验（由 resolve 负责）。
 * 返回口径：元素坐标统一为屏幕绝对像素，x/y 为 bounds 中心点；元素 index 为解析顺序，非稳定性标识。
 */
import { ensureDevice } from "./avd.js";
import { adbShell } from "./device.js";
import { findTool } from "./sdk.js";

/**
 * UI 操作的通用目标参数，与其它设备类工具保持一致，便于统一透传。
 */
type UiTarget = {
  serial?: string;
  avd?: string;
  timeoutMs?: number;
};

/**
 * 从 uiautomator dump 中提取的单个节点。
 * 只保留对定位有用的字段：文本/描述/resourceId/类名/边界/可点击/可用；
 * 空字符串被归一化为 undefined，避免调用方对「空文本」做无意义匹配。
 */
type UiElement = {
  index: number;
  text?: string;
  contentDescription?: string;
  resourceId?: string;
  className?: string;
  bounds?: Bounds;
  clickable?: boolean;
  enabled?: boolean;
};

/**
 * 元素屏幕边界（绝对像素）。left/top/right/bottom 为 dump 原值，
 * centerX/centerY 预先算好并取整，作为 tap 的目标点。
 */
type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

/**
 * 允许发送的系统按键白名单：值直接作为 KEYCODE_* 传入 input keyevent。
 * 用封闭枚举限制输入，避免任意整数/字符串注入到设备命令。
 */
const KEY_EVENTS = {
  BACK: "KEYCODE_BACK",
  HOME: "KEYCODE_HOME",
  ENTER: "KEYCODE_ENTER",
  APP_SWITCH: "KEYCODE_APP_SWITCH",
  MENU: "KEYCODE_MENU",
  SEARCH: "KEYCODE_SEARCH",
} as const;

const MAX_INPUT_TEXT_LENGTH = 1000;
// 限制单次输入长度：input text 通过 shell 传递，过长文本会触发命令行长度限制且难以排查。

/**
 * 返回 UI 自动化后端状态。
 *
 * 仅以 adb 是否存在判定可用性：本插件依赖 adb 的 uiautomator dump 与 input 子命令，不依赖额外服务。
 * 副作用：执行 which/where 查找 adb，只读。失败语义：不抛错，adb 缺失时 available=false 由调用方提示。
 */
export async function status() {
  const adb = await findTool("adb");
  const adbAvailable = Boolean(adb);
  return {
    backend: "adb-uiautomator",
    adb,
    adbInput: adbAvailable,
    uiAutomator: adbAvailable,
    available: adbAvailable,
    implementedBackends: adbAvailable ? ["uiautomator", "adb-input"] : [],
  };
}

/**
 * 导出当前界面的精简元素树。
 *
 * 流程：ensureDevice → uiautomator dump 到设备临时文件 → cat 读回 → XML 正则解析为元素数组。
 * 副作用：写设备 /sdcard/window.xml（覆盖上一个 dump），拉起 uiautomator 进程，会短暂占用设备。
 * 失败语义：dump 或 cat 失败抛 Error；XML 解析是宽松的，解析不到节点时返回空数组而非报错。
 * 返回口径：elements 只含可见层级中的 node，bounds 缺失的节点仍在列表中但不可用于 tap。
 */
export async function describe(input: UiTarget = {}) {
  const device = await ensureDevice(input);
  await adbShell(
    device.serial,
    ["uiautomator", "dump", "/sdcard/window.xml"],
    input.timeoutMs ?? 30_000,
  );
  const out = await adbShell(
    device.serial,
    ["cat", "/sdcard/window.xml"],
    input.timeoutMs ?? 30_000,
  );
  const elements = parseUiAutomator(out.stdout);
  return { device, elements };
}

/**
 * 按文本类属性定位元素并返回中心坐标。
 *
 * query 先 trim + 小写，空查询直接抛错，避免匹配到所有元素；匹配范围是 text/contentDescription/
 * resourceId/className 拼接串，因此可以用 resource-id 片段或类名定位。
 * 只接受带 bounds 的命中项（无坐标无法点击）；无匹配时抛出包含原始 query 的错误。
 * 副作用：复用 describe，会触发一次 dump；不改变 UI。
 */
export async function resolve(input: UiTarget & { query: string }) {
  const tree = await describe(input);
  const query = input.query.trim().toLowerCase();
  if (!query) throw new Error("UI query must not be empty.");
  const hit = tree.elements.find(
    (item) => elementText(item).toLowerCase().includes(query) && item.bounds,
  );
  if (!hit?.bounds) throw new Error(`No visible Android UI element matched: ${input.query}`);
  return {
    device: tree.device,
    element: hit,
    x: hit.bounds.centerX,
    y: hit.bounds.centerY,
  };
}

/**
 * 在屏幕绝对坐标处点击。
 *
 * 坐标会被四舍五入为整数（input 只接受整数像素），但返回给调用方的是原始输入值，便于对照。
 * 副作用：真实点击，可能触发任意界面跳转；不做坐标越界校验，越界通常由系统忽略或落到边缘。
 */
export async function tap(input: UiTarget & { x: number; y: number }) {
  const device = await ensureDevice(input);
  await adbShell(
    device.serial,
    ["input", "tap", String(Math.round(input.x)), String(Math.round(input.y))],
    input.timeoutMs ?? 30_000,
  );
  return { tapped: true, serial: device.serial, x: input.x, y: input.y };
}

/**
 * 从 (x1,y1) 滑动到 (x2,y2)。
 *
 * durationMs 缺省 300ms，太快容易被识别为 fling 而滚过头，过慢则操作迟滞；取整后作为第 6 个参数。
 * 副作用：改变界面滚动状态；不做方向/距离校验，由系统处理无效滑动。
 */
export async function swipe(
  input: UiTarget & { x1: number; y1: number; x2: number; y2: number; durationMs?: number },
) {
  const device = await ensureDevice(input);
  await adbShell(
    device.serial,
    [
      "input",
      "swipe",
      String(Math.round(input.x1)),
      String(Math.round(input.y1)),
      String(Math.round(input.x2)),
      String(Math.round(input.y2)),
      String(Math.round(input.durationMs ?? 300)),
    ],
    input.timeoutMs ?? 30_000,
  );
  return {
    swiped: true,
    serial: device.serial,
    x1: input.x1,
    y1: input.y1,
    x2: input.x2,
    y2: input.y2,
  };
}

/**
 * 向当前焦点控件输入文本。
 *
 * 文本先经 inputText 编码（% 转 %25、空白转 %s），因为 adb input text 不做 shell 转义，
 * 空格与特殊字符必须预编码；返回的 length 是原始文本长度，而非编码后长度。
 * 副作用：在设备当前焦点输入；不会自动聚焦，调用方需先 tap 输入框。
 * 失败语义：超长（>1000）抛 Error；adb 失败向上抛。
 */
export async function typeText(input: UiTarget & { text: string }) {
  const device = await ensureDevice(input);
  const text = inputText(input.text);
  await adbShell(device.serial, ["input", "text", text], input.timeoutMs ?? 30_000);
  return { typed: true, serial: device.serial, length: input.text.length };
}

/**
 * 发送系统按键事件。
 *
 * key 必须是 KEY_EVENTS 的键之一（类型层面已约束），再映射为 KEYCODE_*，避免传入任意 keycode。
 * 副作用：真实按键，可能返回桌面/切后台/提交表单等；失败向上抛。
 */
export async function keyevent(input: UiTarget & { key: keyof typeof KEY_EVENTS }) {
  const device = await ensureDevice(input);
  await adbShell(
    device.serial,
    ["input", "keyevent", KEY_EVENTS[input.key]],
    input.timeoutMs ?? 30_000,
  );
  return { pressed: true, serial: device.serial, key: input.key };
}

/**
 * 解析 uiautomator dump 的 XML，提取所有 node 节点。
 *
 * 使用宽松正则而非 XML 解析器：dump 可能存在未转义/非标准内容，正则能容忍并尽量提取；
 * 只匹配 node 标签，忽略层级结构（父节点同样会被收录）。
 * 纯函数、无副作用；index 为数组顺序，用于展示而非稳定标识。
 */
export function parseUiAutomator(value: string): UiElement[] {
  const elements: UiElement[] = [];
  for (const match of value.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1] ?? "");
    const bounds = parseBounds(attrs.get("bounds") || "");
    elements.push({
      index: elements.length,
      text: empty(attrs.get("text")),
      contentDescription: empty(attrs.get("content-desc")),
      resourceId: empty(attrs.get("resource-id")),
      className: empty(attrs.get("class")),
      bounds,
      clickable: attrs.get("clickable") === "true",
      enabled: attrs.get("enabled") !== "false",
    });
  }
  return elements;
}

/**
 * 把 node 标签内的属性字符串解析成 Map。
 * 只识别 key="value" 形式，值中的双引号按 XML 规则不会出现；属性值统一做实体解码。
 * 同名属性后者覆盖前者，属于 XML 非法情况，这里宽容处理。
 */
function attributes(value: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of value.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)) {
    if (match[1]) out.set(match[1], decode(match[2] ?? ""));
  }
  return out;
}

/**
 * 解析 bounds 字符串 "[l,t][r,b]"。
 * 格式不匹配返回 undefined（该元素不可点击），而不是抛错，避免一个坏节点毁掉整棵树；
 * 中心点四舍五入取整，保证可直接用于 input tap。
 */
function parseBounds(value: string): Bounds | undefined {
  const match = value.match(/\[(\d+),(\d+)]\[(\d+),(\d+)]/);
  if (!match) return undefined;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return {
    left,
    top,
    right,
    bottom,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2),
  };
}

/**
 * 编码待输入文本：长度上限 1000，% 转义为 %25，任意空白转 %s。
 * 这是 adb input text 的约定编码；不转义会把空格当参数分隔、把 % 当转义引导而出错。
 */
export function inputText(value: string): string {
  if (value.length > MAX_INPUT_TEXT_LENGTH) throw new Error("Text input is too long.");
  return value.replace(/%/g, "%25").replace(/\s/g, "%s");
}

/**
 * 拼接元素的可匹配文本（文本、描述、resource id、类名），供 resolve 做包含匹配。
 * 顺序固定，保证同一 query 的匹配结果稳定。
 */
function elementText(item: UiElement): string {
  return [item.text, item.contentDescription, item.resourceId, item.className]
    .filter(Boolean)
    .join(" ");
}

/**
 * 把空字符串归一化为 undefined，避免输出中出现大量 "" 字段干扰模型判断。
 */
function empty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * 解码 uiautomator 属性中的 XML 实体。
 * 先处理 & 以外的高频实体，最后把 &amp; 还原，避免二次解码把 "&amp;lt;" 变成 "<"。
 */
function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
