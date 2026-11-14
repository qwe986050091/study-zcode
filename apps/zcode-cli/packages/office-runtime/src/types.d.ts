// pdf.js 的 worker 模块随包发布但没有类型声明，这里用空模块声明让其可被 import 而不触发类型检查。
// 纯类型补丁，不含任何运行时代码；worker 的实际加载与挂载见 adapters/parse/pdf.ts 的 loadPdfJs。
// 两条声明必须与 pdf.js 的实际入口路径一致，构建裁剪后仍被引用的那条才需要保留。
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
declare module "pdfjs-dist/build/pdf.worker.min.mjs";
