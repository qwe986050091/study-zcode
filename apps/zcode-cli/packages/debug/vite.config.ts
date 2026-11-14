/**
 * 调试台前端构建与开发服务配置。
 *
 * 职责：以 React 插件构建调试台页面，并把前端发往 `/api` 的请求代理到本地调试 API 服务端，
 * 使调试台在开发期保持同源，规避浏览器跨域限制。
 * 输入/输出口径：无外部输入；由 `scripts/dev.ts` 通过 `configFile` 显式加载。
 * 副作用/失败语义：不产生副作用；配置非法时 Vite 在启动阶段直接抛错，调试台不会以降级模式启动。
 * 不变量：`/api` 代理目标端口必须与 `startDebugServer` 监听端口一致（当前均为 4174）。
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:4174",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4175,
  },
});
