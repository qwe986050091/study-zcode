// 面板查找 Hook：输入去抖后调用查看器 find，维护命中总数/当前下标，并处理 Enter 跳转。
// 边界：不直接操作 DOM，所有搜索与高亮都委托 ViewerHandle；查询序号用于丢弃过期结果。
// 失败语义：查看器 find 抛错按 0 命中处理；切换文档/关闭查找时重置序号并清空高亮。
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ViewerHandle } from "#ui/viewers/types.ts";

/**
 * 面板查找的 UI 状态。
 * total 为 null 表示「尚未搜索」，与搜到 0 结果（total === 0）区分开；
 * index 为当前命中的 0 基下标，-1 表示无可跳转结果。
 */
export interface FindState {
  open: boolean;
  query: string;
  total: number | null;
  index: number;
}

// 关闭态常量：total 必须为 null（未搜索）、index 必须为 -1（无命中），
// 否则关闭/重开后残留的计数会让「无结果」提示误显示。
export const CLOSED_FIND: FindState = { open: false, query: "", total: null, index: -1 };

/**
 * 面板内查找：输入即搜，Enter / ⇧Enter 在结果间跳转。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模，行为与拆分前一致；setFind 仍交给 Shell，
 * 供载入新文档和 Agent 定位时直接关闭查找。
 */
export function useFind({
  viewer,
  docRef,
  ready,
  onOpen,
}: {
  viewer: RefObject<ViewerHandle | null>;
  docRef: RefObject<unknown>;
  ready: boolean;
  /** 打开查找前清理与查找互斥的界面状态（选区、Agent 标记、菜单）。 */
  onOpen(): void;
}) {
  const [find, setFind] = useState<FindState>(CLOSED_FIND);
  const findSeq = useRef(0);

  const openFind = useCallback(() => {
    if (!docRef.current) return;
    onOpen();
    setFind((state) => ({ ...state, open: true }));
    // Re-focus when already open.
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(".findbar .find-input");
      input?.focus();
      input?.select();
    });
  }, [docRef, onOpen]);
  const closeFind = useCallback(() => {
    findSeq.current++;
    viewer.current?.clearFind();
    setFind(CLOSED_FIND);
  }, [viewer]);
  const queryFind = useCallback((query: string) => {
    setFind((state) => ({ ...state, query, total: query.trim() ? state.total : null }));
  }, []);
  useEffect(() => {
    if (!find.open || !ready) return;
    // 序号标记本次查询：200ms 去抖后若用户已继续输入，旧查询的返回必须被丢弃。
    const mine = ++findSeq.current;
    // 200ms 去抖：连续输入只触发最后一次查找，避免每次按键都做全文扫描。
    const timer = setTimeout(async () => {
      const handle = viewer.current;
      if (!handle) return;
      const total = await handle.find(find.query).catch(() => 0);
      if (mine !== findSeq.current) return;
      setFind((state) => ({ ...state, total, index: total ? 0 : -1 }));
      if (total) handle.findGo(0);
    }, 200);
    return () => clearTimeout(timer);
  }, [find.open, find.query, ready, viewer]);
  const stepFind = useCallback(
    (direction: 1 | -1) => {
      if (!find.total) return;
      const index = (find.index + direction + find.total) % find.total;
      setFind((state) => ({ ...state, index }));
      viewer.current?.findGo(index);
    },
    [find.total, find.index, viewer],
  );

  return { find, setFind, openFind, closeFind, queryFind, stepFind };
}
