// MCP 服务状态轮询（L2）：把可选的服务列表能力转成侧栏可展示的只读快照。
// 本文件只负责轮询与状态维护，不做 MCP 连接/鉴权；取数与错误语义由注入的 adapter 决定。
// 副作用限于定时器与组件状态，卸载后丢弃过期结果、不再回写。
import { useEffect, useState } from "react";
import type { McpSidebarState } from "./app-model.js";
import type { TuiListMcpServers } from "./types.js";

const MCP_STATUS_REFRESH_INTERVAL_MS = 5_000;
const MCP_STATUS_RETRY_INTERVAL_MS = 10_000;

// 轮询式订阅 MCP 服务状态，供侧栏徽标展示。
// 输入：listMcpServers 为可空的取数函数；undefined 表示当前客户端未提供 MCP 能力，
// 此时立即收敛为 loading=false、servers={}，不注册任何定时器。
// 输出：McpSidebarState 只读快照；servers 为按服务名索引的对象，空对象表示无服务或未加载。
// 副作用：每 5s 成功刷新一次、失败后 10s 重试；组件卸载/依赖变化时清定时器并标记 disposed，
// 防止过期 Promise 回写已被销毁的状态。
// 失败语义：错误仅截取 message 存入 state.error，保留上一次成功取的 servers，不清空界面。
// 不变量：同一时刻最多一个待执行 timer；成功刷新会整体替换 state，从而顺带清除上次 error。
export function useMcpSidebarStatus(
  listMcpServers: TuiListMcpServers | undefined,
): McpSidebarState {
  const [state, setState] = useState<McpSidebarState>(() => ({
    // 有取数能力时先标记 loading，避免首帧误显示“无服务”。
    loading: listMcpServers !== undefined,
    servers: {},
  }));

  useEffect(() => {
    if (!listMcpServers) {
      setState({ loading: false, servers: {} });
      return;
    }
    const loadMcpServers = listMcpServers;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRefresh(delayMs: number) {
      // 单链式 setTimeout 而非 setInterval：只有上一次请求结束后才排下一次，天然避免请求堆积。
      timer = setTimeout(() => {
        void refresh();
      }, delayMs);
    }

    async function refresh() {
      setState((current) => ({
        ...current,
        // 已有数据时保持非 loading，避免每次轮询都让侧栏闪烁。
        loading: Object.keys(current.servers).length === 0,
      }));

      try {
        const servers = await loadMcpServers();
        // 已卸载后丢弃结果，防止对已销毁组件 setState。
        if (disposed) return;
        setState({ loading: false, servers });
        scheduleRefresh(MCP_STATUS_REFRESH_INTERVAL_MS);
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        // 失败保留旧 servers，仅记录错误并转入更长的重试间隔，避免故障时高频打满日志/网络。
        setState((current) => ({ ...current, error: message, loading: false }));
        scheduleRefresh(MCP_STATUS_RETRY_INTERVAL_MS);
      }
    }

    void refresh();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [listMcpServers]);

  return state;
}
