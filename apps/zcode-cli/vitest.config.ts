/**
 * zcode-cli 的 Vitest 根配置。
 *
 * 职责：定义哪些目录下的测试文件会被默认收集，使 `pnpm test` 能覆盖根级 test/tests
 * 以及各 packages 内的 test/tests。
 * 不负责：具体测试环境的 setup、覆盖率阈值与 CI 分片策略，这些由各包或流水线单独配置。
 * 失败语义：配置本身不产生运行时错误；若 include 写错，表现是相关测试被静默跳过而非报错，
 * 因此新增包时必须确认其测试目录命名落在以下四条规则之内。
 */
import { defineConfig } from "vitest/config";

// 用工厂函数导出配置，保证 Vitest 在加载时能拿到纯对象；此处不在配置阶段读取文件或环境，
// 以免同一份配置在不同工作目录下产生不一致的收集结果。
export default defineConfig({
  test: {
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
    ],
  },
});
