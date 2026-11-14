/**
 * browser-client 模块公开入口：转发 facade / playwright / selection / manifest 四组接口，
 * 并提供 setupBrowserRuntime 这一个有副作用的挂载函数。
 * 本模块不持有浏览器会话状态，浏览器生命周期由 transport 背后的 host 负责；
 * 这里只做对象图装配与能力校验。其余导出均为纯转发，无运行时副作用。
 */

import {
  BrowsersFacade,
  type BrowserAvailabilityGuard,
  type BrowserClientTransport,
} from "./facade.js";
import { loadBrowserDocumentation } from "./documentation.js";

export {
  BrowsersFacade,
  Browser,
  BrowserTabs,
  BrowserRecordingAPI,
  type BrowserTabInfo,
  RawTab,
  Tab,
  type BrowserBackendType,
  type BrowserAvailabilityGuard,
  type BrowserCapabilityInfo,
  type BrowserClientTransport,
  type BrowserExecuteFn,
  type BrowserTransportExecuteFn,
  type BrowserInfo,
  type BrowserDescriptor,
} from "./facade.js";
export { BrowserCommandError } from "./result.js";
export {
  PlaywrightAPI,
  PlaywrightDownload,
  PlaywrightFileChooser,
  PlaywrightFrameLocator,
  PlaywrightLocator,
  type ElementInfo,
  type KeyboardModifier,
  type LoadState,
  type TextMatcher,
  type WaitUntil,
} from "./playwright.js";
export { selectBrowserForUrl, selectDefaultBrowser } from "./selection.js";
export {
  BrowserApiPolicy,
  createBrowserApiProxy,
  loadBrowserApiManifest,
  type BrowserApiManifest,
  type BrowserApiManifestMember,
} from "./manifest.js";

// 把浏览器运行时挂载到 agent globals：新建 BrowsersFacade 并赋给 agent.browsers，
// 同时用带能力校验的 documentation.get 替换/包装原有实现。
// 输入 globals 必须是可变对象；agent 缺失时就地创建，属于可观察的副作用。
// assertAvailable 会在挂载前、以及每次文档读取前调用，用于能力未就绪时快速失败。
// 文档名称为空串抛 TypeError；"computer-use" 复用注入前的 get，避免覆盖非浏览器文档能力。
// 已有 agent.documentation 会被冻结的新对象整体替换，原对象不被修改。
// 该函数不是幂等的：重复调用会用新 facade 覆盖 agent.browsers，旧实例不会自动释放，
// 因此只应在 runtime 装配阶段调用一次。
// 文档读取失败会原样上抛（不缓存失败结果），调用方每次 get 都会重新走一遍 guard。
export function setupBrowserRuntime(opts: {
  globals: Record<string, unknown>;
  transport: BrowserClientTransport;
  documentationRoot?: string;
  assertAvailable?: BrowserAvailabilityGuard;
}): void {
  opts.assertAvailable?.();
  const agent = (opts.globals.agent ??= {}) as {
    browsers?: BrowsersFacade;
    documentation?: { get(name: string): Promise<string> };
  };
  agent.browsers = new BrowsersFacade(opts.transport, {
    documentationRoot: opts.documentationRoot,
    assertAvailable: opts.assertAvailable,
  }).asRuntimeObject();
  const previousDocumentation = agent.documentation;
  const previousGet = previousDocumentation?.get;
  agent.documentation = Object.freeze({
    get: async (name: string) => {
      opts.assertAvailable?.();
      if (!name) throw new TypeError("agent.documentation.get requires a document name");
      if (name === "computer-use" && previousGet) return await previousGet(name);
      return loadBrowserDocumentation(opts.documentationRoot, name);
    },
  });
}
