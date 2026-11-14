// INV-01 桶键由工作区与源路径组成：守住位置 桶键构造；改错故障 不同工作区互相污染。
// INV-02 空数组常量化：守住位置 模块常量；改错故障 每次渲染触发更新。
// INV-03 读取缺省返回空数组：守住位置 getComments；改错故障 消费方需处理 undefined。
// INV-04 添加按 id 去重：守住位置 addComment；改错故障 同一评论出现两次。
// INV-05 添加保持追加顺序：守住位置 展开顺序；改错故障 最新评论跑到最前。
// INV-06 删除无变化即返回原状态：守住位置 removeComment；改错故障 无谓重渲染。
// INV-07 按来源删除跨桶扫描：守住位置 removeCommentBySource；改错故障 其他工作区评论被误删。
// INV-08 来源删除以工作区前缀过滤：守住位置 前缀判断；改错故障 相似工作区键误匹配。
// INV-09 有变化才替换状态：守住位置 changed 标志；改错故障 全量对象重建。
// INV-10 恢复前先解除移除标记：守住位置 unmarkCodeCommentRemoved；改错故障 恢复的评论仍被过滤。
// INV-11 恢复要求源路径存在：守住位置 早退判断；改错故障 空路径产生非法桶。
// INV-12 恢复复用添加路径：守住位置 addComment 调用；改错故障 两条写入逻辑分叉。
// INV-13 清空只删目标桶：守住位置 解构删除；改错故障 其他注释被清空。
// INV-14 清空不存在的桶直接返回：守住位置 存在性判断；改错故障 每次清空都新建对象。
// INV-15 状态不持久化：守住位置 store 职责；改错故障 预览与磁盘数据混淆。
// INV-16 写入只通过 set：守住位置 实现；改错故障 外部直接改对象。
// INV-17 读取只返回当前快照：守住位置 get；改错故障 调用方持有可变引用。
// INV-18 评论对象整体替换：守住位置 addComment；改错故障 原地修改旧对象。
//
// 模块职责：按工作区与源路径分桶缓存代码评论预览。
// 状态所有权：预览桶全部归 Zustand store；模块无其他可变状态。
// 阅读顺序：先看桶键构造，再看添加与删除，最后看按来源删除与清空。
import { create } from "zustand";
import {
  getCodeCommentWorkspaceKey,
  unmarkCodeCommentRemoved,
  type CodeCommentComposerAttachment,
  type CodeCommentPreview,
  type CodeCommentRemovePayload,
} from "@/lib/codeCommentContext.js";

type CodeCommentPreviewBucketKey = string;

// EMPTY_CODE_COMMENT_PREVIEWS 作为稳定空数组引用。
// getComments 未命中时复用它，避免每次返回新数组。
// 消费方据 EMPTY_CODE_COMMENT_PREVIEWS 引用相等跳过重渲染。
// 该常量只读，不得 push 或赋值。
const EMPTY_CODE_COMMENT_PREVIEWS: CodeCommentPreview[] = [];

interface CodeCommentPreviewStoreState {
  commentsByBucketKey: Record<CodeCommentPreviewBucketKey, CodeCommentPreview[]>;
  getComments: (params: CodeCommentPreviewBucketParams) => CodeCommentPreview[];
  addComment: (params: CodeCommentPreviewBucketParams & { comment: CodeCommentPreview }) => void;
  removeComment: (params: CodeCommentPreviewBucketParams & { id: string }) => void;
  removeCommentBySource: (payload: CodeCommentRemovePayload) => void;
  restoreCommentFromAttachment: (attachment: CodeCommentComposerAttachment) => void;
  clearSource: (params: CodeCommentPreviewBucketParams) => void;
}

interface CodeCommentPreviewBucketParams {
  workspacePath: string;
  workspaceIdentity?: string;
  sourcePath: string;
}

// bucketKey 由工作区键与 sourcePath 拼接。
// 分隔符取 "\0"（空字符），避免与路径字符冲突。
// 同名 sourcePath 在不同工作区下 bucketKey 不同，互不干扰。
export function buildCodeCommentPreviewBucketKey({
  workspacePath,
  workspaceIdentity,
  sourcePath,
}: CodeCommentPreviewBucketParams): CodeCommentPreviewBucketKey {
  return `${getCodeCommentWorkspaceKey(workspacePath, workspaceIdentity)}\0${sourcePath}`;
}

// 单一 store 持有预览桶。
// 所有写入通过 set。
// 读取走 get 取当前快照。
// useCodeCommentPreviewStore 不做 localStorage 持久化。
export const useCodeCommentPreviewStore = create<CodeCommentPreviewStoreState>(
  (set, get) => ({
    commentsByBucketKey: {},
    getComments: (params) =>
      get().commentsByBucketKey[buildCodeCommentPreviewBucketKey(params)] ??
      EMPTY_CODE_COMMENT_PREVIEWS,
    // addComment 先 filter 掉同 id，再追加新条目。
    // 追加用展开运算保持原有顺序。
    // set 只创建新的 commentsByBucketKey 桶对象。
    addComment: (params) => {
      const bucketKey = buildCodeCommentPreviewBucketKey(params);
      set((state) => {
        const current = state.commentsByBucketKey[bucketKey] ?? [];
        return {
          commentsByBucketKey: {
            ...state.commentsByBucketKey,
            [bucketKey]: [
              ...current.filter((comment) => comment.id !== params.comment.id),
              params.comment,
            ],
          },
        };
      });
    },
    removeComment: (params) => {
      const bucketKey = buildCodeCommentPreviewBucketKey(params);
      set((state) => {
        const current = state.commentsByBucketKey[bucketKey] ?? [];
        const next = current.filter((comment) => comment.id !== params.id);
        if (next.length === current.length) {
          return state;
        }
        return {
          commentsByBucketKey: {
            ...state.commentsByBucketKey,
            [bucketKey]: next,
          },
        };
      });
    },
    // removeCommentBySource 只扫描 bucketKey 以 workspaceKey 开头的桶。
    // 未命中时返回 state 原引用。
    // 命中才构造新的 commentsByBucketKey。
    removeCommentBySource: (payload) => {
      const workspaceKey = getCodeCommentWorkspaceKey(
        payload.workspacePath,
        payload.workspaceIdentity,
      );
      set((state) => {
        let changed = false;
        const commentsByBucketKey = Object.fromEntries(
          Object.entries(state.commentsByBucketKey).map(([bucketKey, comments]) => {
            if (!bucketKey.startsWith(`${workspaceKey}\0`)) {
              return [bucketKey, comments];
            }
            const next = comments.filter((comment) => comment.id !== payload.id);
            changed ||= next.length !== comments.length;
            return [bucketKey, next];
          }),
        );
        return changed ? { commentsByBucketKey } : state;
      });
    },
    restoreCommentFromAttachment: (attachment) => {
      if (!attachment.sourcePath) {
        return;
      }
      unmarkCodeCommentRemoved({
        id: attachment.id,
        workspacePath: attachment.workspacePath,
        workspaceIdentity: attachment.workspaceIdentity,
      });
      get().addComment({
        workspacePath: attachment.workspacePath,
        workspaceIdentity: attachment.workspaceIdentity,
        sourcePath: attachment.sourcePath,
        comment: {
          id: attachment.id,
          sourcePath: attachment.sourcePath,
          sourceTitle: attachment.sourceTitle,
          startLine: attachment.startLine,
          endLine: attachment.endLine,
          selectedText: attachment.selectedText,
          comment: attachment.comment,
        },
      });
    },
    clearSource: (params) => {
      const bucketKey = buildCodeCommentPreviewBucketKey(params);
      set((state) => {
        if (!state.commentsByBucketKey[bucketKey]) {
          return state;
        }
        const { [bucketKey]: _removed, ...commentsByBucketKey } =
          state.commentsByBucketKey;
        return { commentsByBucketKey };
      });
    },
  }),
);
