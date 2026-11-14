// panel.html 的内联加载器：连接宿主后按 manifest 顺序拉取 UI chunk 并内联执行。
// 边界：自身不包含任何业务逻辑，只负责握手、取资源、注入 style/script；分块仅为绕开单资源大小上限。
// 失败语义：任一步失败都写入 #root 的可见文本，避免面板白屏；不重试、不上抛。
import { TITLE } from "#office/wording.ts";
import { readText } from "#ui/assets.ts";
import { getHost } from "#ui/host.ts";

// Small loader inlined in panel.html: connect once, then pull the UI bundle through MCP resources
// (one large HTML resource would exceed host limits) and run it in the same page and App.
(async () => {
  getHost();
  // assets.json 只列出 chunk 文件名，数组顺序即执行顺序；CSS 与各 chunk 一次性并发拉取，避免串行往返。
  const manifest = JSON.parse(await readText("assets.json")) as { scripts: string[] };
  const [css, ...parts] = await Promise.all([
    readText("panel.css"),
    ...manifest.scripts.map(readText),
  ]);
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const script = document.createElement("script");
  // 把 chunk 按顺序拼成一段内联脚本：分块只为满足宿主单个资源大小限制，执行语义等同单个 bundle。
  script.textContent = parts.join("");
  document.body.append(script);
})().catch((error: Error) => {
  // 失败降级：拉取或执行失败时把错误写进 #root，避免面板白屏且用户无法判断原因。
  const root = document.getElementById("root");
  if (root) root.textContent = `${TITLE} failed to load: ${error.message}`;
});
