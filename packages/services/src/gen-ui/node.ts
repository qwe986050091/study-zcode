// Gen UI 服务的公开入口：本条 re-export 是唯一导出契约，新增导出须保持零副作用，import 本文件不得触发任何初始化。
export { createGenUiService } from "./adapters/service.js";
