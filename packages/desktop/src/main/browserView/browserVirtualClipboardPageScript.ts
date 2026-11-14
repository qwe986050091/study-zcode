// INV-01 只认当前深度活跃元素：守住位置 deepestActiveElement 递归；改错故障 富文本编辑器内层输入框收不到粘贴。
// INV-02 输入目标令牌必须匹配：守住位置 inputTargetToken 比对；改错故障 焦点漂移后把内容粘到别的控件。
// INV-03 空剪贴板直接报错：守住位置 clipboardItems.length 判定；改错故障 静默无操作，调用方以为成功。
// INV-04 优先走原生 paste 事件：守住位置 DataTransfer/ClipboardEvent 可用性判断；改错故障 富文本编辑器丢格式。
// INV-05 原生事件无人处理才回退：守住位置 dispatchEvent 返回值；改错故障 两种写入叠加，文本重复。
// INV-06 回退只认输入框与 contenteditable：守住位置 fallbackPaste 两处类型判断；改错故障 往普通 div 上 execCommand。
// INV-07 只读与禁用控件不写值：守住位置 disabled/readOnly 早退；改错故障 试图改写不可编辑区域。
// INV-08 输入框写入优先走原型 setter：守住位置 prototypeSetter 判定；改错故障 React 受控组件感知不到变更。
// INV-09 有选区就替换选区：守住位置 setRangeText；改错故障 光标中间插入变成追加到末尾。
// INV-10 写完必须派发冒泡 input 事件：守住位置 InputEvent 构造；改错故障 框架状态不同步。
// INV-11 富文本回退优先 HTML：守住位置 html.length 判断；改错故障 富文本降级成纯文本。
// INV-12 跨文档元素按自身 window 判定：守住位置 asElement；改错故障 跨源元素 instanceof 失败。
// INV-13 成功路径统一返回空对象：守住位置 两处 return {}；改错故障 返回值破坏协议约定。
//
// 模块职责：VIRTUAL_PASTE_PAGE_FUNCTION 把虚拟剪贴板内容注入页面当前焦点控件，源码整体作为字符串在页面上下文执行。
// 阅读顺序：先看活跃元素定位与令牌校验，再看原生 paste 路径，最后看三档回退写入。
export const IAB_INPUT_TARGET_TOKEN_PROPERTY = "__zcodeIabInputTargetToken";

/** 页面虚拟粘贴；此函数源码在目标 page execution context 内执行。 */
export const VIRTUAL_PASTE_PAGE_FUNCTION = `async (options) => {
  const asElement = (candidate) => {
    if (candidate == null || typeof candidate !== "object" || !("ownerDocument" in candidate))
      return null;
    const view = candidate.ownerDocument?.defaultView ?? null;
    return view != null && candidate instanceof view.Element ? candidate : null;
  };
  const elementWindow = (element) => element.ownerDocument.defaultView ?? window;
  const deepestActiveElement = (root) => {
    const active = root.activeElement;
    if (active == null) return null;
    const view = elementWindow(active);
    if (active instanceof view.HTMLElement && active.shadowRoot != null)
      return deepestActiveElement(active.shadowRoot) ?? active;
    if (active instanceof view.HTMLIFrameElement || active instanceof view.HTMLFrameElement) {
      try {
        const frameDocument = active.contentDocument ?? active.contentWindow?.document ?? null;
        if (frameDocument != null) return deepestActiveElement(frameDocument) ?? active;
      } catch {
        return active;
      }
    }
    return active;
  };
  const textForMime = (items, mimeType) =>
    items.flatMap((item) => item.entries).find((entry) => entry.mime_type === mimeType)?.text ?? "";
  const fallbackPaste = (target, html, text, replaceInputValue) => {
    const element = asElement(target);
    if (element == null) return;
    const view = elementWindow(element);
    if (element instanceof view.HTMLTextAreaElement || element instanceof view.HTMLInputElement) {
      if (element.disabled || element.readOnly || text.length === 0) return;
      const setValue = (value) => {
        const prototype = Object.getPrototypeOf(element);
        const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        const ownSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
        if (prototypeSetter != null && ownSetter !== prototypeSetter) prototypeSetter.call(element, value);
        else element.value = value;
      };
      if (element.selectionStart == null || element.selectionEnd == null) {
        setValue(replaceInputValue ? text : element.value + text);
      } else {
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        try {
          element.setRangeText(text, start, end, "end");
        } catch {
          setValue(replaceInputValue ? text : element.value + text);
        }
      }
      element.dispatchEvent(new view.InputEvent("input", { bubbles: true }));
      return;
    }
    if (
      element instanceof view.HTMLElement &&
      (element.isContentEditable || element.closest("[contenteditable=true]"))
    ) {
      element.focus();
      if (html.length > 0) {
        element.ownerDocument.execCommand("insertHTML", false, html);
        return;
      }
      if (text.length > 0) element.ownerDocument.execCommand("insertText", false, text);
    }
  };

  const target = deepestActiveElement(document) ?? document.body;
  if (options.inputTargetToken != null) {
    const element = asElement(target);
    if ((element ?? null)?.${IAB_INPUT_TARGET_TOKEN_PROPERTY} !== options.inputTargetToken)
      throw new Error("Active element is no longer the expected input target");
  }
  if (options.clipboardItems.length === 0)
    throw new Error("Browser Use virtual clipboard has no data to paste");
  const targetElement = asElement(target);
  const view = targetElement == null ? window : elementWindow(targetElement);
  const plainText = textForMime(options.clipboardItems, "text/plain");
  const richText = options.richTextFallback === true
    ? textForMime(options.clipboardItems, "text/html")
    : "";
  if (typeof view.DataTransfer !== "function" || typeof view.ClipboardEvent !== "function") {
    fallbackPaste(target, richText, plainText, options.replaceInputValue === true);
    return {};
  }
  const dataTransfer = new view.DataTransfer();
  for (const item of options.clipboardItems)
    for (const entry of item.entries)
      if (typeof entry.text === "string") dataTransfer.setData(entry.mime_type, entry.text);
  const pasteEvent = new view.ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: dataTransfer,
    composed: true,
  });
  if (target.dispatchEvent(pasteEvent))
    fallbackPaste(target, richText, plainText, options.replaceInputValue === true);
  return {};
}`;

