// office-runtime 包的单测配置：只收集包内约定的四处测试目录，避免把构建产物或依赖误当测试。
// 超时统一放宽到 30s（解析真实 docx/xlsx/pptx 与 wasm 初始化都较慢），超时失败视为真实回归。
// include 与各 package 的测试落点保持一致；新增测试目录时需同步此处，否则不会被 CI 执行。
import { defineConfig } from "vitest/config";
// 导出 Vitest 配置：无运行时副作用，只影响测试收集范围与超时；不作为插件运行时代码被引用。
// 修改 include 时不要放入 dist/ 或 node_modules，否则会把产物与依赖误当测试重复执行。
export default defineConfig({
  test: {
    include: ["*.test.ts", "src/**/*.test.ts", "ui/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
