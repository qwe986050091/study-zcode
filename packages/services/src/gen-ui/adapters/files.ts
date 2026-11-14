// Gen UI 文件读取适配器：把 widget 声明的目标路径解析为受信任的 HTML 片段。
// 安全边界：读取范围限定在执行端固定输出根目录内，并逐段拒绝符号链接、
// 打开后复核文件身份（dev/ino），抵御 path traversal 与检查后替换（TOCTOU）。
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  GEN_UI_HTML_MAX_BYTES,
  genUiStateTargetSchema,
  type GenUiDocument,
  type GenUiStateTarget,
} from "@zcode/shared/gen-ui";

// 只接受 HTML 片段：拒绝 doctype/html/head/body，避免 widget 注入完整文档接管宿主页面；
// 同时用字节数上限兜底，防止超大内容占满内存。
export function assertGenUiFragment(html: string): void {
  if (Buffer.byteLength(html, "utf8") > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI file exceeds 5 MB");
  if (/<(?:!doctype\b|\/?(?:html|head|body)(?:\s|>))/iu.test(html))
    throw new Error("Gen UI requires an HTML fragment");
}
// 契约：入参先按 schema 校验，三个路径必须是绝对路径；返回规范化后的文件路径与解码文本。
// 语义上以 Host 固定 outputRoot 为唯一读取边界，会话分组不参与路径限制（仅用于 state 归属）。
// 所有校验失败一律抛 Error，调用方据此拒绝对外暴露文件内容。
export async function readGenUiDocument(
  raw: GenUiStateTarget,
  outputRoot: string,
): Promise<GenUiDocument> {
  const input = genUiStateTargetSchema.parse(raw);
// 相对路径无法与 root 做可靠包含判断（cwd 可变），因此在解析前直接拒绝；
// 早失败也避免后续 realpath/lstat 对非预期位置产生 IO。
  if (!isAbsolute(outputRoot) || !isAbsolute(input.path) || !isAbsolute(input.workspacePath))
    throw new Error("Invalid executor path");
// root 与 file 先各自 resolve/normalize，再做相对关系判断，消除「..」与重复分隔符带来的歧义。
  const root = resolve(outputRoot),
    file = normalize(input.path);
  const child = relative(root, file);
  // 根因：fork 会保留父会话的 HTML 路径，生成目录分组不能作为当前会话的读取限制。
  // 读取范围只由执行端 Host 的固定输出根目录决定，widget state 仍使用当前会话身份。
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Gen UI file is outside the host output directory");
  // 修复依据：realpath 后再做前缀判断仍可能放行替换中的符号链接；逐级拒绝链接并核对打开的文件身份。
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
// 逐段 lstat 并要求每级都不是符号链接：仅对最终 realpath 做前缀判断，
// 仍可能被检查与打开之间的链接替换绕过，逐级拒绝把可利用窗口收敛到单次系统调用内。
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Gen UI does not read symbolic links");
  }
// 记录打开前的身份（dev/ino）与类型，供 open 之后比对，识别检查后文件被替换的情况。
  const before = await lstat(current);
  const canonicalFile = await realpath(current);
  const canonicalChild = relative(canonicalRoot, canonicalFile);
  if (
    !canonicalChild ||
    canonicalChild === ".." ||
    canonicalChild.startsWith(`..${sep}`) ||
    isAbsolute(canonicalChild)
  )
    throw new Error("Gen UI file escaped the output directory");
  if (!before.isFile() || before.size > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI requires a regular file under 5 MB");
// O_NOFOLLOW 让最终打开本身也拒绝符号链接（Windows 上无该常量时降级为 0，由逐级检查兜底）；
// 打开后再比对 dev/ino，确保读到的就是刚才校验的那个文件。
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Gen UI file changed while opening");
// 多分配 1 字节用于探测超限：读满 MAX+1 即说明文件超限，无需依赖文件大小声明。
    const bytes = Buffer.alloc(GEN_UI_HTML_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used > GEN_UI_HTML_MAX_BYTES) throw new Error("Gen UI file exceeds 5 MB");
// fatal 解码拒绝非法 UTF-8，避免把损坏字节静默替换成 U+FFFD 后渲染出异常内容。
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    assertGenUiFragment(html);
    return { path: file, html };
  } finally {
    await handle.close();
  }
}
