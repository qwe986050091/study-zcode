// INV-01 断言必须跑在真实 guest：守住位置 按类型筛选页面；改错故障 用字符串模拟样式导致结论失真。
// INV-02 焦点由协议强制：守住位置 强制伪类调用；改错故障 无系统焦点时焦点样式永远测不到。
// INV-03 探针每轮重建：守住位置 注入脚本先建节点；改错故障 残留节点污染下一轮读数。
// INV-04 组合必须全覆盖：守住位置 主题、宽度与字号三层循环；改错故障 漏测窄屏或大字号。
// INV-05 读数前等待投影收敛：守住位置 动画帧轮询；改错故障 读到上一轮的字号。
// INV-06 收敛必须有上限：守住位置 三秒截止；改错故障 回归时用例永久挂起。
// INV-07 标题字号与档位联动：守住位置 三档标题断言；改错故障 层级与字号脱钩。
// INV-08 圆角随嵌套递减：守住位置 四级卡片断言；改错故障 嵌套卡片视觉等权。
// INV-09 控件高度是固定契约：守住位置 按钮与输入断言；改错故障 行高随字号漂移。
// INV-10 禁用态只降透明度：守住位置 透明值断言；改错故障 禁用按钮被当成可点。
// INV-11 两种勾选控件分开校验：守住位置 复选框与开关断言；改错故障 尺寸互相串味。
// INV-12 输入与下拉底色同源：守住位置 两值相等断言；改错故障 主题切换后一处掉队。
// INV-13 探针读数与宿主令牌互证：守住位置 宿主侧变量解析；改错故障 探针自证造成假通过。
// INV-14 焦点色全部来自令牌：守住位置 四条期望值比较；改错故障 硬编码色值绕过主题。
// INV-15 选中与半选同色：守住位置 两条主色断言；改错故障 半选状态视觉不一致。
// INV-16 读数脚本先复位再返回：守住位置 末尾清理语句；改错故障 焦点与选中泄漏到后续用例。
// INV-17 清理必须无条件执行：守住位置 收尾块；改错故障 断言失败后探针永久残留。
// INV-18 清理同时还原根元素：守住位置 移除变量与主题类；改错故障 字号污染后续批次。
//
// 模块职责：在真实 Electron guest 中校验统一风格令牌的投影结果。
// 状态所有权：探针节点与调试会话都由本用例临时创建、临时销毁。
// 阅读顺序：先看目标附着与探针注入，再看循环里的读数与断言，最后看清理。
import assert from "node:assert/strict";
import { webContents, type BrowserWindow } from "electron";
import { checkCompactButtons } from "./compact-button-checks.js";
import { checkControlStates } from "./control-state-checks.js";

/** 用真实 guest computed style 验证 token 同步和容器层级，不用 CSS 字符串模拟浏览器。 */
// 宿主窗口先取焦点，避免读取落到后台帧。
// guest 是唯一带 webview 类型的页面。
// debugger 以 flatten: true 附着到实例页的 targetId。
// 实例页 URL 由 mainFrame.frames 里包含 /instance/ 的帧筛出。
// target 从 Target.getTargets 返回的 targetInfos 中按 URL 精确匹配。
export async function checkUnifiedStyles(win: BrowserWindow, read: (code: string) => Promise<any>) {
  win.focus();
  const guest = webContents
    .getAllWebContents()
    .find((contents) => contents.getType() === "webview")!;
  // 自动化窗口未必拥有系统焦点；通过 CDP 强制伪类，由 Chromium 验证焦点样式。
  // win.focus() 先取焦点，避免 computed style 读到后台帧。
  // CSS.forcePseudoState 让 Chromium 自行计算 :hover 与 :focus 样式。
  // attachToTarget() 返回的 sessionId 供后续 send() 共用。
  // 不支持 CDP 的构建在 debugger.attach() 处直接抛错。
  // attach 失败不吞掉，由上层用例上报。
  guest.debugger.attach("1.3");
  const { targetInfos } = await guest.debugger.sendCommand("Target.getTargets");
  const url = guest.mainFrame.frames.find((frame) => frame.url.includes("/instance/"))!.url;
  const target = targetInfos.find((info: { url: string }) => info.url === url);
  const { sessionId } = await guest.debugger.sendCommand("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  // send() 闭包固定 sessionId，省去每次传参。
  // params 默认空对象，便于 DOM.enable 这类无参命令。
  // 探针覆盖 h1 / button / input 与四层 card 嵌套。
  // #style-probe *{transition:none} 关闭过渡，避免读数抖动。
  const send = (method: string, params = {}) =>
    guest.debugger.sendCommand(method, params, sessionId);
  await send("DOM.enable");
  await send("CSS.enable");
  await read(`(() => {
    const probe=document.createElement('div');probe.id='style-probe';
    probe.innerHTML='<style>#style-probe *{transition:none}</style><h1>Heading</h1><h2>Heading</h2><h3>Heading</h3><button class="btn">Outline</button><button class="btn btn-primary">Primary</button><button class="btn btn-secondary">Secondary</button><button class="btn btn-ghost" disabled>Ghost</button><input class="form-control" id="genui-focus-probe" placeholder="Input"><select class="form-select"><option>Option</option></select><textarea class="form-control">Text</textarea><label class="form-check"><input type="checkbox" class="form-check-input">Check</label><label class="form-check form-switch"><input type="checkbox" class="form-check-input">Switch</label><div class="card"><div><button class="btn">First</button><div class="card"><div><button class="btn">Second</button><div class="card"><button class="btn">Third</button><div class="card">Fourth</div></div></div></div></div></div>';
    document.body.append(probe);
  })()`);
  await send("DOM.getDocument", { depth: -1 });
  const search = await send("DOM.performSearch", { query: "#genui-focus-probe" });
  assert.equal(search.resultCount, 1);
  const { nodeIds } = await send("DOM.getSearchResults", {
    searchId: search.searchId,
    fromIndex: 0,
    toIndex: 1,
  });
  await send("CSS.forcePseudoState", {
    nodeId: nodeIds[0],
    forcedPseudoClasses: ["focus", "focus-visible"],
  });
  try {
    for (const dark of [false, true]) {
      for (const width of [1100, 390]) {
        for (const size of [14, 18]) {
          await win.webContents.executeJavaScript(`(() => {
            const root=document.documentElement;root.classList.toggle('dark',${dark});
            root.classList.toggle('theme-zai-dark',${dark});root.classList.toggle('theme-zai-light',${!dark});
            root.style.setProperty('--ui-font-size','${size}px');document.querySelector('#root').style.width='${width}px';
          })()`);
          await read(`new Promise((resolve,reject)=>{
            const end=Date.now()+3000;const tick=()=>{
              if(getComputedStyle(document.querySelector('#style-probe .btn')).fontSize==='${size}px' && document.documentElement.dataset.theme==='${dark ? "dark" : "light"}')resolve(true);
              else if(Date.now()>end)reject(new Error('Style projection did not settle'));else requestAnimationFrame(tick);
            };tick();
          })`);
          const actual = await read(`(() => {
            const root=document.querySelector('#style-probe');
            const css=selector=>getComputedStyle(root.querySelector(selector));
            return {headings:[...root.querySelectorAll('h1,h2,h3')].map(node=>getComputedStyle(node).fontSize),
              radius:[...root.querySelectorAll('.card')].map(node=>getComputedStyle(node).borderRadius),
              controls:[...root.querySelectorAll('.card .btn')].map(node=>getComputedStyle(node).borderRadius),
              buttonHeight:css('.btn').minHeight,inputHeight:css('.form-control').minHeight,
              textareaHeight:css('textarea').minHeight,disabled:css('.btn-ghost').opacity,
              checkbox:css('.form-check-input').width,switchHeight:css('.form-switch input').height,
              inputBg:css('.form-control').backgroundColor,primary:css('.btn-primary').backgroundColor,
              foreground:css('.btn-ghost').color,selectBg:css('.form-select').backgroundColor};
          })()`);
          assert.deepEqual(actual.headings, [`${size + 4}px`, `${size + 2}px`, `${size}px`]);
          await checkCompactButtons(read, send);
          await checkControlStates(read, send);
          assert.deepEqual(actual.radius, ["12px", "8px", "6px", "4px"]);
          assert.deepEqual(actual.controls, ["8px", "6px", "4px"]);
          assert.equal(actual.buttonHeight, "28px");
          assert.equal(actual.inputHeight, "36px");
          assert.equal(actual.textareaHeight, "64px");
          assert.equal(actual.disabled, "0.5");
          assert.equal(actual.checkbox, "16px");
          assert.equal(actual.switchHeight, "18px");
          assert.equal(actual.inputBg, actual.selectBg);
          const host = await win.webContents.executeJavaScript(`(() => {
            const css=getComputedStyle(document.documentElement);
            const resolve=name=>{const node=document.createElement('span');node.style.color=css.getPropertyValue(name);document.body.append(node);const color=getComputedStyle(node).color;node.remove();return color;};
            return {input:resolve('--color-input'),primary:resolve('--color-primary')};
          })()`);
          assert.equal(actual.inputBg, host.input);
          assert.equal(actual.primary, host.primary);
          const states = await read(`(() => {
            const root=document.querySelector('#style-probe'), input=root.querySelector('input');input.focus();
            const check=root.querySelector('.form-check-input');check.click();
            const css=getComputedStyle(input);const checked=getComputedStyle(check).backgroundColor;
            check.indeterminate=true;const mixed=getComputedStyle(check).backgroundColor;
            const toggle=root.querySelector('.form-switch input');toggle.click();
            const outline=root.querySelector('.btn');outline.setAttribute('aria-pressed','true');
            input.focus();
            const result={focusVisible:input.matches(':focus-visible'),active:document.activeElement?.outerHTML,focused:document.hasFocus(),border:css.borderColor,background:css.backgroundColor,
              placeholder:getComputedStyle(input,'::placeholder').color,checked,mixed,switchColor:getComputedStyle(toggle).backgroundColor,
              selected:getComputedStyle(outline).backgroundColor,indeterminateMark:getComputedStyle(check,'::before').height};
            input.blur();outline.removeAttribute('aria-pressed');check.checked=false;check.indeterminate=false;toggle.checked=false;return result;
          })()`);
          const expected = await win.webContents.executeJavaScript(`(() => {
            const root=getComputedStyle(document.documentElement);const resolve=name=>{const node=document.createElement('span');node.style.color=root.getPropertyValue(name);document.body.append(node);const value=getComputedStyle(node).color;node.remove();return value;};
            return {border:resolve('--color-input-border-focused'),background:resolve('--color-input-focused'),placeholder:resolve('--color-foreground-subtlest'),selected:resolve('--color-selected')};
          })()`);
          assert.match(states.active, /genui-focus-probe/);
          assert.equal(states.border, expected.border);
          assert.equal(states.background, expected.background);
          assert.equal(states.placeholder, expected.placeholder);
          assert.equal(states.checked, host.primary);
          assert.equal(states.mixed, host.primary);
          assert.equal(states.switchColor, host.primary);
          assert.equal(states.selected, expected.selected);
          assert.equal(states.indeterminateMark, "2px");
        }
      }
    }
  } finally {
    await send("CSS.forcePseudoState", { nodeId: nodeIds[0], forcedPseudoClasses: [] });
    guest.debugger.detach();
    await read("document.querySelector('#style-probe').remove()");
    await win.webContents.executeJavaScript(
      "document.documentElement.style.removeProperty('--ui-font-size');document.documentElement.classList.remove('theme-zai-dark','theme-zai-light');document.querySelector('#root').style.width=''",
    );
  }
}
