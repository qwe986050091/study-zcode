// 示例仅演示 ProjectCatalogPort 的读取链路，不承担仓储实现、缓存或数据修复职责。
// INV: 示例必须保持只读语义，禁止在此写入目录，否则会污染真实 catalog 数据。
import type { ProjectCatalogPort } from "#src/project-catalog/contract.js";
import { readProjectCatalog } from "#src/project-catalog/index.js";
export async function example(port: ProjectCatalogPort) {
  return (await readProjectCatalog(port)).projects.map((project) => project.name);
}
