/**
 * 调试台前端入口：在宿主页面的 `#root` 容器上挂载 React 根并渲染 `App`。
 *
 * 副作用：仅执行一次 DOM 挂载，不读写本地存储或发起网络请求。
 * 失败语义：宿主页面缺失 `#root` 时断言拿到 null，`createRoot` 会立即抛错，
 * 属于页面结构与入口约定的显式失败，不做静默兜底。
 * 不变量：`id="root"` 的容器必须与 index.html 保持一致。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
