// Git 检查点服务契约：定义创建、比对、区间恢复与删除四类能力，不含实现。
// 边界：仅声明 RPC 通道与类型；具体 git 操作由宿主侧执行，本文件不触及仓库。
// INV：检查点以 workspace 为作用域，跨仓库恢复无意义，调用方须保证 workspace 一致。
// INV：descriptor 与接口必须同名导出，改错会让依赖注入在启动期解析到 undefined。
import type {
  GitCheckpointDiff,
  GitCheckpointDiffQuery,
  GitCheckpointMeta,
  GitCheckpointRequest,
  GitCheckpointRestoreQuery,
  GitCheckpointRestoreResult,
  GitRepositoryRequest,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 方法均为异步：git 命令可能长时间阻塞，同步签名会把 IO 抖动传导到主线程。
export interface IGitCheckpointService {
  createCheckpoint(params: GitRepositoryRequest): Promise<GitCheckpointMeta>;
  diffCheckpoints(params: GitCheckpointDiffQuery): Promise<GitCheckpointDiff>;
  restoreBetweenCheckpoints(params: GitCheckpointRestoreQuery): Promise<GitCheckpointRestoreResult>;
  deleteCheckpoint(params: GitCheckpointRequest): Promise<void>;
}

// 同名 interface 与 const 合并声明是约定写法：前者提供类型，后者提供运行时通道描述符。
// 两处泛型参数必须一致，否则类型层与运行时的通道会指向不同契约。
export const IGitCheckpointService = createServiceDescriptor<IGitCheckpointService>(
  ServiceChannels.GitCheckpoint,
);
