// INV-01 位置：loadBrowserDocumentation 入口；守住 documentationRoot 缺失时先判 name 再回退 FALLBACK_DOCUMENTATION 的顺序；改错会把“按名查找失败”降级成静默回退，调用方拿不到错误。
// INV-02 位置：hasApi 与 manifest 的联合判定；守住两者皆无才回退或抛错；改错会在仅有 api.json 或仅有 documents.json 时误判文档缺失。
// INV-03 位置：按名查找分支；守住 candidate.name 或去掉 .md 后缀的 path 精确匹配；改错会让带后缀和不带后缀的两种引用只有一种能命中。
// INV-04 位置：按名查找分支；守住 documentApplies 与名字匹配同时成立；改错会把条件不满足的文档当成存在，随后才在读文件处失败。
// INV-05 位置：按名查找后的 markdown 判空；守住路径存在但内容为空也算找不到并抛错；改错会让空文档静默替换掉应有的错误提示。
// INV-06 位置：documentApplies 首行；守住无 when 视为适用、有 when 但无 descriptor 视为不适用；改错会把条件文档泄漏给未选定后端的全局入口。
// INV-07 位置：documentApplies 的能力集合；守住 browser 与 tab 两个 Set 分别建立、分别校验；改错会让 tab 能力冒充 browser 能力，过滤条件失效。
// INV-08 位置：requiredApiMembers 解析；守住以首个点号切分且 separator <= 0 直接判否；改错会把畸形成员名当成通配，错误放行文档。
// INV-09 位置：readJson 与 readMarkdown；守住 existsSync 先探测、异常吞掉返回 undefined；改错会让损坏的 JSON 或不可读文件中断整份文档加载。
// INV-10 位置：effectiveApi 无 descriptor 分支；守住只保留 unsupportedByDefaultIn 与 requiresCapabilities 均为空的成员；改错会把仅部分后端可用的 API 暴露成通用能力。
// INV-11 位置：effectiveApi 无 descriptor 分支的 declarations；守住声明级过滤与成员级过滤同时执行；改错会让被成员级放行的对象漏出后端专属签名。
// INV-12 位置：effectiveApi 有 descriptor 分支；守住按对象调用 policy.supportedMembers 重建 objects；改错会保留 descriptor 不支持的成员，模型据此写出必然失败的调用。
// INV-13 位置：formatApi 的 documented 判定；守住成员 documented === false 跳过、声明 documented !== false 保留；改错会让内部成员进入 prompt 或被误删。
// INV-14 位置：formatApi 的输出结构；守住 entrypoints、semantics、types、objects 的固定顺序；改错会改变提示词排版，破坏依赖固定小节的解析与缓存。
// INV-15 位置：loadBrowserDocumentation 无 name 分支；守住章节按 descriptor、标题、API、documents 顺序 push；改错会让 selected browser 段落出现在标题之后，提示词自相矛盾。
// INV-16 位置：documents 收集循环；守住无 path、mode 为 lookup、documentApplies 为假三种情况都 continue；改错会把 lookup 文档整篇注入，撑爆上下文。
// INV-17 位置：最终返回；守住 filter(Boolean) 后以空行拼接并 trim，空结果才回退；改错会产生多余空行或把非空文档替换成 fallback。
// INV-18 位置：FALLBACK_DOCUMENTATION；守住 fresh kernel、单次观察一次动作、双 tab 列表、3000ms 上限等结论与运行时一致；改错会让 fallback 文档教出错误操作。
//
// 模块职责：从 documentationRoot 读取 api.json 与 documents.json，按 backend 过滤能力与条件文档，拼成可直接注入 prompt 的 Markdown，对外只暴露同步的 loadBrowserDocumentation。
// 状态所有权：本模块无状态，所有事实来自磁盘上的 api.json、documents.json 与 .md 文件；backend 描述与 manifest 由调用方持有，缓存与失效不属于这里。
// 阅读顺序：先看 INV 列表，再读 documentApplies 的过滤顺序，最后读 loadBrowserDocumentation 的四个早返回。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserBackendDescriptor } from "@zcode/contracts/browser-control";
import { BrowserApiPolicy, loadBrowserApiManifest, type BrowserApiManifest } from "./manifest.js";

// documents.json 的字段全部可选，缺失即视为未配置；不要把这里的宽松类型当成校验通过。
// mode 只区分 included 与 lookup：lookup 用于按名点查，不参与默认整篇拼接。
// when 的四个条件是“与”关系，任一不满足文档就不适用；新增条件时必须同步 documentApplies。
// browserTypes 与 descriptor.type 做包含判断，类型值来自 BrowserBackendDescriptor，不要手写字符串。
// requiredApiMembers 使用“对象.成员”文本形式，解析规则只认首个点号，成员名里不能含点。
// version 与 title 只影响展示，不参与适用性判断，也不做兼容性分支。
interface BrowserDocumentsManifest {
  documents?: Array<{
    path?: string;
    title?: string;
    name?: string;
    mode?: "included" | "lookup";
    description?: string;
    when?: {
      browserTypes?: BrowserBackendDescriptor["type"][];
      requiredApiMembers?: string[];
      requiredBrowserCapabilities?: string[];
      requiredTabCapabilities?: string[];
    };
  }>;
  title?: string;
  version?: number;
}

// 对外契约：输入一条 document 记录与可选 descriptor，输出布尔；纯函数，不做 IO、不抛错。
// 第一个早返回是 when 缺失返回 true，第二个是 descriptor 缺失返回 false，这两条不能互换。
// 空 when 表示无条件文档，但一旦声明了 when 就必须有 descriptor 才能判定。
// 能力 id 集合每次调用重建，不要提到模块级缓存，否则 descriptor 变更后过滤结果会陈旧。
// requiredApiMembers 为空数组时跳过整段策略构造，避免为无要求的文档付出 BrowserApiPolicy 的开销。
// policy.supports 接收对象名与成员名两段，切分失败时直接判否，不允许回退到“全部支持”。
function documentApplies(
  document: NonNullable<BrowserDocumentsManifest["documents"]>[number],
  descriptor: BrowserBackendDescriptor | undefined,
  api: BrowserApiManifest,
): boolean {
  const when = document.when;
  if (!when) return true;
  if (!descriptor) return false;
  if (when.browserTypes && !when.browserTypes.includes(descriptor.type)) return false;
  const browserCapabilities = new Set(
    (descriptor.capabilities.browser ?? []).map((capability) => capability.id),
  );
  const tabCapabilities = new Set(
    (descriptor.capabilities.tab ?? []).map((capability) => capability.id),
  );
  if (when.requiredBrowserCapabilities?.some((id) => !browserCapabilities.has(id))) return false;
  if (when.requiredTabCapabilities?.some((id) => !tabCapabilities.has(id))) return false;
  if (when.requiredApiMembers?.length) {
    const policy = new BrowserApiPolicy(api, descriptor);
    if (
      when.requiredApiMembers.some((member) => {
        const separator = member.indexOf(".");
        return (
          separator <= 0 ||
          !policy.supports(member.slice(0, separator), member.slice(separator + 1))
        );
      })
    ) {
      return false;
    }
  }
  return true;
}

// fallback 是最后一道可用性保证，只在没有根目录、没有 api.json 且没有 documents.json 时返回。
// 数组用 join 拼接，元素本身不带尾部换行；新增条目时要自己保证段落之间空行。
// 条目里混有单行注释说明动机，修改文案时保留它们，避免下一个人重新踩同一个提示词坑。
// 文案中的行为结论必须与运行时一致，例如每次调用都是 fresh kernel、open 默认同站复用。
// 这里不放任何后端专属命令，因为 fallback 会在完全不知道 descriptor 的情况下被读出。
// prompt 文案属于对外契约，改字要当成行为变更处理，先确认对模型决策的影响。
const FALLBACK_DOCUMENTATION = [
  "# Built-in Browser Automation API",
  "",
  // Browser Use MCP 已是每次调用 fresh kernel；fallback 不能继续诱导模型复用 global binding。
  "The official browser-use plugin docs are unavailable, and every Browser Use call starts in a fresh kernel. Start with `await agent.browsers.list()`, then select a reported runtime browser with `const browser = await agent.browsers.getDefault()` or the matching `get()` / `getForUrl(url)` selection. Repeat the same verified selection in each call without switching backend.",
  "Backend types are `iab | extension | cdp`; Playwright is a tab API surface, not a backend. Never assume an unlisted backend is available.",
  "High-level methods return payloads directly and throw `BrowserCommandError` on failure.",
  "Before each logical tab-operation batch, return the complete `browser.tabs.list()` result in a dedicated observation cell. Each `TabInfo` includes `viewport: BrowserViewportSize`. After the model inspects the list, match by stable id or verified URL/title and call `tabs.get(id)` in the next cell; if no controlled tab matches, inspect and claim `browser.user.openTabs()` before creating a new tab.",
  // 模型每次对同站 URL 都走 tabs.new()，任务结束后 IAB 堆满标签页。
  // open() 现在内置同站复用（激活 + 原地跳转），文档必须把 open() 教成默认导航入口。
  "`agent.browsers.open(url)` is the default navigation entry: it reuses an existing same-site controlled tab (same hostname), activates it so the user sees it, and navigates in place instead of stacking new tabs. Only pass `{ reuseTab: false }` (or use `browser.tabs.new()`) when the task genuinely needs a parallel independent tab.",
  "For a genuinely new URL with no intended existing page, use `const tab = await browser.tabs.new()`, run `await tab.goto(url)`, then run `await tab.playwright.waitForLoadState({ state: \"domcontentloaded\" })` before returning the first title, URL, or DOM observation.",
  "After every successful `tab.goto(url)`, explicitly call `await tab.playwright.waitForLoadState({ state: \"domcontentloaded\" })` before the first title, URL, or DOM observation. Keep this confirmation in the model-visible trajectory even when goto() has already settled the backend navigation. Do not replace it with networkidle or a fixed sleep; routine URL/load-state waits remain capped at 3000ms.",
  "If the latest domSnapshot already contains the target, use its facts directly. Do not use evaluate() to rediscover related elements, enumerate inputs, dump HTML, walk the DOM, or probe guessed selectors.",
  "Never guess locator labels, accessible names, placeholders, selectors, or URL patterns. If count() is 0, do not action-wait: take a fresh domSnapshot() and rebuild. After timeout/strict/parse failure, never retry the same locator.",
  // 快照里的 heading/text 可能由祖先卡片处理点击，不能因缺少 link role 就放弃或猜测新角色。
  "A snapshot-proven heading or visible text does not need a `link` or `button` role to be clicked. Do not replace a snapshot-proven `heading` with a guessed `link` role. When user intent authorizes navigation and the actual target is unique, click it directly.",
  // 两套 tab 查询分开返回时，模型会在第一套结果后重新决策并跳过 popup 来源。
  "Use at most one state-changing action per observation cycle. An unchanged source-tab URL does not prove the click failed. Judge an action by whether its expected effect appeared, not by whether `browser.tabs.list()` is non-empty. An existing source tab or unrelated controlled tab is not an action effect. When an action may open a popup/new tab and the source tab does not show the expected effect, read `browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell. Prefer `const [controlledTabs, userTabs] = await Promise.all([browser.tabs.list(), browser.user.openTabs()]);`. Return `{ controlledTabs, userTabs }` as that cell's final result so the model makes one decision from both lists. Do not return the controlled list first or decide whether to query user tabs from its contents.",
  "playwright.evaluate() and locator.evaluate() execute JavaScript in the page context and may change page state. Use them for page-side logic that cannot be expressed through the high-level locator API; use normal action methods when they communicate the intended interaction more clearly.",
  "Routine locator, URL/load-state wait, and evaluate operations default to and are capped at 3000ms; fixed tab.playwright.waitForTimeout(ms) is separate.",
].join("\n");

// 读盘函数统一返回 undefined 而不是抛错，调用方据此走“文档缺失”分支，不再区分“不存在”和“读失败”。
// 先 existsSync 再 read，是为了把权限错误与文件缺失合并成同一种可预期结果。
// JSON 解析失败同样被吞掉，坏 manifest 等价于没有 manifest，不会阻断 fallback 路径。
// markdown 读取后立即 trim，磁盘上的首尾空行不会进入 prompt。
// 路径一律用 join 组装，不要拼接分隔符，保证跨平台一致。
// 这两个函数只在同步入口内使用，不要改成异步而破坏 loadBrowserDocumentation 的同步签名。
function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readMarkdown(root: string, relativePath: string): string | undefined {
  const path = join(root, relativePath);
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

// formatApi 是纯渲染，只负责把 manifest 变成 Markdown 小节，不参与能力过滤。
// 入口先判空返回空串，调用方再用条件决定是否 push，避免产生空小节。
// 成员过滤发生在两层：成员自身的 documented 与每条声明的 documented，任一为 false 就不展示。
// declarations 为空时回退到成员级 signature，保证一个成员至少有一行签名可见。
// 输出顺序固定为 entrypoints、semantics、types、objects，改序会改变 prompt 的稳定前缀。
// 缩进层级用字面量空格维持，Markdown 列表嵌套依赖它，不要改成 tab。
function formatApi(api: BrowserApiManifest | undefined): string {
  if (!api) return "";
  const lines: string[] = [];
  lines.push("## API manifest");
  if (api.entrypoints && api.entrypoints.length > 0) {
    lines.push("- entrypoints:");
    for (const entrypoint of api.entrypoints) lines.push(`  - \`${entrypoint}\``);
  }
  if (api.semantics) {
    lines.push("- semantics:");
    for (const [key, value] of Object.entries(api.semantics)) lines.push(`  - ${key}: ${value}`);
  }
  if (api.types) {
    lines.push("- types:");
    for (const [name, declaration] of Object.entries(api.types)) {
      lines.push(`  - \`${name}\`: \`${declaration}\``);
    }
  }
  if (api.objects) {
    lines.push("- objects:");
    for (const [name, object] of Object.entries(api.objects)) {
      lines.push(`  - ${name}`);
      for (const member of object.members ?? []) {
        if (member.documented === false) continue;
        const signatures = member.declarations?.length
          ? member.declarations
              .filter((declaration) => declaration.documented !== false)
              .map((declaration) => declaration.signature)
          : [member.signature];
        for (const signature of signatures) lines.push(`    - ${member.kind} \`${signature}\``);
      }
    }
  }
  return lines.join("\n");
}

// effectiveApi 是唯一的能力裁剪点，所有对外文档都必须先经过它，不能把原始 manifest 直接渲染。
// 没有 descriptor 时只能给出所有连接都安全的 common surface，不能伪造默认后端。
// 带 descriptor 时把对象成员交给 BrowserApiPolicy 判定，策略是唯一事实来源。
// 两个分支都重建 objects，绝不修改传入的 api，避免调用方共享对象被污染。
// 过滤同时覆盖 members 与 declarations，只滤一层会漏出后端专属签名。
// 裁剪结果只影响展示，不改变磁盘 manifest，下次调用重新计算。
function effectiveApi(
  api: BrowserApiManifest,
  descriptor?: BrowserBackendDescriptor,
): BrowserApiManifest {
  if (!descriptor) {
    // 全局 documentation() 是同步入口，不能在这里伪造一个 backend。只展示所有连接都安全成立的
    // common surface；connection-specific/override 成员由 browser.documentation() 展示。
    return {
      ...api,
      objects: Object.fromEntries(
        Object.entries(api.objects).map(([objectName, object]) => [
          objectName,
          {
            members: object.members
              .filter(
                (member) =>
                  (member.unsupportedByDefaultIn?.length ?? 0) === 0 &&
                  (member.requiresCapabilities?.length ?? 0) === 0,
              )
              .map((member) => ({
                ...member,
                ...(member.declarations
                  ? {
                      declarations: member.declarations.filter(
                        (declaration) =>
                          (declaration.unsupportedByDefaultIn?.length ?? 0) === 0 &&
                          (declaration.requiresCapabilities?.length ?? 0) === 0,
                      ),
                    }
                  : {}),
              })),
          },
        ]),
      ),
    };
  }
  const policy = new BrowserApiPolicy(api, descriptor);
  return {
    ...api,
    objects: Object.fromEntries(
      Object.keys(api.objects).map((objectName) => [
        objectName,
        { members: policy.supportedMembers(objectName) },
      ]),
    ),
  };
}

// 对外契约：四个早返回分别是无根目录、无 api 无 manifest、按名找不到、空结果回退，顺序不可调整。
// 同步签名是硬约束：全局 documentation 入口依赖它同步返回，内部再慢也不能改成 Promise。
// name 传空字符串等价于未指定，只有真值才进入按名分支。
export function loadBrowserDocumentation(
  documentationRoot?: string,
  name?: string,
  descriptor?: BrowserBackendDescriptor,
): string {
  if (!documentationRoot) {
    if (name) throw new Error(`Browser documentation not found: ${name}`);
    return FALLBACK_DOCUMENTATION;
  }
  const apiPath = join(documentationRoot, "api.json");
  const hasApi = existsSync(apiPath);
  const api = loadBrowserApiManifest(documentationRoot);
  const manifest = readJson<BrowserDocumentsManifest>(join(documentationRoot, "documents.json"));
  if (!hasApi && !manifest) {
    if (name) throw new Error(`Browser documentation not found: ${name}`);
    return FALLBACK_DOCUMENTATION;
  }

  if (name) {
    const document = manifest?.documents?.find((candidate) => {
      const pathName = candidate.path?.replace(/\.md$/u, "");
      return (
        (candidate.name === name || pathName === name) &&
        documentApplies(candidate, descriptor, api)
      );
    });
    const markdown = document?.path ? readMarkdown(documentationRoot, document.path) : undefined;
    if (!markdown) throw new Error(`Browser documentation not found: ${name}`);
    return markdown;
  }

  const sections: string[] = [];
  if (descriptor) {
    sections.push(
      [
        "# Selected Browser",
        `- Name: ${descriptor.name}`,
        `- Type: ${descriptor.type}`,
        `- ID: ${descriptor.id}`,
        // Browser descriptor 持久，但承载它的 JavaScript wrapper 每次调用都会销毁。
        "Recreate this browser wrapper in every fresh Browser Use call using the same verified selection. A new user turn, fresh kernel, or tab error does not invalidate the browser backend; select another browser only when the browser-selection policy requires it.",
        "If a tab is stale or missing later, recover or create a tab after inspecting current tab facts; never switch browser backend merely to recover a tab. Empty controlled-tab lists are normal after explicit close or session release and do not invalidate the selected browser backend.",
      ].join("\n"),
    );
  }
  const title = manifest?.title ?? "Built-in Browser Automation API";
  sections.push(`# ${title}`);
  const apiText = formatApi(effectiveApi(api, descriptor));
  if (apiText) sections.push(apiText);
  for (const doc of manifest?.documents ?? []) {
    if (!doc.path || doc.mode === "lookup" || !documentApplies(doc, descriptor, api)) continue;
    const markdown = readMarkdown(documentationRoot, doc.path);
    if (markdown) sections.push(markdown);
  }
  return sections.filter(Boolean).join("\n\n").trim() || FALLBACK_DOCUMENTATION;
}
