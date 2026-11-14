// INV-01 只替换最终打开动作：桥接与手势校验走生产实现，守住位置 校验入口与调用；改错故障：整体替换桥接会让用例绕过真实校验，测不到回归。
// INV-02 桥接暴露面固定四个键：守住位置 首个断言；改错故障：新增键未同步会让断言失败或漏测新能力。
// INV-03 等待条件有超时且失败时输出诊断：守住位置 等待函数；改错故障：无超时会在条件永不成立时挂死整条流水线。
// INV-04 点击前必须真正聚焦应用、窗口与页面：守住位置 点击函数首三行；改错故障：未聚焦时手势不被信任，打开被拒。
// INV-05 合成鼠标事件走调试协议注入：守住位置 按下与抬起两次派发；改错故障：用页面脚本派发不被视为可信事件，覆盖不到真实路径。
// INV-06 修饰键先由原生按键登记：守住位置 点击前的按键注入；改错故障：只设事件修饰位时平台手势判定不一致。
// INV-07 调试器必须成对附加与分离：守住位置 两处收尾块；改错故障：异常路径漏分离会让后续用例无法附加。
// INV-08 每次打开都断言次数递增：守住位置 打开断言函数；改错故障：只断言最后一次地址会漏掉重复打开。
// INV-09 打开后页面地址与启动次数不变：守住位置 同一断言函数；改错故障：导航到目标地址会让工作页被替换，后续用例全废。
// INV-10 三种目标属性都走同一打开路径：守住位置 目标遍历；改错故障：只测空目标会漏掉新窗口语义的回归。
// INV-11 修饰点击与中键点击各计一次：守住位置 两处调用；改错故障：遗漏会让组合手势回归无人发现。
// INV-12 键盘回车同样视为手势：守住位置 按键派发段；改错故障：只测鼠标会让键盘可访问性回归。
// INV-13 页面取消默认行为后仍只打开一次：守住位置 取消分支；改错故障：未防重复会让委托处理再开一次。
// INV-14 无手势的程序化打开必须被拒：守住位置 正则断言；改错故障：放行会让恶意页面静默拉起浏览器。
// INV-15 非法协议、下载与片段一律不进入打开器：守住位置 三组断言；改错故障：放行本地文件或脚本协议会形成注入面。
// INV-16 打开器失败要透传为错误文本：守住位置 失败分支；改错故障：吞掉异常会让界面一直处于待打开状态。
// INV-17 页面隐藏或关闭时不再打开：守住位置 隐藏分支；改错故障：隐藏后仍打开会让已关闭面板拉起外部浏览器。
// INV-18 结束后清理探针与事件监听：守住位置 末尾清理；改错故障：残留探针会影响后续用例的点击命中。
//
// 模块职责：校验外链打开与手势授权的真实行为，覆盖目标属性、修饰点击、键盘、非法协议与失败路径。
// 状态所有权：无模块状态；探针元素、事件数组与打开计数都挂在页面全局，用例结束即清理。
// 阅读顺序：先看桥接断言与等待辅助，再看点击注入，最后看打开断言、非法输入与失败分支。
import assert from "node:assert/strict";
import { app, type BrowserWindow, type WebContents } from "electron";

// 使用生产桥接与手势校验；只替换最终 opener，避免测试启动系统浏览器。
// 校验入口只接管最终打开动作，其余走生产实现
// [失败路径] 整体替换桥接会让用例绕过真实校验
// 参数中的读取函数由宿主注入，便于同时读页面与主进程
// 该函数返回即代表全部断言通过，失败直接抛错
// 用例不写报告文件，结果只体现在退出码
export async function checkExternalLinks(
  win: BrowserWindow,
  guest: WebContents,
  read: (code: string) => Promise<any>,
) {
  // checkExternalLinks 的第一条断言用 Object.keys(window.zcode).sort() 对上四个键：先 sort 避免键序变化造成假失败；暴露面一旦多键或少键，后面的手势结论都建立在错误桥接上，必须先失败。
  assert.deepEqual(await read("Object.keys(window.zcode).sort()"), [
    "openExternal",
    "sendFollowUpMessage",
    "setWidgetState",
    "widgetState",
  ]);
  const inspect = () => win.webContents.executeJavaScript("window.inspectReact()");
  // wait 把 predicate 放进 read() 的页面内 Promise，用 requestAnimationFrame 轮询并以 Date.now()+5000 超时；reject 后 catch 汇总 host/guest/shell 三层 DOM 几何写 process.stderr 再抛，缺超时会挂死流水线，写 stdout 会污染通过用例的输出。
  const wait = (predicate: string, execute = read) =>
    execute(`new Promise((resolve,reject)=>{
      const end=Date.now()+5000;
      const tick=()=>{if(${predicate})resolve(true);else if(Date.now()>end)reject(new Error('Link condition timed out: '+${JSON.stringify(predicate)}));else requestAnimationFrame(tick)};
      tick();
    })`).catch(async (error) => {
      process.stderr.write(
        JSON.stringify({
          host: await inspect(),
          guest: await read(
            "({events:window.linkEvents,errors:window.linkErrors,probe:document.getElementById('link-probe').outerHTML,point:document.getElementById('link-probe').getBoundingClientRect().toJSON()})",
          ),
          shell: await guest.mainFrame.executeJavaScript(
            "document.querySelector('iframe').getBoundingClientRect().toJSON()",
          ),
        }) + "\n",
      );
      throw error;
    });
  // click 的顺序固定：app.focus({ steal: true }) → win.focus() → guest.focus()，缺任一层焦点手势都会被判无手势；坐标取 #link-probe 矩形中心，capturePage() 先逼出布局，debugger.attach("1.3") 只包 mousePressed/mouseReleased，finally 里 detach，中键 buttons 为 4、左键为 1。
  const click = async (button: "left" | "middle" = "left", modifiers: string[] = []) => {
    app.focus({ steal: true });
    win.focus();
    guest.focus();
    const point = await read(`(() => {
      const r=document.getElementById('link-probe').getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    })()`);
    await win.webContents.capturePage();
    // CDP 能命中嵌套 iframe，但不发 Electron input-event；先用原生修饰键登记手势。
    guest.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
    guest.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
    guest.debugger.attach("1.3");
    try {
      const keys = modifiers.includes("meta") ? 4 : modifiers.includes("control") ? 2 : 0;
      await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button,
        buttons: button === "middle" ? 4 : 1,
        clickCount: 1,
        modifiers: keys,
      });
      await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button,
        buttons: 0,
        clickCount: 1,
        modifiers: keys,
      });
    } finally {
      guest.debugger.detach();
    }
  };
  // 页面注入的 #link-probe 用 position:fixed 锚定左上角，保证 getBoundingClientRect 坐标可预测；pointerdown/pointerup/click/auxclick 在捕获阶段写入 window.linkEvents（含 isTrusted 与 clientX/Y），zcode:error 写入 window.linkErrors；探针内 <span>Open subscription</span> 提供可聚焦文本，供后面的 Enter 用例使用。
  await read(`(() => {
    const probe=document.createElement('a');probe.id='link-probe';
    probe.style.cssText='position:fixed;top:4px;left:4px;z-index:99999;padding:12px;background:white;color:black';
    probe.innerHTML='<span>Open subscription</span>';document.body.append(probe);
    window.linkErrors=[];
    window.linkEvents=[];
    for(const type of ['pointerdown','pointerup','click','auxclick'])document.addEventListener(type,event=>window.linkEvents.push({type,trusted:event.isTrusted,target:event.target.outerHTML,x:event.clientX,y:event.clientY}),true);
    window.addEventListener('zcode:error',event=>window.linkErrors.push(String(event.detail)));
  })()`);
  const originalUrl = await read("location.href");
  let expected = 0;
  // openedOnce(url) 是唯一推进 expected 的地方：先 expected++，再等 inspectReact().opened.length === expected，随后断言 opened.at(-1) === url、location.href 仍是 originalUrl、window.starts 仍为 1；只断言最后一次地址会漏掉重复打开，页面导航会让后续用例全废。
  const openedOnce = async (url: string) => {
    expected++;
    await wait(`window.inspectReact().opened.length===${expected}`, (code) =>
      win.webContents.executeJavaScript(code),
    );
    assert.equal((await inspect()).opened.at(-1), url);
    assert.equal(await read("location.href"), originalUrl);
    assert.equal(await read("window.starts"), 1);
  };
  for (const target of ["", "_blank", "_self"]) {
    await read(
      `Object.assign(document.getElementById('link-probe'),{href:'https://example.com/subscribe',target:${JSON.stringify(target)}})`,
    );
    await click();
    await openedOnce("https://example.com/subscribe");
  }
  await click("left", [process.platform === "darwin" ? "meta" : "control"]);
  await openedOnce("https://example.com/subscribe");
  await click("middle");
  await openedOnce("https://example.com/subscribe");
  await read("document.getElementById('link-probe').focus()");
  guest.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
  guest.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
  guest.debugger.attach("1.3");
  try {
    await guest.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await guest.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  } finally {
    guest.debugger.detach();
  }
  await openedOnce("https://example.com/subscribe");

  // 页面可取消默认行为，避免自定义点击处理与委托处理重复打开。
  await read(`document.getElementById('link-probe').onclick=event=>{
    event.preventDefault();window.linkResult=window.zcode.openExternal({href:'http://example.com/script'}).then(()=>'',String);
  }`);
  await click();
  await wait("window.linkResult");
  assert.equal(await read("window.linkResult"), "");
  await openedOnce("http://example.com/script");
  assert.match(
    await read(
      "window.zcode.openExternal({href:'https://example.com/automatic'}).then(()=>'',String)",
    ),
    /gesture/i,
  );
  for (const href of [
    "relative/path",
    "file:///tmp/test",
    "javascript:void(0)",
    "data:text/plain,test",
  ]) {
    assert.match(
      await read(`window.zcode.openExternal({href:${JSON.stringify(href)}}).then(()=>'',String)`),
      /URL|HTTP/i,
    );
  }
  await read(
    "document.getElementById('link-probe').onclick=null;document.getElementById('link-probe').click()",
  );
  // 合成点击不能利用之前未消费的用户手势；下载与片段也不进入 opener。
  await read("document.getElementById('link-probe').download='plan.html'");
  await click();
  await read(
    "document.getElementById('link-probe').removeAttribute('download');document.getElementById('link-probe').click()",
  );
  await read("document.getElementById('link-probe').href='#first'");
  await click();
  await wait("location.hash==='#first'");
  await read(
    "history.replaceState(null,'',location.pathname);document.getElementById('link-probe').href='file:///tmp/test'",
  );
  await click();
  await wait("window.linkErrors.length>0");
  assert.match(await read("window.linkErrors.at(-1)"), /HTTP/i);
  assert.equal((await inspect()).opened.length, expected);

  await win.webContents.executeJavaScript("window.rejectExternalOpen(true)");
  await read(`window.linkResult=null;document.getElementById('link-probe').onclick=event=>{
    event.preventDefault();window.linkResult=window.zcode.openExternal({href:'https://example.com/failure'}).then(()=>'',String);
  }`);
  await click();
  await wait("window.linkResult");
  assert.match(await read("window.linkResult"), /Fixture opener failed/);
  await win.webContents.executeJavaScript("window.rejectExternalOpen(false);window.holdGesture()");
  await read("window.linkResult=null");
  await click();
  await wait("window.inspectReact().gesturePending", (code) =>
    win.webContents.executeJavaScript(code),
  );
  await win.webContents.executeJavaScript("window.showReply('hidden');window.releaseGesture()");
  assert.match(await read("window.linkResult"), /active|closed/i);
  assert.match(
    await read(
      "window.zcode.openExternal({href:'https://example.com/hidden'}).then(()=>'',String)",
    ),
    /active|closed/i,
  );
  assert.equal((await inspect()).opened.length, expected);
  assert.deepEqual((await inspect()).messages, []);
  await read("document.getElementById('link-probe').remove()");
  await win.webContents.executeJavaScript("window.showReply('complete')");
}
