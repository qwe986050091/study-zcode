// 格式 → 查看器注册表，是外壳选择渲染实现的唯一入口（无格式时由调用方回退到不支持提示）。
// 每种格式一行并带 `kind:<format>` 标记，构建脚本据此裁剪未使用的渲染器及其依赖。
import type { ComponentType, RefAttributes } from "react";
import type { DocKind } from "#office/contract.ts";
import type { ViewerHandle, ViewerProps } from "#ui/viewers/types.ts";
// One line per format, tagged `kind:<format>`: scripts/build.mjs keeps only the plugin's formats,
// so a plugin bundles only the renderers it uses.
import { DocxView } from "#ui/viewers/DocxView.tsx"; // kind:docx
import { PdfView } from "#ui/viewers/PdfView.tsx"; // kind:pdf
import { prepareCjkFonts } from "#ui/cjkFontRuntime.ts"; // kind:pdf
import { PptxView } from "#ui/viewers/PptxView.tsx"; // kind:pptx
import { XlsxView, loadXlsxWasm } from "#ui/viewers/XlsxView.tsx"; // kind:xlsx

// 单个格式的注册项：view 负责渲染，prepare 负责在打开文档时并行预热依赖（可缺省）。
// 两项都必须无副作用地可重复调用，因为同一格式可能在一次会话里被多次打开。
export interface ViewerEntry {
  // 该格式的 React 组件，统一实现 ViewerProps + ViewerHandle ref 契约。
  view: ComponentType<ViewerProps & RefAttributes<ViewerHandle>>;
  // 文档字节之外的预热动作（pdf 的 CJK 字体、xlsx 的 wasm）；返回 Promise，失败由调用方降级。
  /** Loads what the viewer needs besides the file (fetched alongside the file's bytes). */
  prepare?: () => Promise<unknown>;
}

// 注册表用 Partial：未支持的格式不出现键，调用方必须以 undefined 判断不可用。
// prepare 与文件字节并行预取（pdf 的 CJK 字体、xlsx 的 wasm），失败由调用方统一处理。
export const VIEWERS: Partial<Record<DocKind, ViewerEntry>> = {
  docx: { view: DocxView }, // kind:docx
  pdf: { view: PdfView, prepare: prepareCjkFonts }, // kind:pdf
  pptx: { view: PptxView }, // kind:pptx
  xlsx: { view: XlsxView, prepare: loadXlsxWasm }, // kind:xlsx
};
