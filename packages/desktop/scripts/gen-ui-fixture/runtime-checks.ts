// INV-01 等待条件必须在页面内轮询且有超时：守住位置 waitFor；改错故障 条件永不满足时挂死整个检查。
// INV-02 超时错误必须携带焦点、提示与弹层快照：守住位置 拒绝分支；改错故障 失败时无法定位 DOM 状态。
// INV-03 所有页面操作都通过注入的读取函数执行：守住位置 Read 类型与调用点；改错故障 直接在 Node 侧访问 DOM。
// INV-04 每个探针节点使用独立 id 并在结束时移除：守住位置 探针构造与清理；改错故障 多次运行互相污染。
// INV-05 选项卡切换同时校验显示与隐藏两侧：守住位置 前两组断言；改错故障 只测到单侧导致回归漏检。
// INV-06 键盘事件必须冒泡，才能命中共享处理器：守住位置 KeyboardEvent 参数；改错故障 快捷键检查永远不触发。
// INV-07 动态图标替换后必须重新查询标签名：守住位置 createIcons 前后的断言；改错故障 缓存旧节点导致误判。
// INV-08 悬停提示必须走真实指针事件与延迟路径：守住位置 pointerover 派发；改错故障 脚本聚焦绕过 focus-visible 语义。
// INV-09 提示关闭后必须恢复原有描述引用：守住位置 Escape 后的断言；改错故障 无障碍描述被永久改写。
// INV-10 四种方位逐一校验弹层边界：守住位置 placement 循环；改错故障 某一侧溢出视口未被发现。
// INV-11 每次方位切换后都要重新等待可见：守住位置 循环内的 waitFor；改错故障 读到上一次弹层位置。
// INV-12 触摸点击后弹层只允许存在一个：守住位置 数量断言；改错故障 重复挂载导致叠层。
// INV-13 阴影 DOM 内的事件必须 composed 才能穿透：守住位置 派发参数；改错故障 阴影内提示完全无响应。
// INV-14 阴影宿主移除后弹层必须自动消失：守住位置 末尾等待；改错故障 孤儿弹层残留。
// INV-15 日历初始变体与轮播双向切换都要覆盖：守住位置 轮播断言；改错故障 只验证前进方向。
// INV-16 日历探针的事件选择回调必须记录索引：守住位置 事件监听；改错故障 点击后无法确认选中的是哪一条。
// INV-17 非法日期必须渲染告警且不影响后续复位：守住位置 日期断言；改错故障 组件进入不可恢复状态。
// INV-18 tweak 生命周期以分组数量为观测口径：守住位置 三处等待；改错故障 泄漏的控件被误认为正常。
//
// 模块职责：在真实 Electron 页面中驱动运行时探针，校验组件交互、定位与生命周期。
// 状态所有权：探针节点与全局标记都挂在页面；每个检查结束时负责清理自己创建的内容。
// 阅读顺序：先看等待工具，再读运行时组件检查，最后看日历轮播与 tweak 生命周期。
import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";

type Read = (code: string) => Promise<any>;
// waitFor 在页面内轮询、超时 4000ms；拒绝时把 activeElement/tip/popup 快照拼进 message，失败现场不用复跑。
const waitFor = (read: Read, predicate: string) =>
  read(`new Promise((resolve,reject)=>{
  const end=Date.now()+4000; const tick=()=>{
    if(${predicate})resolve(true);else if(Date.now()>end)reject(new Error(${JSON.stringify(predicate)} + ' ' + JSON.stringify({focus:document.activeElement?.outerHTML,tip:document.getElementById('tip')?.matches(':focus-visible'),popup:document.querySelector('[role=tooltip]')?.outerHTML})));else requestAnimationFrame(tick);
  };tick();
})`);

// 断言失败会直接抛出，不吞异常。
export async function checkRuntimeWidgets(read: Read) {
  await read("document.querySelector('#second-tab').click()");
  assert.equal(await read("document.querySelector('#second').hidden"), false);
  assert.equal(await read("document.querySelector('#first').hidden"), true);
  assert.ok(await read("Boolean(document.querySelector('svg.lucide'))"));
  await read(
    "document.querySelector('#second-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))",
  );
  assert.equal(await read("document.querySelector('#first').hidden"), false);
  assert.equal(await read("typeof FloatingUIDOM.computePosition"), "function");
  assert.equal(await read("typeof lucide.createIcons"), "function");
  await read(
    `document.body.insertAdjacentHTML('beforeend','<div id="runtime-probe"><span id="described">Existing description</span><button id="tip" data-tooltip="Runtime tooltip" aria-describedby="described">Tooltip</button><div id="shadow"></div><i id="dynamic-icon" data-lucide="search"></i><div class="nav" role="tablist"><button id="shared-a" role="tab" aria-controls="shared-panel">A</button><button id="shared-b" role="tab" aria-controls="shared-panel">B</button></div><div id="shared-panel">Shared panel</div></div>')`,
  );
  await read("new Promise(requestAnimationFrame)");
  assert.equal(await read("document.getElementById('dynamic-icon').tagName"), "I");
  await read("lucide.createIcons({attrs:{width:16,height:16}})");
  assert.equal(await read("document.getElementById('dynamic-icon').tagName.toLowerCase()"), "svg");
  await read("document.getElementById('shared-a').click()");
  assert.equal(await read("document.getElementById('shared-panel').hidden"), false);
  await read(
    "document.getElementById('shared-a').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))",
  );
  assert.equal(
    await read("document.getElementById('shared-b').getAttribute('aria-selected')"),
    "true",
  );
  assert.equal(await read("document.getElementById('shared-panel').hidden"), false);

  // 上游只为 focus-visible 自动打开；脚本 focus 不等于用户键盘输入，悬停走实际延迟路径。
  await read(
    "document.getElementById('tip').dispatchEvent(new PointerEvent('pointerover',{pointerType:'mouse',bubbles:true}))",
  );
  await waitFor(read, "document.querySelector('[role=tooltip]')?.style.visibility === 'visible'");
  assert.ok(
    (await read("document.getElementById('tip').getAttribute('aria-describedby')")).startsWith(
      "described ",
    ),
  );
  await read("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await read("document.querySelector('[role=tooltip]') === null"), true);
  assert.equal(
    await read("document.getElementById('tip').getAttribute('aria-describedby')"),
    "described",
  );
  // 四个方位逐个触发触摸点击；弹层必须落在视口内（容差 1px），结束后关闭并确认只剩一个实例。
  for (const placement of ["top", "right", "bottom", "left"]) {
    await read(`(() => {
      const tip=document.getElementById('tip');tip.dataset.tooltipPlacement=${JSON.stringify(placement)};
      tip.style.cssText='position:fixed;top:150px;left:250px';
      tip.dispatchEvent(new PointerEvent('click',{pointerType:'touch',detail:1,bubbles:true}));
    })()`);
    await waitFor(read, "document.querySelector('[role=tooltip]')?.style.visibility === 'visible'");
    const bounds = await read(
      `(() => {const t=document.getElementById('tip').getBoundingClientRect(),p=document.querySelector('[role=tooltip]').getBoundingClientRect();return {tip:t.toJSON(),popup:p.toJSON(),width:innerWidth,height:innerHeight}})()`,
    );
    assert.ok(bounds.popup.left >= 0 && bounds.popup.right <= bounds.width + 1);
    assert.ok(bounds.popup.top >= 0 && bounds.popup.bottom <= bounds.height + 1);
    if (placement === "top") assert.ok(bounds.popup.bottom <= bounds.tip.top);
    if (placement === "bottom") assert.ok(bounds.popup.top >= bounds.tip.bottom);
    if (placement === "left") assert.ok(bounds.popup.right <= bounds.tip.left);
    if (placement === "right") assert.ok(bounds.popup.left >= bounds.tip.right);
    await read(
      "document.getElementById('tip').dispatchEvent(new PointerEvent('pointerout',{pointerType:'touch',bubbles:true}))",
    );
    assert.equal(await read("document.querySelectorAll('[role=tooltip]').length"), 1);
    await read(
      "document.body.dispatchEvent(new PointerEvent('click',{pointerType:'touch',detail:1,bubbles:true}))",
    );
    assert.equal(await read("document.querySelector('[role=tooltip]') === null"), true);
  }
  await read(
    `document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button data-tooltip="Shadow tooltip">Shadow</button>'`,
  );
  await read("new Promise(requestAnimationFrame)");
  await read(
    "document.getElementById('shadow').shadowRoot.querySelector('button').dispatchEvent(new PointerEvent('click',{pointerType:'touch',detail:1,bubbles:true,composed:true}))",
  );
  await waitFor(read, "document.querySelector('[role=tooltip]')?.style.visibility === 'visible'");
  assert.equal(
    await read("document.querySelector('[role=tooltip]').textContent"),
    "Shadow tooltip",
  );
  await read("document.getElementById('shadow').remove()");
  await waitFor(read, "!document.querySelector('[role=tooltip]')");
  await read("document.getElementById('runtime-probe').remove()");
}

// 用 .viz-carousel 验证前进/后退可逆，再用挂载了重叠日程的 viz-calendar 探针验证布局与 eventselect。
export async function checkCalendarAndCarousel(read: Read) {
  assert.equal(await read("window.calendarWasReady"), true);
  assert.equal(
    await read("document.querySelector('.viz-carousel').dataset.activeVariant"),
    "First",
  );
  await read("document.querySelector('.viz-carousel-next').click()");
  assert.equal(
    await read("document.querySelector('.viz-carousel').dataset.activeVariant"),
    "Second",
  );
  await read("document.querySelector('.viz-carousel-previous').click()");
  assert.equal(
    await read("document.querySelector('.viz-carousel').dataset.activeVariant"),
    "First",
  );
  await read(`(() => {
    const calendar=document.createElement('viz-calendar');calendar.id='calendar-probe';calendar.setAttribute('date','2026-09-29');calendar.setAttribute('start','09:00');calendar.setAttribute('end','12:00');calendar.setAttribute('interactive','');
    calendar.events=[{title:'One',start:'09:00',end:'10:00'},{title:'Two',start:'09:30',end:'10:30'}];
    calendar.addEventListener('eventselect',event=>window.calendarSelection=event.detail.index);document.body.append(calendar);
  })()`);
  // readCalendar 把表达式包进 #calendar-probe 的阴影根，避免读到页面上其他日历实例。
  const readCalendar = (expression: string) =>
    read(`(() => {const c=document.getElementById('calendar-probe');return ${expression}})()`);
  assert.equal(await readCalendar("c.shadowRoot.querySelectorAll('.event').length"), 2);
  assert.equal(
    await readCalendar(
      "c.shadowRoot.querySelectorAll('.event')[1].style.getPropertyValue('--lanes')",
    ),
    "2",
  );
  await readCalendar("c.shadowRoot.querySelector('button[data-event-index]').click()");
  assert.equal(await read("window.calendarSelection"), 0);
  await readCalendar("c.setAttribute('date','2026-02-30')");
  assert.ok(await readCalendar("c.shadowRoot.querySelector('[role=alert]') !== null"));
  await readCalendar("c.setAttribute('date','2026-09-29')");
  assert.equal(await readCalendar("c.shadowRoot.querySelectorAll('.event').length"), 2);
  await readCalendar("c.remove()");
}

// Tweak 探针生命周期：挂载后分组数增加，宿主注入改值触发 onChange，销毁后分组回到初值。
export async function checkTweakLifecycle(read: Read, win: BrowserWindow) {
  const host = (code: string) => win.webContents.executeJavaScript(code);
  await read(`(() => {
    const container=document.createElement('div');container.id='tweak-probe';document.body.append(container);
    window.probeState={size:4};window.probeRenders=0;
    window.probeTweak=new Tweak({container,onChange:()=>window.probeRenders++});
    window.probeTweak.addSlider(window.probeState,'size',{min:0,max:10,label:'Probe'});
  })()`);
  await waitFor(host, "window.inspect().snapshot.groups.length === 3");
  const id = await host("window.inspect().snapshot.groups[2].controls[0].id");
  await host(`window.setProbeTweaks(${JSON.stringify({ [id]: 9 })})`);
  await waitFor(read, "window.probeState.size === 9");
  await read("window.probeTweak.dispose()");
  await waitFor(host, "window.inspect().snapshot.groups.length === 2");
  assert.equal(await read("window.probeState.size"), 4);
  await read(
    "window.probeTweak=new Tweak({container:document.getElementById('tweak-probe'),onChange:()=>{}});window.probeTweak.addToggle({enabled:true},'enabled')",
  );
  await waitFor(host, "window.inspect().snapshot.groups.length === 3");
  await read("document.getElementById('tweak-probe').remove()");
  await waitFor(host, "window.inspect().snapshot.groups.length === 2");
}
