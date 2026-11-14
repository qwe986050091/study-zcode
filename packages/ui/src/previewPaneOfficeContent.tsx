// INV-01 三种格式各自懒加载：守住位置 lazy 常量；改错故障 首包体积失控。
// INV-02 默认导出与文件名对齐：守住位置 import 映射；改错故障 懒加载拿到空模块。
// INV-03 渲染错误就地兜底：守住位置 错误边界；改错故障 整个预览区白屏。
// INV-04 错误态由复位键清理：守住位置 componentDidUpdate；改错故障 换文件后仍显示错误。
// INV-05 错误上报走统一日志：守住位置 componentDidCatch；改错故障 线上无法定位。
// INV-06 加载态是纯占位：守住位置 OfficePreviewLoading；改错故障 占位抢占交互。
// INV-07 错误提示带 alert 语义：守住位置 role 属性；改错故障 读屏不播报失败。
// INV-08 解码只在有数据时进行：守住位置 useMemo；改错故障 空数据触发异常。
// INV-09 解码结果按预览对象缓存：守住位置 依赖数组；改错故障 每帧重复解码。
// INV-10 无错误无数据仍算加载：守住位置 分支判断；改错故障 空白页没有任何提示。
// INV-11 有错误优先于有数据：守住位置 错误分支；改错故障 损坏文件仍尝试渲染。
// INV-12 兜底文案走国际化：守住位置 formatMessage；改错故障 中文硬编码直接透出。
// INV-13 主题只传明暗两值：守住位置 resolvedTheme；改错故障 子组件拿到未知主题。
// INV-14 外链打开由宿主注入：守住位置 onOpenBrowserUrl；改错故障 预览内直接导航。
// INV-15 格式分支必须穷尽：守住位置 三元链；改错故障 新格式落到旧 doc 渲染器。
// INV-16 缓冲以二进制传入：守住位置 buffer；改错故障 文本解码破坏二进制。
// INV-17 面板只组合不解析：守住位置 组件体；改错故障 预览逻辑被重复实现。
// INV-18 测试标识与请求参数一致：守住位置 sourcePath 与 resetKey；改错故障 不同文件共用缓存。
//
// 模块职责：组合 Office 三种格式的预览渲染、加载态与错误兜底。
// 状态所有权：数据与格式来自上层 props；仅错误边界持有错误态。
// 阅读顺序：先看懒加载与错误边界，再看数据解码与分支，最后看渲染树。
import { Component, lazy, Suspense, useMemo, type ErrorInfo, type ReactNode } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { decodeBase64ToArrayBuffer, type OfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

// LazyXlsxContent、LazyDocxContent 与 LazyLegacyDocContent 各自 dynamic import 拆包。
// 独立 chunk 降低首包体积。
// 加载期间由 Suspense 接管。
// lazy() 的 default 映射到模块具名导出，避免拿到空模块。
const LazyXlsxContent = lazy(async () => {
  const module = await import("@/previewPaneOfficeXlsxContent.js");
  return { default: module.PreviewPaneOfficeXlsxContent };
});

const LazyDocxContent = lazy(async () => {
  const module = await import("@/previewPaneOfficeDocxContent.js");
  return { default: module.PreviewPaneOfficeDocxContent };
});

const LazyLegacyDocContent = lazy(async () => {
  const module = await import("@/previewPaneOfficeLegacyDocContent.js");
  return { default: module.PreviewPaneOfficeLegacyDocContent };
});

// 边界只捕获子树渲染错误。
// 错误态保存在实例 state。
// OfficePreviewErrorBoundary 在 resetKey 变化时清除 hasError。
// componentDidCatch() 把 error.message 与 componentStack 交给 logger.error()。
class OfficePreviewErrorBoundary extends Component<
  {
    children: ReactNode;
    fallback: ReactNode;
    resetKey: string;
  },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error("[PreviewPane] Office 预览组件渲染失败", {
      error: error.message,
      componentStack: info.componentStack ?? "",
    });
  }

  // componentDidUpdate() 只在 hasError 为真时比较 resetKey。
  // resetKey 变化即重新尝试渲染同一子树。
  // 同一文件的 resetKey 不变，就不重置错误态。
  componentDidUpdate(previousProps: Readonly<{ resetKey: string }>) {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function OfficePreviewLoading() {
  return (
    <div
      aria-busy="true"
      className="h-full min-h-0 w-full bg-background"
      data-office-preview-pending
    />
  );
}

function OfficePreviewErrorMessage({ children }: { children: ReactNode }) {
  return (
    <div className="p-3 text-ui-base text-destructive" role="alert">
      {children}
    </div>
  );
}

export function PreviewPaneOfficeContent({
  error,
  kind,
  loading,
  onOpenBrowserUrl,
  preview,
  resolvedTheme,
  sourcePath,
}: {
  error: string | null;
  kind: OfficeFilePreviewKind;
  loading: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  preview: FileBinaryPreview | null;
  resolvedTheme: "light" | "dark";
  sourcePath: string;
}) {
  const { intl } = useZCodeIntl();
  const errorMessage = intl.formatMessage({
    id: "codeViewer.officeUnavailable",
  });
  // buffer 的 useMemo() 只在 preview 非空时调用 decodeBase64ToArrayBuffer()。
  // 依赖数组只有 [preview]，其他 props 变化不触发解码。
  // preview 切换时重新解码，旧 buffer 被丢弃。
  const buffer = useMemo(
    () => (preview ? decodeBase64ToArrayBuffer(preview.dataBase64) : null),
    [preview],
  );

  // loading 为真时优先渲染 OfficePreviewLoading。
  // !error && !buffer 时也保持占位，不提前进入兜底。
  // error 与 buffer 都不存在才走错误分支。
  if (loading || (!error && !buffer)) {
    return <OfficePreviewLoading />;
  }
  if (error || !buffer) {
    return <OfficePreviewErrorMessage>{error ?? errorMessage}</OfficePreviewErrorMessage>;
  }

  const fallback = <OfficePreviewErrorMessage>{errorMessage}</OfficePreviewErrorMessage>;

  return (
    <OfficePreviewErrorBoundary
      fallback={fallback}
      resetKey={`${kind}:${sourcePath}:${preview?.totalBytes ?? 0}`}
    >
      <Suspense fallback={<OfficePreviewLoading />}>
        {kind === "excel" ? (
          <LazyXlsxContent
            buffer={buffer}
            errorMessage={errorMessage}
            isDark={resolvedTheme === "dark"}
            onOpenBrowserUrl={onOpenBrowserUrl}
            sourcePath={sourcePath}
          />
        ) : kind === "docx" ? (
          <LazyDocxContent
            buffer={buffer}
            errorMessage={errorMessage}
            onOpenBrowserUrl={onOpenBrowserUrl}
            sourcePath={sourcePath}
          />
        ) : (
          <LazyLegacyDocContent
            buffer={buffer}
            errorMessage={errorMessage}
            onOpenBrowserUrl={onOpenBrowserUrl}
            sourcePath={sourcePath}
          />
        )}
      </Suspense>
    </OfficePreviewErrorBoundary>
  );
}
