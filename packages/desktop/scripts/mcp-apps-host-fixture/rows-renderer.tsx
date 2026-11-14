// INV-01 复用真实路径：守住位置 时间线与插件面板的导入；改错故障：夹具另写渲染，测不到展示资格与折叠策略。
// INV-02 只读会话：守住位置 PluginUiSessionProvider 的 readOnly；改错故障：夹具可写，污染会话数据。
// INV-03 稳定行键：守住位置 rowId 与 toolCallId 的取值；改错故障：行复用时状态串到别的用例。
// INV-04 映射完整：守住位置 rows 的字段集合；改错故障：缺字段导致时间线渲染报错。
// INV-05 模式互斥：守住位置 widgetMeta 与 surface 的二选一；改错故障：同一行同时声明控件与会话面板。
// INV-06 错误双写：守住位置 output 与 error 的成对生成；改错故障：错误行只有错误码没有文本。
// INV-07 布局等待：守住位置 双帧等待；改错故障：断言早于绘制，读到旧布局。
// INV-08 立即检查：守住位置 waitRowsRunning 的首次 check；改错故障：订阅前已完成的状态永远等不到。
// INV-09 终态取消：守住位置 off 的调用；改错故障：重复回调造成订阅泄漏。
// INV-10 错误拒绝：守住位置 phase 为 error 的分支；改错故障：页面失败但测试一直挂起。
// INV-11 可见性查询：守住位置 rowPageVisible；改错故障：无法断言面板是否真正可见。
// INV-12 接管归属：守住位置 owners 的选择器；改错故障：卡片与占位的归属行统计错误。
// INV-13 手动固定：守住位置 pin 分支；改错故障：无法构造已固定的展示场景。
// INV-14 强制同帧：守住位置 flushSync；改错故障：状态更新未在断言前落地。
// INV-15 挂载开关：守住位置 mounted 状态；改错故障：无法验证卸载清理路径。
// INV-16 就绪回调：守住位置 ready 的调用时机；改错故障：测试在命令挂载前开始驱动。
// INV-17 固定主题：守住位置 rowContext 的 theme；改错故障：深浅主题差异污染断言。
// INV-18 作用域同源：守住位置 config.scope 的展开；改错故障：卡片与侧栏被识别为不同会话。
//
// 模块职责：在浏览器里挂载真实时间线与插件侧栏，暴露驱动与查询命令供端到端断言。
// 状态所有权：用例列表与侧栏标签归夹具组件；页面注册表归产品代码。
// 阅读顺序：导入 → 用例类型 → 布局等待 → 行映射 → 命令安装 → 渲染树。
import { useCallback, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "../../../ui/src/i18n/IntlProvider.js";
import { TabStoreProvider } from "../../../ui/src/store/TabStoreProvider.js";
import { ConversationTimeline } from "../../../ui/src/v4/ConversationTimeline.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "../../../ui/src/lib/codePreviewSettings.js";
import {
  PluginUiSessionProvider,
  PluginUiWorkspaceProvider,
  PluginUiSidePane,
  buildPluginUiSidePaneTabId,
} from "../../../ui/src/plugin-ui/index.js";
import { setPluginUiManualPin } from "../../../ui/src/plugin-ui/app/pluginUiDisclosureStore.js";
import {
  pluginUiPages,
  subscribePage,
} from "../../../ui/src/plugin-ui/adapters/pluginUiPageRegistry.js";
import { buildPluginUiSurfaceKey } from "../../../ui/src/plugin-ui/contract.js";

// 用例描述只含状态与展示开关，具体协议字段由映射函数补齐。
// 状态缺省为成功，未指定即成功便于只关注失败差异。
//
export interface RowCase {
  id: number;
  status?: ToolCallRow["status"];
  isError?: boolean;
  fullscreen?: boolean;
  widget?: boolean;
}
// 两次动画帧确保布局与绘制都完成，断言才可靠。
// 等待没有拒绝路径，超时由外层测试控制。
//
const layout = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/** 使用真实时间线和工具行，不直接挂 PluginUiCard；避免绕过展示资格/替代/折叠策略。 */
// 配置由夹具页面注入，包含作用域与插件展示信息。
// `onReady` 在命令挂载后调用，测试随后开始驱动。
//
export function RowsFixture({ config, ready }: { config: any; ready: () => void }) {
  const [cases, setCases] = useState<RowCase[]>([]);
  const [mounted, setMounted] = useState(true);
  const [tab, setTab] = useState<any>(null);
  const [opens, setOpens] = useState(0);
  const open = useCallback((request: any) => {
    setOpens((n) => n + 1);
    setTab({ ...request, id: buildPluginUiSidePaneTabId(request), type: "plugin-ui" });
  }, []);
  // 每行都映射成完整工具行，键与时间戳用用例序号保证稳定。
  // 镜像卡展示信息取自配置，错误行额外补错误体。
  //
  const rows = useMemo<ToolCallRow[]>(
    () =>
      cases.map((c) => ({
        kind: "toolCall",
        rowId: c.id,
        turnId: "fixture-turn",
        createdAt: c.id,
        createdAtSeq: c.id,
        toolCallId: `row-${c.id}`,
        toolName: "mcp__fixture__edit",
        status: c.status ?? "success",
        inputText: JSON.stringify({ sequence: c.id }),
        output: { text: c.isError ? `fixture-error-${c.id}` : `fixture-success-${c.id}` },
        ...(c.status === "error"
          ? { error: { code: "fixture", message: `transport-error-${c.id}` } }
          : {}),
        display: {
          kind: "mcp_tool",
          serverName: config.presentation.serverName,
          toolName: "edit",
          ui: {
            pluginId: config.presentation.pluginId,
            resourceUri: config.presentation.resourceUri,
            ...(c.widget
              ? { widgetMeta: JSON.stringify({ "openai/widgetSessionId": "same" }) }
              : { surface: "same" }),
            ...(c.isError ? { isError: true } : {}),
            preferredDisplayMode: c.fullscreen ? "fullscreen" : "inline",
            showInline: true,
            structuredContent: JSON.stringify({ sequence: c.id }),
          },
        },
      })),
    [cases, config],
  );
  // 上下文固定浅色主题与默认预览设置，排除产品默认值干扰。
  // 作用域来自配置，保证卡片与侧栏被识别为同一会话。
  //
  const rowContext = useMemo(
    () => ({
      ...config.scope,
      theme: "light" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [config],
  );
  useEffect(() => {
    // 驱动命令挂在 window 上，页面脚本可直接调用而不依赖打包导出。
    // 设置前可选手动固定，用于构造已固定的接管场景。
    //
    (window as any).setRows = async (next: RowCase[], pin = false) => {
      if (pin)
        for (const c of next) setPluginUiManualPin(config.scope.sessionId, `row-${c.id}`, true);
      flushSync(() => setCases(next));
      await layout();
    };
    (window as any).mountRows = async (value: boolean) => {
      flushSync(() => setMounted(value));
      await layout();
    };
    (window as any).rowsState = () => ({
      cards: document.querySelectorAll('[data-tool-call-id] [data-testid="plugin-ui-card"]').length,
      placeholders: document.querySelectorAll('[data-testid="plugin-ui-side-pane-placeholder"]')
        .length,
      opens,
      sidebar: tab !== null,
      views: document.querySelectorAll("webview").length,
      owners: [
        ...document.querySelectorAll(
          '[data-tool-call-id] [data-testid="plugin-ui-card"], [data-testid="plugin-ui-side-pane-placeholder"]',
        ),
      ].map((e) => e.closest("[data-tool-call-id]")?.getAttribute("data-tool-call-id")),
    });
    (window as any).waitRowsRunning = () =>
      new Promise<void>((resolve, reject) => {
        const key = buildPluginUiSurfaceKey(
          { ...config.scope, ...config.presentation },
          config.scope.scope,
        );
        let off = () => {};
        // 页面进入运行中即放行，进入错误状态则拒绝并带上原因。
        // 先订阅再立即检查，覆盖订阅前已完成的状态。
        //
        const check = () => {
          const snapshot = pluginUiPages.get(key)?.snapshot();
          if (snapshot?.phase === "running") {
            off();
            resolve();
          }
          if (snapshot?.phase === "error") {
            off();
            reject(new Error(snapshot.error ?? "page failed"));
          }
        };
        // 取消函数在终态调用，避免重复放行或订阅泄漏。
        // `check` 可能被多次触发，取消后 `cancelled` 置真即不再生效。
        //
        off = subscribePage(key, check);
        check();
      });
    (window as any).rowPageVisible = () =>
      pluginUiPages.get(
        buildPluginUiSurfaceKey({ ...config.scope, ...config.presentation }, config.scope.scope),
      )?.visible === true;
    ready();
  }, [config, opens, tab, ready]);
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TabStoreProvider>
        <PluginUiWorkspaceProvider onOpenSidePane={open}>
          <PluginUiSessionProvider
            {...config.scope}
            readOnly
            sendText={async () => {}}
            uploadAttachment={async () => {
              throw new Error("not used");
            }}
          >
            <div style={{ position: "absolute", left: 10, top: 10, width: 460, height: 650 }}>
              {mounted && (
                <ConversationTimeline
                  rows={rows}
                  totalCount={rows.length}
                  sessionKey={config.scope.sessionId}
                  rowContext={rowContext}
                  hideTurnNavigator
                />
              )}
            </div>
            {tab && (
              <div style={{ position: "absolute", left: 500, top: 10, width: 450, height: 650 }}>
                <button id="close-sidebar" onClick={() => setTab(null)}>
                  Close sidebar
                </button>
                <PluginUiSidePane tab={tab} onCloseTab={() => setTab(null)} />
              </div>
            )}
          </PluginUiSessionProvider>
        </PluginUiWorkspaceProvider>
      </TabStoreProvider>
    </ZCodeIntlProvider>
  );
}
