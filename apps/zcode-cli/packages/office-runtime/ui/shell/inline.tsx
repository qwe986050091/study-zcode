// 内联（对话内嵌）形态的外壳：渲染只读预览，并覆盖“展开到侧栏”的点击入口。
// 边界：不发起 RPC、不持有查看器状态，children 与各 ref 均由 Shell 传入；分页/选择条不在本形态出现。
// 副作用：只透传 onExpand 意图，不读写存储、不滚动文档，也不改变当前选区。
import type { ReactNode, RefObject } from "react";
import type { DocKind, DocumentInfo } from "#office/contract.ts";
import type { Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { baseName } from "#ui/rpc.ts";
import { ErrorState, Skeleton } from "#ui/shell/panes.tsx";
import type { Failure } from "#ui/shell/state.ts";

// 内联形态只做只读预览：没有翻页控件、没有选择操作条，整块画布上覆盖一层透明按钮用于“展开到侧栏”。
// 组件自身无副作用：不发起 RPC、不写存储，切全屏完全由 Shell 传入的 onExpand 决定。
// 空态/骨架/错误三种提示与侧栏复用同一批组件，保证两种形态文案与行为一致。
// 维护不变量：children 由 Shell 渲染，本组件不持有查看器状态，也不做任何滚动/缩放。
/**
 * 内联（对话内嵌）模式的面板：只读预览，点击任意处切到侧栏全屏。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模；查看器元素与各 ref 仍由 Shell 持有并传入。
 */
export function InlineShell({
  appRef,
  canvasRef,
  t,
  path,
  info,
  kind,
  showSkeleton,
  failure,
  nothing,
  onExpand,
  children,
}: {
  // 外层容器；内联高度固定，Shell 只用它做全屏切换与尺寸声明。
  appRef: RefObject<HTMLDivElement | null>;
  // 查看器挂载点；滚动与定位由查看器自理，本组件不读写 scrollTop。
  canvasRef: RefObject<HTMLDivElement | null>;
  t: Strings;
  // 标题口径：path 可空（无文档时显示产品名），info 提供类型与页数元信息，kind 决定骨架形态。
  path: string | null;
  info: DocumentInfo | undefined;
  kind: DocKind | null;
  // 提示三态互斥：failure 优先于 skeleton，nothing 只在既无文档也无加载时出现。
  showSkeleton: boolean;
  failure: Failure | null;
  nothing: boolean;
  // 展开动作：完成宿主 displayMode 切换；本组件不校验是否成功。
  onExpand(): void;
  children: ReactNode;
}) {
  return (
    <div ref={appRef} className="app inline">
      <header className="docbar">
        <div className="doctitle static" title={path ?? undefined}>
          <span className="name">{path ? baseName(path) : t.title}</span>
          {info && t.meta[info.kind](info.units) ? (
            <span className="meta">{t.meta[info.kind](info.units)}</span>
          ) : null}
        </div>
        <span className="spacer" />
        <button type="button" className="btn sm" title={t.sidePanel} onClick={onExpand}>
          <Icon name="maximize-2" size={12} />
          {t.sidePanel}
        </button>
      </header>
      <div className="stage">
        <div ref={canvasRef} className="canvas">
          {children}
          {showSkeleton ? <Skeleton kind={kind} /> : null}
          {failure ? (
            <ErrorState
              t={t}
              title={failure.title}
              detail={failure.detail}
              onOpenAnother={onExpand}
            />
          ) : null}
          {nothing ? <div className="failed muted">{t.openTitle}</div> : null}
          <button
            type="button"
            className="glance-cover"
            aria-label={t.sidePanel}
            onClick={onExpand}
          />
        </div>
      </div>
    </div>
  );
}
