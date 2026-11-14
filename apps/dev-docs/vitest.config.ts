import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// dev-docs 的 Vitest 配置：node 环境运行 test/**/*.test.ts（数据/纯函数测试无需 DOM）。
// 别名 "@" 与 Vite 配置保持一致，保证测试与运行时解析到同一路径。
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
