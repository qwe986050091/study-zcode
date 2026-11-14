// INV-01 单一导出：本模块只导出 createCustomAboutDialogHtml；守住位置：模块顶层符号表只有这一个 export；改错故障：把内联片段也导出后 CSP 与转义约定失去唯一收口，调用面扩散难以整体校验
// INV-02 纯字符串构造：结果只由六项入参决定，不读写磁盘、环境变量与 Electron 对象；守住位置：createCustomAboutDialogHtml 整段函数体；改错故障：引入窗口或文件依赖后本模块必须启动 Electron 才能测，同一入参也不再可重复渲染
// INV-03 六字段全必填：applicationName、appVersion、copyright、optimizationLine、versionLabel、okButtonLabel 均无可选标记；守住位置：顶部 CustomAboutDialogHtmlInput 定义；改错故障：改成可选会让模板插入 undefined 字面量，并让调用方误以为可以漏传
// INV-04 转义顺序固定：escapeHtml 必须先换 & 再换尖括号与引号；守住位置：替换链第一项；改错故障：把 & 挪到最后会把已生成的 &amp; 二次转义，标题与版权出现可见的实体源码
// INV-05 插值一律转义：六项在 title、aria-label、h1 与 meta 文本中都经 escapeHtml；守住位置：模板内全部 ${} 插值点；改错故障：漏掉任意一处，应用名含引号或尖括号就会破坏标签结构并敞开注入面
// INV-06 撇号也转义：escapeHtml 覆盖单引号到 &#39;；守住位置：替换链最后一项；改错故障：日后若把插值挪进单引号属性，缺这一条会被提前闭合截断
// INV-07 CSP 收紧：default-src 'none'，img-src 仅 data:，style 与 script 只放 'unsafe-inline'；守住位置：head 内 Content-Security-Policy meta；改错故障：为图方便加外部脚本源，等于允许沙箱窗口拉取远程脚本
// INV-08 零外部资源：图标必须内联为 SVG，样式必须内联在 style 标签，脚本必须内联在 script 标签，无 http 链接、外链字体与图片文件；守住位置：style 块、svg 块与脚本块；改错故障：外链资源在 default-src 'none' 下静默失败，表现为字体回退与图标空白
// INV-09 关闭只有一条路径：closeWindow 走 window.close，按钮点击与 Escape、Enter 键复用同一函数；守住位置：文末内联脚本；改错故障：为按钮另写关闭逻辑会形成两条路径，日后改按键策略必漏其一
// INV-10 查询结果可缺失：querySelector 之后接可选链再绑监听；守住位置：ok-button 监听注册那一行；改错故障：去掉可选链后类名一改就抛错，并连带跳过后续 keydown 注册，键盘无法关闭窗口
// INV-11 默认焦点在确认键：ok-button 带 autofocus，回车可直接确认；守住位置：button 标签属性；改错故障：删掉 autofocus 后回车只靠脚本分支兜底，焦点行为与原生按钮不再一致
// INV-12 无障碍关联成套：section 的 role=dialog、aria-modal 与 aria-labelledby=about-title 必须成套，h1 必须保留同名 id；守住位置：body 内 section 与 h1 结构；改错故障：改 id 或删 aria-labelledby，读屏软件读不出对话框名称与模态语义
// INV-13 装饰图标对读屏隐藏：app-icon 容器与 svg 均标 aria-hidden，svg 另带 focusable=false；守住位置：图标区块；改错故障：缺 focusable=false 时旧内核会把 SVG 拉进 Tab 序列，焦点停在纯装饰元素上
// INV-14 尺寸固定不滚动：卡片高 280px 低于窗口 312px，body overflow hidden；守住位置：about-window 与 body 规则；改错故障：把卡片高度改成与窗口相等会贴边，透明窗口没有滚动条可补救溢出的内容
// INV-15 拖拽区与点击区分离：about-card 设 -webkit-app-region drag，ok-button 必须设 no-drag；守住位置：两条 app-region 声明；改错故障：按钮丢掉 no-drag 后点击被拖拽吞掉，按钮可见却按不下去
// INV-16 主题只走变量与媒体查询：:root 定义四个变量，prefers-color-scheme dark 覆盖同一批；守住位置：两处变量声明块；改错故障：改成 JS 注入类名会多一条状态通道，并在系统主题切换时落后一拍
// INV-17 空优化行不占位：optimizationLine 为假值时输出空串而非空 div；守住位置：meta 区块的三元表达式；改错故障：无条件渲染空 div 会让 .meta 的 17px gap 多出一份间距，两条文案被整体推偏
// INV-18 返回整份文档：结果串自 <!doctype html> 到 </html> 自洽，调用方只做 encodeURIComponent 再拼进 data URL；守住位置：模板起止两端；改错故障：只返回片段或漏掉 doctype 会让文档进入怪异模式，head 里的 CSP meta 也难保证生效
//
// 模块职责：把关于对话框所需的六项信息拼成一份自包含 HTML 文档，样式、图标与关闭脚本全部内联，不依赖任何外部资源。
// 状态所有权：本模块不持有状态，六项展示数据由 about.ts 在主进程侧取出后传入；窗口创建、加载与显示归调用方，这里只产出内容。
// 阅读顺序：CustomAboutDialogHtmlInput → escapeHtml → createCustomAboutDialogHtml 的 head 与 CSP → style 变量与布局 → body 结构 → 文末内联脚本。
interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  // 字段必须全部是字符串，不能接收 locale、日期对象或格式化回调：取词与日期格式化留在 about.ts
  // appVersion 与 versionLabel 分开传入，因为排版要拼成「版本标签 + 版本号」同一行
  // copyright 与 optimizationLine 传入时已是成品文案，本模块不再截断、替换换行或补默认值
  // optimizationLine 允许空串，模板用三元判断决定是否输出，空串是合法输入而非错误
  // okButtonLabel 由调用方按语言给出，本模块不维护文案表
  // 六项都无默认值：漏传在类型检查阶段失败，而不是运行时插出 undefined
  copyright: string;
  optimizationLine: string;
  versionLabel: string;
  okButtonLabel: string;
}

// & 必须放在替换链首位，先转义它再处理尖括号与引号，才不会有实体被二次转义
// 双引号与单引号都覆盖，因为 escapeHtml 的插值既落在双引号属性里，也可能被挪进单引号上下文
// 只做最小 HTML 转义，不引入第三方清洗库：模板固定，多一层依赖只增加安装与执行成本
// 该函数不处理换行与连续空格，它们在 HTML 中按规则折叠，属于排版预期
// 输出是纯文本片段，只能用于 title、aria-label 与文本节点这三类位置，本模块没有别的用法
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 280px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      .app-icon {
        width: 52px;
        height: 52px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        background: linear-gradient(180deg, #000000 0%, #151718 100%);
        color: #ffffff;
        box-shadow: 0 10px 13px -3px rgb(0 0 0 / 0.2), 0 4px 5px -3px rgb(0 0 0 / 0.2);
      }

      .app-logo {
        width: 30px;
        height: auto;
        display: block;
      }

      .title {
        margin: 20px 0 0;
        font-size: 13.5px;
        line-height: 1.18;
        font-weight: 700;
        letter-spacing: 0;
      }

      .meta {
        margin-top: 28px;
        display: flex;
        flex-direction: column;
        gap: 17px;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }


      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }
      }
    </style>
  </head>
  <body>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          <div class="app-icon" aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="118"
              height="100"
              fill="none"
              viewBox="0 0 256 218"
              class="app-logo"
              focusable="false"
            >
              <path
                fill="currentColor"
                d="M134.4 0.130152L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0C6.3999 0.130149 134.4 0.130152 134.4 0.130152Z"
              />
              <path fill="currentColor" d="M256 0.130127L102.401 217.732H0L153.599 0.130127H256Z" />
              <path
                fill="currentColor"
                d="M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z"
              />
            </svg>
          </div>
          <h1 id="about-title" class="title">
            ${escapeHtml(input.applicationName)}<br />
            ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
          </h1>
          <div class="meta">
            ${input.optimizationLine ? `<div>${escapeHtml(input.optimizationLine)}</div>` : ""}
            <div>${escapeHtml(input.copyright)}</div>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      const closeWindow = () => window.close();
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });
    </script>
  </body>
</html>`;
}

