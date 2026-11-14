// INV-01 过期码抛出固定状态与专用错误类：守住位置 分支顺序；改错故障 页面显示成普通失败。
// INV-02 不存在码抛出未找到：守住位置 独立分支；改错故障 用户看到无限重试。
// INV-03 私有分享校验令牌：守住位置 双条件；改错故障 无令牌也能读到私有内容。
// INV-04 私有分享令牌错误按不存在处理：守住位置 分支合并；改错故障 暴露分享确实存在。
// INV-05 旧客户端码返回不支持版本：守住位置 独立分支；改错故障 升级提示不出现。
// INV-06 部分不支持返回软提示计数：守住位置 返回值覆盖；改错故障 顶部缺少说明。
// INV-07 只读分享使用只读访问模式：守住位置 常量参数；改错故障 预览页出现导入按钮。
// INV-08 默认分享使用可导入模式：守住位置 兜底返回；改错故障 正常链接被判为只读。
// INV-09 预览时间为相对当前时间：守住位置 时间来源；改错故障 固定时间导致长期过期。
// INV-10 过期时间为创建后一天：守住位置 加法表达式；改错故障 预览立刻显示已过期。
// INV-11 样例覆盖三类行：守住位置 行数组；改错故障 卡片样式无法比对。
// INV-12 产物行带完整归属字段：守住位置 行字段；改错故障 产物卡片缺少来源信息。
// INV-13 产物清单与行引用同一标识：守住位置 标识常量；改错故障 点击产物跳转失败。
// INV-14 校验和用重复字符占位：守住位置 生成方式；改错故障 长度不符被校验拒绝。
// INV-15 完整性字段为固定占位：守住位置 字段填充；改错故障 预览页报完整性错误。
// INV-16 访问模式影响标题文案：守住位置 三元表达式；改错故障 私有分享标题泄漏。
// INV-17 方法签名与真实客户端一致：守住位置 参数列表；改错故障 替换实现后调用方编译失败。
// INV-18 模拟数据不外泄真实地址：守住位置 域名常量；改错故障 测试流量打到生产。
//
// 模块职责：分享预览页的本地模拟客户端与样例数据。
// 状态所有权：无状态；所有返回都在调用时新建，避免用例间互相污染。
// 阅读顺序：先看样例构造，再看类入口，最后看各特殊码分支。
import type { ConversationShareAccessMode, ConversationSharePreview } from "@zcode/shared";
import { ConversationSharePreviewClientError } from "./conversationSharePreviewClient.js";

// createdAt 取 Date.now() 减 60 秒，预览里相对时间稳定显示
// expires_at = createdAt + 24 * 60 * 60 * 1_000，固定一天后
// rows 三条覆盖 userInput、assistantText、artifact 三类
// title 按 accessMode === "private" 三元切换
function previewFor(accessMode: ConversationShareAccessMode): ConversationSharePreview {
  const createdAt = Date.now() - 60_000;
  return {
    schema_version: 1,
    unsupportedRowCount: 0,
    share: {
      title: accessMode === "private" ? "Private share" : "Conversation share preview",
      access_mode: accessMode,
      created_at: createdAt,
      expires_at: createdAt + 24 * 60 * 60 * 1_000,
    },
    rows: [
      {
        rowId: 1,
        turnId: "share-turn-1",
        productTurnId: "share-product-turn-1",
        createdAt,
        createdAtSeq: 1,
        kind: "userInput",
        origin: "realUser",
        text: "请介绍这个分享页面。",
      },
      {
        rowId: 2,
        turnId: "share-turn-1",
        productTurnId: "share-product-turn-1",
        createdAt: createdAt + 1_000,
        createdAtSeq: 2,
        kind: "assistantText",
        text: "这是一个公开的 ZCode 会话分享。",
        state: "complete",
      },
      // 让 dev mock 覆盖 artifact 卡片：它的视觉要与正文的 AssistantPreviewCards 对齐，
      // 没有样例数据就只能靠猜。
      {
        rowId: 3,
        turnId: "share-turn-1",
        productTurnId: "share-product-turn-1",
        createdAt: createdAt + 2_000,
        createdAtSeq: 3,
        kind: "artifact",
        artifactVersionId: "mock-artifact-1",
        logicalArtifactKey: "mock-report",
        displayName: "晨报_2026-08-28_早会版.pdf",
        artifactType: "pdf",
        mimeType: "application/pdf",
        sizeBytes: 172_974,
        sha256: "c".repeat(64),
        ref: "zcode-artifact://share/mock-artifact-1",
        state: "current",
      },
    ],
    artifacts: [
      {
        artifact_id: "mock-artifact-1",
        logical_artifact_key: "mock-report",
        producer_product_turn_id: "share-product-turn-1",
        artifact_version: 1,
        state: "current",
        ref: "zcode-artifact://share/mock-artifact-1",
        artifact_type: "pdf",
        display_name: "晨报_2026-08-28_早会版.pdf",
        extension: "pdf",
        mime_type: "application/pdf",
        size_bytes: 172_974,
        sha256: "c".repeat(64),
        url: "https://example.invalid/mock-artifact-1.pdf",
        url_expires_at: createdAt + 24 * 60 * 60 * 1_000,
      },
    ],
    integrity: {
      projection_sha256: "a".repeat(64),
      artifact_set_sha256: "b".repeat(64),
    },
  };
}

// MockConversationSharePreviewClient 的 getPreview 签名与真实客户端一致
// shareCode === "mock-expired" 抛 kind: "expired"
// shareCode === "mock-not-found" 抛 kind: "not_found"
// 其余 shareCode 回退到 previewFor("public_importable")
export class MockConversationSharePreviewClient {
  async getPreview(shareCode: string, accessToken?: string): Promise<ConversationSharePreview> {
    if (shareCode === "mock-expired") {
      throw new ConversationSharePreviewClientError({
        kind: "expired",
        message: "Share expired",
        status: 410,
        code: 3212,
      });
    }
    if (shareCode === "mock-not-found") {
      throw new ConversationSharePreviewClientError({
        kind: "not_found",
        message: "Share not found",
        status: 404,
        code: 3211,
      });
    }
    if (shareCode === "mock-private" && accessToken !== "mock-owner-token") {
      throw new ConversationSharePreviewClientError({
        kind: "not_found",
        message: "Share not found",
        status: 404,
        code: 3211,
      });
    }
    // 跨版本兼容的两个手工验收入口（真实链路里由 conversationSharePreviewClient 判定）。
    if (shareCode === "mock-outdated-client") {
      throw new ConversationSharePreviewClientError({
        kind: "unsupported_schema_version",
        message: "Share requires a newer ZCode",
        status: 200,
      });
    }
    // 认得的行照常渲染，另有一行本 build 认不出被跳过：顶部应出现软提示。
    // mock-partial-unsupported 返回 unsupportedRowCount: 1 触发软提示
    // 认得的 rows 照常渲染，只有一行被 build 跳过
    // mock-* 入口仅用于手工验收，真实链路走 conversationSharePreviewClient
    if (shareCode === "mock-partial-unsupported") {
      return { ...previewFor("public_importable"), unsupportedRowCount: 1 };
    }
    if (shareCode === "mock-readonly") return previewFor("public_readonly");
    if (shareCode === "mock-private") return previewFor("private");
    return previewFor("public_importable");
  }
}
