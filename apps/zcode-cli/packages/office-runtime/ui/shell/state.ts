// 外壳状态模型：已加载文档、引用/选区、Agent 标记、失败信息与最近文件读写。
// 边界：类型只描述 UI 派生状态，不复制服务端事实；文档字节与元信息来自 rpc/宿主。
// 失败语义：最近文件读写与 localStorage 异常静默降级；错误展示统一经 describeFailure 归一。
import { useEffect, useState } from "react";
import {
  type DocKind,
  type DocumentInfo,
  type DocxBlockKey,
  type Selection,
} from "#office/contract.ts";
import { cut } from "#office/domain/text.ts";
import { getHost } from "#ui/host.ts";
import type { Strings } from "#ui/i18n.ts";
import { CallError } from "#ui/rpc.ts";
import type { RevealedTarget, SelectionDetail } from "#ui/viewers/types.ts";

// 面板外壳（main.tsx）共用的状态类型与持久化、错误描述等辅助函数，从 main.tsx 拆出以控制单文件规模。
// 这里只有类型、纯函数与一个轻量 hook；窗口持久化的实际读写由 host 封装（localStorage + stateKey）。

// 已加载文档：info 是服务端元信息（含 revision 与大纲），bytes 是原始字节（查看器自行解析），
// blocks 只有 docx 提供（用于把渲染元素回映射到服务端块），key 单调递增用于强制重挂载查看器。
export interface LoadedDoc {
  info: DocumentInfo;
  bytes: ArrayBuffer;
  blocks?: DocxBlockKey[];
  /** Increments on every (re)load so the viewer remounts. */
  key: number;
}

// 加入模型上下文的引用：anchor 是可回传的定位串（formatAnchor 产出），text 是当时的选中文本（可空）。
// anchor 必须带当前文档路径前缀；引用只是回传载荷，不表示“已选中”，渲染态由 Picked 承担。
export interface Reference {
  anchor: string;
  text: string;
}

// 用户当前选择：selection 是服务端可理解的锚点与文本，detail 是渲染层用于定位浮层的几何与来源标记。
// detail 不参与服务端调用，仅用于浮层位置与样式；切换文档时必须清空，避免锚点跨文档失效。
export interface Picked {
  selection: Selection;
  detail: SelectionDetail;
}

// Agent 标注状态：targets 由查看器 reveal 返回（顺序即文档顺序），index 是当前展示项，
// note 可空，visible 只控制气泡显隐（标记常驻，直到清空 agent）。
export interface AgentPointer {
  note: string | null;
  targets: RevealedTarget[];
  index: number;
  /** The callout (note and stepping); the marks stay after it is dismissed. */
  visible: boolean;
}

// 失败描述：path 是失败目标（可空，导入失败时可能是文件名），title/detail 已本地化，可直接渲染。
// detail 保证非空；path 仅用于展示与“重试当前文件”，不得用于拼接 anchor。
export interface Failure {
  path: string | null;
  title: string;
  detail: string;
}

// 截断到 length 字符并补省略号；用 cut 而不是 slice，避免把代理对（emoji）截成半个字符。
// length <= 0 时仍会产出省略号前缀，调用方需自行保证 length 为正；不抛错，纯字符串操作。
// 入参不被修改；结果长度最多为 length（省略号已包含在预算内）。
export const clip = (text: string, length: number) =>
  text.length > length ? `${cut(text, 0, length - 1)}…` : text;

// 只返回 path/kind 已通过校验的条目（校验在 windowStorage 层完成），调用方无需再判类型。
// 读最近列表；新窗口或存储损坏时返回空数组（不是 null），调用方可直接 map。
// 每次读取都经 host 的当前窗口 stateKey，因此同一浏览器多窗口互不共享；返回新数组。
export function readRecent(): { path: string; kind: DocKind }[] {
  return getHost().readWindow().recent ?? [];
}
// 只触发一次合并写入、不回读旧值；recent 为空数组时等价于清空历史。
// 写回最近列表（整表覆盖）；持久化失败被 host 吞掉，不影响当前会话。
// 调用方负责顺序与去重（最新在后）；本函数不裁剪长度，MAX_WINDOWS 的裁剪在 host 层完成。
export function writeRecent(items: { path: string; kind: DocKind }[]) {
  getHost().saveWindow({ recent: items });
}

// 把任意异常归一为可渲染的 Failure：优先用结构化错误码查本地化文案，
// PDF 密码错误（pdf.js 抛 PasswordException）按 password 处理，其余回落 generic；
// 文案缺失时用原始 message 兜底，保证 detail 永远非空。
export function describeFailure(t: Strings, error: unknown, path: string | null): Failure {
  const code =
    error instanceof CallError
      ? error.code
      : (error as Error)?.name === "PasswordException"
        ? "password"
        : undefined;
  const [title, detail] = (code && t.errors[code]) || t.errors.generic;
  const message = error instanceof Error ? error.message : String(error);
  return { path, title, detail: detail || message };
}

// 订阅宿主上下文变化：连接建立/displayMode/theme 变化时触发一次重渲染，返回最新 context。
// 用自增 tick 强制刷新（context 对象本身不可依赖，宿主可能原地复用）。
// 返回值是当前宿主 context 快照；卸载时取消订阅，不会在卸载后触发 setState。
export function useHostContext() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const update = () => setTick((tick) => tick + 1);
    window.addEventListener("office:hostchange", update);
    return () => window.removeEventListener("office:hostchange", update);
  }, []);
  return getHost().context;
}
