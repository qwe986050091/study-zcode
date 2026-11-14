// dev-docs 应用入口：把 App 挂载到 #root，并引入全局样式。
// StrictMode 仅在开发期触发双重渲染检查，用于发现副作用问题。
// #root 由 index.html 提供，缺失时会因非空断言在启动期直接报错。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App.js";
import "@/styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
