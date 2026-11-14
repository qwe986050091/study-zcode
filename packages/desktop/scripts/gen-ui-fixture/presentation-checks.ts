// 职责边界：本文件是 Gen UI 预览的 E2E 断言层，只做观测与判定；不生产 UI、不改样式、不修 fixture。
// 运行位置：Electron 主进程用例，经 win.webContents.executeJavaScript 在渲染进程取证，guest 为 webview 的 WebContents。
// 上游依赖：checkPreviewCorners（圆角）与 checkUnifiedStyles（统一样式）由本文件串行调用，任一步失败即整文件中止。
// 被测对象：gen-ui-actions 复制按钮、copy/copyImage 截图链路、inline 卡片布局、原生滚动条、内容尺寸与视口反馈。
// 禁止事项：断言里不改被测实现、不用固定 sleep 代替可见状态、不吞 Promise rejection、不为过测放宽阈值。
//
// INV 表（不变量：任何重构都不得破坏的观测事实；改动前先读对应条目，改后必须仍成立）
// INV-01 断言：preview 为真时必须先跑 checkPreviewCorners 再读复制按钮 —— 守住它的位置：checkCopyButton 首行 —— 改错故障：圆角回归被吞进复制用例，失败信息指向错误模块。
// INV-02 断言：复制按钮初始 disabled === false —— 守住它的位置：buttonState 首次采集 —— 改错故障：按钮被误禁用后轮询超时，报错退化为 did not become available，无法定位。
// INV-03 断言：点击后 clipboard.readImage().isEmpty() === false —— 守住它的位置：两次 attempt 内首个断言 —— 改错故障：复制静默失败仍判通过，交付物缺图。
// INV-04 断言：两轮复制后按钮快照 title/aria-label/svg/disabled 与 initial 深度相等 —— 守住它的位置：循环末尾 deepEqual —— 改错故障：loading 态残留在 UI，用户看到永久转圈。
// INV-05 断言：剪贴板图宽 === floor((viewport-5)*W/vw) - ceil(5*W/vw) —— 守住它的位置：checkCapture 宽度公式 —— 改错故障：dpr 换算回归导致导出图裁边而无人发现。
// INV-06 断言：initId+1 的 copyImage 以 /no longer available/ 拒绝 —— 守住它的位置：首个 assert.rejects —— 改错故障：过期句柄可继续截图，跨会话数据泄漏。
// INV-07 断言：captureRect.x === -1 以 /too_small|greater|minimum/ 拒绝 —— 守住它的位置：第二个 assert.rejects —— 改错故障：负坐标被静默夹取，截出错误区域。
// INV-08 断言：同一 request 在另一 BrowserWindow 中同样以 /no longer available/ 拒绝 —— 守住它的位置：otherWindow 用例 —— 改错故障：句柄跨窗口复用，破坏 window-scoped Host 边界。
// INV-09 断言：stop() 后放行 capturePage，copyResult 匹配 /no longer available/ 且剪贴板仍为 sentinel —— 守住它的位置：checkStaleCapture 末两条断言 —— 改错故障：竞态把过期截图写进剪贴板，覆盖用户内容。
// INV-10 断言：卡片宽度 === 父 clientWidth 减左右 padding（8 组 mode×width 全部成立） —— 守住它的位置：checkParentWidth 循环断言 —— 改错故障：定宽后二次截断，图表与长表格被挤窄。
// INV-11 断言：卡片 borderWidth 0px、背景透明、body 14px、small 12px —— 守住它的位置：checkInlineLayout 样式断言 —— 改错故障：宿主样式泄漏进沙箱 UI，视觉偏离设计稿。
// INV-12 断言：expected 高度与 innerHeight 差 ≤1、scrollbar none、scrollY 0、反馈 24 帧后收敛 —— 守住它的位置：checkContentSizing/checkNativeScroll —— 改错故障：双滚动条或高度震荡，窗口无法稳定。
//
// 断言失败约定：每条 assert 都带 JSON 上下文（实测值、期望值、档位名），凭日志即可复现，不依赖重跑。
// 检查顺序约定：先建前置（preview corners）→ 再取证（DOM/剪贴板）→ 最后做写操作（点击/拖拽），避免污染后置观测。
// fixture 口径约定：尺寸探针与视口宽度均为确定性注入，与生产判定口径一致，不用「差不多」的容差掩盖真实回归。
// 忽略项（显式排除）：像素级视觉比对、主题色值、i18n 文案、性能耗时；这些维度不做模糊断言，避免假通过。
// 超时约定：页面内轮询一律 requestAnimationFrame + 显式 deadline（2s/4s/5s），超时抛出带步骤名的 Error，不无限等待。
// 资源约定：debugger attach 后 finally detach，临时窗口 destroy，注入样式与节点在 finally 清理，避免跨用例串味。
// 并发约定：同一 win/guest 上的用例必须串行；复制与截图共享剪贴板，禁止并行，否则相互覆盖。
// 回读约定：读态优先用 executeJavaScript 返回值，不解析截图；截图仅作 artifacts 留档，不作唯一判据。
//
// 维护提示：新增断言先补 INV 条目，再补可定位的失败信息，最后才动实现；删断言须说明被哪条 INV 覆盖。
import { BrowserWindow, clipboard, type WebContents } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { checkPreviewCorners } from "./preview-corner-checks.js";
import { checkUnifiedStyles } from "./style-checks.js";

// [契约] 入口只接 win 与 preview 标记；preview=true 时先把圆角检查跑完，保证后续 DOM 断言建立在已渲染的 dialog 上。
// selector 随 preview 切换作用域前缀，禁止两处硬编码，避免预览与内联取到不同按钮。
// 本函数不返回证据对象，失败语义全部由 assert 的第二个参数承担；新增断言必须自带上下文。
// 调用方按 copy 用例名上报失败，因此函数内部不要捕获后重抛成通用错误，否则会丢掉步骤名。
export async function checkCopyButton(win: BrowserWindow, preview = false) {
  if (preview) await checkPreviewCorners(win);
  // [契约] selector 是唯一取按钮入口，preview 分支只改作用域前缀，按钮定位语义（gen-ui-actions 内的 button）不得改动。
  // 若改成 querySelectorAll，必须确认只取首个且顺序稳定，否则 aria-label 与 icon 断言会命中错误元素。
  // 选择器通过 JSON.stringify 注入页面，禁止直接模板拼接，避免引号或反引号注入导致脚本语法错误。
  // 失败时日志需能回显 selector 原文，便于区分「UI 未渲染」与「选择器过期」两类原因。
  const selector = `${preview ? '[role="dialog"] ' : ""}[data-testid="gen-ui-actions"] button`;
  const buttonState = () =>
    win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      return {title: button.title, label: button.getAttribute('aria-label'),
        icon: button.querySelector('svg').outerHTML, disabled: button.disabled};
    })()`);
  // [契约] initial 是两轮循环的共同基准，必须在任何点击之前采集，否则会把 loading 态当成稳态。
  // buttonState 读 title、aria-label、svg.outerHTML、disabled 四项；任一为 undefined 说明按钮结构变了，应直接失败。
  // 用 deepEqual 而非 equal，因为返回对象；比较前不要裁剪 icon 字符串，SVG 属性变化属于真实回归。
  // 若按钮尚未挂载，此处抛 TypeError 是期望行为：失败点应指向「未渲染」，而不是后续 5s 超时。
  const initial = await buttonState();
  assert.equal(initial.disabled, false);
  // [并发] 固定两次 attempt 覆盖「首次复制 + 再复制」路径，验证幂等，不引入重试退避也不做 flaky 重跑。
  // 每轮先 clipboard.clear()，确保 isEmpty 断言只反映本轮写入，不受上一轮残留污染。
  // 两轮都成功才通过；只成功一次说明存在状态残留，属于必须暴露的缺陷，不得改成 break 放行。
  // 轮询 deadline 为 5s，超时文案固定为 Copy button did not become available，日志检索依赖该字面量。
  for (let attempt = 0; attempt < 2; attempt++) {
    clipboard.clear();
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const button = document.querySelector(${JSON.stringify(selector)});
      button.click();
      const end = Date.now() + 5000;
      const tick = () => {
        if (!button.disabled) resolve(true);
        else if (Date.now() > end) reject(new Error('Copy button did not become available'));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);
    assert.equal(clipboard.readImage().isEmpty(), false);
    // [契约] 这是循环收口断言：复制完成后 UI 必须回到 initial 快照，即无 loading 残影、无 disabled 漂移。
    // 放在剪贴板断言之后是刻意的：先证明产出存在，再证明状态复原，失败位置即可指向「产出」或「状态」。
    // deepEqual 会一并比较 icon 的 outerHTML，能在图标被替换时失败；不要为过测降级成存在性检查。
    // 当前未附实际快照，属已知缺口；新增断言时应补 JSON 上下文，避免只看到 AssertionError。
    assert.deepEqual(await buttonState(), initial);
  }
}

// [资源] guest 是 webview 的 WebContents，本函数只在主进程侧调用 capturePage，不接管其生命周期。
// 顺序固定：copy() → 剪贴板非空 → fullImage → viewport 几何 → 宽度换算，前一步是后一步的前提。
// root 仅用于 otherWindow 的 preload 路径，不参与被测页面加载，避免误以为换了被测环境。
// 本函数不销毁 guest，由 fixture 统一管理；重复 destroy 会破坏后续用例。
export async function checkCapture(
  win: BrowserWindow,
  guest: WebContents,
  latestHandle: PluginSandboxHandle,
  root: string,
) {
  await win.webContents.executeJavaScript("window.copy()");
  assert.equal(clipboard.readImage().isEmpty(), false);
  const fullImage = await guest.capturePage();
  const viewport = await win.webContents.executeJavaScript(
    "document.querySelector('webview').getBoundingClientRect().toJSON()",
  );
  const copiedSize = clipboard.readImage().getSize();
  assert.equal(
    copiedSize.width,
    Math.floor(((viewport.width - 5) * fullImage.getSize().width) / viewport.width) -
      Math.ceil((5 * fullImage.getSize().width) / viewport.width),
  );
  // [契约] request 是 copyImage 的输入契约：sandboxId/initId 标识句柄，viewportSize 与 captureRect 必须同为 CSS 像素。
  // captureRect 内缩 5px 对应窗口描边，与宽度公式里的 -5 是同一常量，改一处必须同步另一处。
  // viewportSize 用实测 getBoundingClientRect 而非写死，保证 dpr 或缩放变化时换算仍成立。
  // 后续用 spread 派生非法变体，保持原对象不可变；禁止先改字段再断言，否则无法判断哪次调用失败。
  const request = {
    sandboxId: latestHandle.sandboxId,
    initId: latestHandle.initId,
    viewportSize: { width: viewport.width, height: viewport.height },
    captureRect: { x: 5, y: 5, width: viewport.width - 10, height: viewport.height - 10 },
  };
  const copyRequest = (value: unknown) =>
    `window.zcodePluginSandbox.copyImage(${JSON.stringify(value)})`;
  await assert.rejects(
    // [失败路径] 用 initId+1 构造「已失效句柄」，断言必须以 /no longer available/ 拒绝，而非静默成功或抛其他错。
    // 正则刻意收窄到该文案，避免把参数校验错误误判为句柄失效；两种拒绝原因必须能区分。
    // 直接 rejects 而非先看 resolve 值，是为了确认实现没有「吞异常返回 undefined」的兜底分支。
    // 若实现改文案，此断言必须同步更新，不能改成宽松通配正则放水；失败时应打印原 request 以便定位。
    win.webContents.executeJavaScript(copyRequest({ ...request, initId: request.initId + 1 })),
    /no longer available/,
  );
  await assert.rejects(
    win.webContents.executeJavaScript(
      copyRequest({ ...request, captureRect: { ...request.captureRect, x: -1 } }),
    ),
    /too_small|greater|minimum/,
  );
  // [资源] 临时窗口 show:false + about:blank，仅承载 preload，用于验证句柄不跨窗口；它不属于被测 UI。
  // 顺序上放在同窗口断言之后，确保前面失败时不会留下孤儿窗口。
  // destroy 应在断言之后无条件执行；当前 rejects 抛错会跳过 destroy，属已知风险，新增用例应在 finally 收尾。
  // 跨窗口仍以 /no longer available/ 为准，证明 sandbox 句柄绑定 window 而非进程。
  const otherWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(root, "preload.cjs") },
  });
  await otherWindow.loadURL("about:blank");
  await assert.rejects(
    otherWindow.webContents.executeJavaScript(copyRequest(request)),
    /no longer available/,
  );
  otherWindow.destroy();
}

// [并发] 本用例专门制造「截图已开始、页面已 stop」的交错，用 gate 精确控制放行点，不用 sleep 猜时序。
// captureStarted 与 captureGate 两个 withResolvers 构成屏障：前者等原生截图进入，后者决定何时返回。
// 替换 guest.capturePage 后不恢复原函数，依赖 guest 随用例结束而销毁，避免误用旧实现。
// 断言目标是拒绝语义与剪贴板不被覆盖，两者缺一不可。
export async function checkStaleCapture(win: BrowserWindow, guest: WebContents) {
  const captureStarted = Promise.withResolvers<void>(),
    captureGate = Promise.withResolvers<void>();
  const nativeCapture = guest.capturePage.bind(guest);
  // [并发] 覆写只包一层：先取原生图，再 resolve started、await gate，最后原样返回，不修改图像内容。
  // 若在 await gate 前抛错，started 永不 resolve，用例会挂死而非失败；因此错误必须让主流程可见。
  // gate 由主流程在 stop() 之后 resolve，保证被测代码观察到的是「stop 之后」的世界。
  // 覆写生效期间禁止其它用例访问 guest，否则会拿到被包裹的实现，得到不可比的结果。
  guest.capturePage = async () => {
    const image = await nativeCapture();
    captureStarted.resolve();
    await captureGate.promise;
    return image;
  };
  // [资源] 先用 sentinel 文本占位，用于证明失败的复制没有写剪贴板；字面量固定便于日志核对。
  // 断言等值比较 sentinel 而非 isEmpty，因为空剪贴板也可能由清空导致，无法区分「未写」与「被清空」。
  // 若实现改成写空图，readText 会变空，此处仍能抓住，这是选文本而非位图的原因。
  // 用例不恢复剪贴板原文，依赖后续用例自行 clear，属有意的隔离取舍。
  clipboard.writeText("capture-stale-sentinel");
  await win.webContents.executeJavaScript(
    "window.copyResult=window.copy().then(()=>'',error=>String(error)); 'pending'",
  );
  await captureStarted.promise;
  await win.webContents.executeJavaScript("window.stop()");
  captureGate.resolve();
  assert.match(await win.webContents.executeJavaScript("window.copyResult"), /no longer available/);
  assert.equal(clipboard.readText(), "capture-stale-sentinel");
}

// [契约] 内联布局是组合检查器：父宽度 → 卡片样式 → 字号 → 滚动锚定 → 原生滚动 → 内容尺寸 → 统一样式，顺序不可交换。
// checkParentWidth 先跑，因为它会改 #root 宽度；后续断言若先跑，会在被改过的宽度下取证。
// 每步结束清空 #root 宽度，保证下一步从未污染的布局开始；漏清会让失败点漂移。
// 本函数只读样式、不改设计值，任何「临时改样式帮助通过」都属于越界。
export async function checkInlineLayout(
  win: BrowserWindow,
  read: (code: string) => Promise<any>,
  artifacts: string,
) {
  await checkParentWidth(win, read);
  assert.equal(
    await win.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('[data-testid=gen-ui-card]')).borderWidth",
    ),
    "0px",
  );
  assert.equal(
    await win.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('[data-testid=gen-ui-card]')).backgroundColor",
    ),
    "rgba(0, 0, 0, 0)",
  );
  // [权衡] 字号用像素等值而非容差：14px 与 12px 是设计基线，缩放导致的 13.99 属于真实回归。
  // small 断言前主动插入 .text-small 元素，是为了在受控 DOM 上验证 class 生效，不依赖页面已有内容。
  // 插入节点不删除，留在 preview 中供后续样式检查复用；若后续断言依赖干净 DOM，必须显式清理。
  // 读态用 read（渲染进程）而非截图，避免字体渲染差异带来假失败。
  assert.equal(await read("getComputedStyle(document.body).fontSize"), "14px");
  await read(
    "document.querySelector('#preview').insertAdjacentHTML('beforeend','<small class=\"text-small text-muted\">Units and source</small>')",
  );
  assert.equal(await read("getComputedStyle(document.querySelector('small')).fontSize"), "12px");
  // [契约] 该脚本验证滚动时 webview 顶部相对 scroller 的偏移恒定，即滚动锚定没有抖动。
  // offsets 序列 [0,80,260,40,480,0] 覆盖上滚、下滚、回顶，含一次反向，能暴露单向缓存型缺陷。
  // 每档取两帧（移动后立即 + 下一帧）比对，可捕捉一帧迟滞；只用单帧会漏掉过渡态。
  // 返回 errors 数组而不在页面内断言，是为了在 Node 侧拼出完整证据再失败。
  const scrollErrors = await win.webContents.executeJavaScript(`(async () => {
      const scroller=document.querySelector('#gen-ui-scroll'), view=document.querySelector('webview');
      const initial=view.getBoundingClientRect().top+scroller.scrollTop;
      const errors=[];
      for(const offset of [0,80,260,40,480,0]) {
        scroller.scrollTop=offset;
        errors.push(Math.abs(view.getBoundingClientRect().top+scroller.scrollTop-initial));
        await new Promise(requestAnimationFrame);
        errors.push(Math.abs(view.getBoundingClientRect().top+scroller.scrollTop-initial));
      }
      return errors;
    })()`);
  assert.ok(
    // [契约] 阈值 1px 是亚像素容差上限，超过即视为锚定漂移；不要为过测放宽到 2。
    // 失败信息用 JSON.stringify(scrollErrors) 保留全部档位，便于判断是单点异常还是整体偏移。
    // every 对空数组返回 true，脚本必须保证返回非空；若改成可能空返回，这里会静默通过，需补长度断言。
    // 该断言只覆盖顶部锚定，底部回弹由 checkContentSizing 的 scrollY 断言承担。
    scrollErrors.every((error: number) => error < 1),
    JSON.stringify(scrollErrors),
  );
  await win.webContents.executeJavaScript("document.querySelector('#root').style.width='380px'");
  await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true);
  await win.webContents.executeJavaScript("document.querySelector('#root').style.width=''");
  await checkNativeScroll(win);
  await checkContentSizing(win, read, artifacts);
  await checkUnifiedStyles(win, read);
}

// [权衡] 736/1024 是生成侧设计参考，宿主会话列已定宽，因此只断言「卡片 == 父可用宽度」，不回归设计参考值。
// modes × widths 共 8 组，最后一档重复 1200 用于验证切回后无残留，重复档不是冗余。
// retained 记录 webview 节点是否复用，防止 setInlineMode 重建 webview 导致状态丢失却被宽度断言掩盖。
// 失败信息必须带 measured（mode/width/card/available），否则无法判断是哪一档、差多少。
async function checkParentWidth(win: BrowserWindow, read: (code: string) => Promise<any>) {
  // 修复回归：736/1024 是生成时的设计参考，不应在已经定宽的会话列中再次截断卡片。
  const measurements = await win.webContents.executeJavaScript(`(async () => {
    const root=document.querySelector('#root'), result=[];
    const view=document.querySelector('webview');
    for (const mode of ['normal','wide']) {
      window.setInlineMode(mode);
      for (const width of [1200,900,390,1200]) {
        root.style.width=width+'px';
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const card=document.querySelector('[data-testid=gen-ui-card]');
        const parent=card.parentElement, style=getComputedStyle(parent);
        result.push({mode,width,card:card.getBoundingClientRect().width,
          available:parent.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
          retained:document.querySelector('webview')===view});
      }
    }
    root.style.width='';
    return result;
  })()`);
  // [契约] 逐条断言而非聚合，保证首个失败即停在最小反例上，日志里能直接看到该档参数。
  // 容差 < 1 与滚动锚定一致，均按亚像素处理；整数像素下应严格相等。
  // available 用 clientWidth 减左右 padding，不用 offsetWidth，避免把边框算进可用宽度。
  // retained 单独断言，与宽度解耦，防止宽度正确但 webview 被重建的假通过。
  for (const measured of measurements) {
    assert.ok(Math.abs(measured.card - measured.available) < 1, JSON.stringify(measured));
    assert.equal(measured.retained, true);
  }
  await win.webContents.executeJavaScript("document.querySelector('#root').style.width='390px'");
  await read("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true);
  await win.webContents.executeJavaScript("document.querySelector('#root').style.width=''");
}

// [资源] 本函数直接接管 debugger：attach("1.3") 之后所有命令必须在 finally 中 detach，否则后续用例无法 attach。
// 注入滚动条样式是为了让可拖拽区域稳定命中，属于 fixture 手段；样式不撤销是已知副作用。
// 用真实鼠标事件（dispatchMouseEvent）而非 JS 设 scrollTop，才能验证原生滚动条路径。
// 流程固定：按下 → 移动 130px → 抬起 → 等 scrollTop>0 → 校验锚点对齐 → 滚轮回滚，顺序不可乱。
async function checkNativeScroll(win: BrowserWindow) {
  // [契约] 取点在右内边距 6px 处对应 12px 滚动条中心，Math.round 消除小数坐标导致的命中失败。
  // x 依赖注入样式生效；若 append 失败，点击落在内容区，后续会超时并报 Native scrollbar did not move。
  // y 取 top+30 避开圆角与首行控件，属经验值，布局改动后需复核。
  // 该点只算一次，滚轮复用同一点，保证两个阶段的坐标单一来源。
  const point = await win.webContents.executeJavaScript(`(() => {
    const style=document.createElement('style');
    style.textContent='#gen-ui-scroll::-webkit-scrollbar{width:12px}#gen-ui-scroll::-webkit-scrollbar-thumb{background:#888}';
    document.head.append(style);
    const scroller=document.querySelector('#gen-ui-scroll'); scroller.scrollTop=0;
    const rect=scroller.getBoundingClientRect();
    return {x:Math.round(rect.right-6), y:Math.round(rect.top+30)};
  })()`);
  win.webContents.debugger.attach("1.3");
  try {
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y + 130,
      button: "left",
      buttons: 1,
    });
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y + 130,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    // [失败路径] 轮询用 requestAnimationFrame 而非定时器，保证在渲染帧后读取，避免读到未更新的 scrollTop。
    // deadline 2s 是「拖拽未生效」与「机器慢」的分界；超时文案固定，便于区分拖拽失败与滚轮失败。
    // resolve 返回 scroll 值，供后续滚轮断言作为上界，形成「先拖后滚」的单调关系。
    // reject 而非静默 resolve(0)，是防止滚动条失效被当成「已回顶」。
    const dragged = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const end=Date.now()+2000; const tick=()=>{
        const scroll=document.querySelector('#gen-ui-scroll').scrollTop;
        if(scroll>0) resolve(scroll); else if(Date.now()>end) reject(new Error('Native scrollbar did not move')); else requestAnimationFrame(tick);
      }; tick();
    })`);
    assert.ok(dragged > 0);
    assert.ok(
      await win.webContents.executeJavaScript(
        `Math.abs(document.querySelector('[data-testid=gen-ui-anchor]').getBoundingClientRect().top-document.querySelector('webview').getBoundingClientRect().top)<1`,
      ),
    );
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: -60,
    });
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const end=Date.now()+2000; const tick=()=>{
        const scroll=document.querySelector('#gen-ui-scroll').scrollTop;
        if(scroll<${dragged}) resolve(scroll); else if(Date.now()>end) reject(new Error('Native wheel did not move')); else requestAnimationFrame(tick);
      }; tick();
    })`);
  } finally {
    win.webContents.debugger.detach();
  }
  await win.webContents.executeJavaScript(
    "document.querySelector('#gen-ui-scroll').scrollTop=0; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
}

// [契约] 尺寸检查是最后一道：它临时改写 body 结构，必须在 finally 中完整还原，否则污染同窗口后续用例。
// sizingOriginal 以 hidden + role=tooltip 收纳原始节点，保留可访问性语义，减少隐藏带来的布局副作用。
// 探针根 [data-sizing-probe] 与宿主 height 反馈构成闭环：内容高度 → 视口高度 → 再测量。
// 断言口径：expected（内容高 + body 上下 padding）与 innerHeight 相差 ≤1，另要求宽度与主题同步收敛。
async function checkContentSizing(
  win: BrowserWindow,
  read: (code: string) => Promise<any>,
  artifacts: string,
) {
  const host = (code: string) => win.webContents.executeJavaScript(code);
  await read(`(() => {
    const originalNodes = [...document.body.childNodes];
    window.sizingOriginal = document.createElement('div');
    sizingOriginal.hidden = true;
    sizingOriginal.setAttribute('role', 'tooltip');
    document.body.append(sizingOriginal);
    sizingOriginal.append(...originalNodes);
    const root = document.createElement('div'); root.dataset.sizingProbe = '';
    root.style.cssText = 'display:flex;flex-direction:column;gap:16px';
    root.innerHTML = '<nav><button id="size-short">Controls</button><button id="size-tall">Charts</button></nav><section id="size-panel"></section>';
    document.body.append(root);
    window.sizePanel = (tall) => {
      document.querySelector('#size-panel').innerHTML = tall
        ? '<svg style="display:block;width:100%;height:auto" viewBox="0 0 1000 300"><path d="M0 250L500 60L1000 120" stroke="currentColor" fill="none" /></svg><div style="height:360.765625px">Chart footer</div>'
        : '<div style="height:180.265625px">Controls</div>';
    };
    document.querySelector('#size-short').onclick = () => sizePanel(false);
    document.querySelector('#size-tall').onclick = () => sizePanel(true);
    sizePanel(false);
    window.sizingRootMutations = 0;
    window.sizingObserver = new MutationObserver(records => sizingRootMutations += records.length);
    sizingObserver.observe(document.documentElement, {attributes:true,attributeFilter:['style']});
  })()`);
  const fitted = async () => {
    const target =
      await host(`({width:document.querySelector('webview').getBoundingClientRect().width,
      theme:document.documentElement.classList.contains('dark')?'dark':'light'})`);
    return read(`new Promise((resolve,reject) => {
    const end = Date.now()+4000;
    const tick = () => {
      const root = document.querySelector('[data-sizing-probe]'), css = getComputedStyle(document.body);
      const expected = Math.ceil(root.getBoundingClientRect().height + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom));
      const measured = {expected, height:innerHeight, width:innerWidth, clientWidth:document.documentElement.clientWidth,
        scrollbar:getComputedStyle(document.documentElement).scrollbarWidth, scrollY};
      if (Math.abs(expected-innerHeight)<=1 && Math.abs(innerWidth-${target.width})<=1 && document.documentElement.dataset.theme===${JSON.stringify(target.theme)}) resolve(measured);
      else if(Date.now()>end) reject(new Error('Content height did not settle: '+JSON.stringify(measured)));
      else requestAnimationFrame(tick);
    }; requestAnimationFrame(tick);
  })`);
  };
  try {
    for (const width of [1100, 390]) {
      await host(`document.querySelector('#root').style.width='${width}px'`);
      for (const theme of ["light", "dark"]) {
        await host(`document.documentElement.classList.toggle('dark',${theme === "dark"})`);
        for (const tab of ["tall", "short", "tall", "short"]) {
          await read(`document.querySelector('#size-${tab}').click()`);
          const size = await fitted();
          assert.equal(size.scrollbar, "none", JSON.stringify(size));
          assert.equal(size.clientWidth, size.width, JSON.stringify(size));
          assert.equal(size.scrollY, 0, JSON.stringify(size));
        }
      }
    }
    // 修复回归：测量不得临时写 html 高度，影响原生滚动条布局。
    await read("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await read("window.sizingRootMutations=0; document.querySelector('#size-tall').click()");
    await fitted();
    assert.equal(await read("window.sizingRootMutations"), 0);
    await read(
      "document.querySelector('#size-panel').insertAdjacentHTML('beforeend','<div id=size-extra style=height:123.5px>More data</div>')",
    );
    await fitted();
    await read("document.querySelector('#size-extra').remove()");
    const beforeTooltip = await fitted();
    await read(
      "document.body.insertAdjacentHTML('beforeend','<div data-sizing-probe role=tooltip style=\"position:absolute;top:2000px\">Tip</div>')",
    );
    await read("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    assert.equal((await fitted()).height, beforeTooltip.height);
    await read("document.querySelector('[role=tooltip][data-sizing-probe]').remove()");
    await host("document.querySelector('#root').style.width='1100px'");
    await fitted();
    await host("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await writeFile(
      join(artifacts, "inline-charts.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    const point = await host(`(() => {
      document.querySelector('#gen-ui-scroll').scrollTop=0;
      const rect=document.querySelector('webview').getBoundingClientRect();
      return {x:Math.round(rect.left+80), y:Math.round(rect.top+120)};
    })()`);
    win.webContents.debugger.attach("1.3");
    try {
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point,
        deltaX: 0,
        deltaY: 160,
      });
      await host(`new Promise((resolve,reject)=>{
        const end=Date.now()+2000; const tick=()=>{
          if(document.querySelector('#gen-ui-scroll').scrollTop>0) resolve(true);
          else if(Date.now()>end) reject(new Error('Wheel over the chart did not scroll the conversation'));
          else requestAnimationFrame(tick);
        };tick();
      })`);
      assert.equal(await read("scrollY"), 0);
    } finally {
      win.webContents.debugger.detach();
      await host("document.querySelector('#gen-ui-scroll').scrollTop=0");
    }
    await read("document.querySelector('#size-panel').style.height='calc(100vh + 10px)'");
    const feedback = await read(`(async () => {
      const heights=[];
      for(let i=0;i<24;i++){await new Promise(requestAnimationFrame); heights.push(innerHeight)}
      return heights;
    })()`);
    assert.equal(new Set(feedback.slice(-8)).size, 1, JSON.stringify(feedback));
    assert.ok(feedback.at(-1) < 2000, JSON.stringify(feedback));
    await read("document.querySelector('#size-panel').style.height='12000px'");
    await host(`new Promise((resolve,reject) => {
      const end=Date.now()+4000; const tick=()=>{
        const height=document.querySelector('[data-testid="gen-ui-anchor"]').style.height;
        if(height==='10000px') resolve(true);
        else if(Date.now()>end) reject(new Error('Height limit did not settle: '+height));
        else requestAnimationFrame(tick);
      };tick();
    })`);
    assert.equal(await read("scrollTo(0,10000); scrollY>0"), true);
    await read(
      "scrollTo(0,0); document.querySelector('#size-panel').style.height=''; sizePanel(false)",
    );
    await fitted();
    process.stdout.write(
      `Gen UI sizing: wide/narrow, light/dark, tabs, nested changes, tooltip and viewport feedback passed\n`,
    );
  } finally {
    await read(
      `sizingObserver.disconnect(); document.body.append(...sizingOriginal.childNodes); sizingOriginal.remove(); document.querySelectorAll('[data-sizing-probe]').forEach(node=>node.remove())`,
    );
    await host(
      "document.querySelector('#root').style.width=''; document.documentElement.classList.remove('dark')",
    );
  }
}
