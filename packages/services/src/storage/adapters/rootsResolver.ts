/**
 * 数据根解析：R1 = 家目录下的 .zcode（永远存在），R2 = 自定义数据存储路径下的 .zcode（仅当设置了且 ≠ 家目录）。
 * 路径来源由调用方注入（desktop host 传 homedir 与 getDataBaseDir），模块内不读环境变量。
 */
// 存储根解析：把家目录与自定义数据目录翻译为有序的 StorageRootSpec 列表，供存储适配器检索。
// 边界：路径来源全部由调用方注入，本模块必须不读环境变量、不探测文件系统，保持纯函数可测。
// INV：列表顺序即检索优先级，home 恒在首位且必须存在；顺序错位会让用户读到错误的目录。
import { join, resolve } from "node:path";
import type { RootsResolverPort } from "../app/ports.js";
import type { StorageRootSpec } from "@zcode/shared";

export const ZCODE_DATA_DIR_NAME = ".zcode";

// 先 resolve 再比较：未经规范化的两个字符串可能指向同一目录，重复 root 会让扫描与去重翻倍。
// hasCustomDataBaseDir 是能力开关而非路径描述，下游据此决定能否迁移写入，不能按字符串臆断。
export function resolveStorageRoots(params: {
  homeDir: string;
  dataBaseDir: string;
}): StorageRootSpec[] {
  // 入参由调用方保证是绝对路径；resolve 只做规范化，模块不拼接 cwd，也不读环境变量。
  const home = resolve(params.homeDir);
  const dataBase = resolve(params.dataBaseDir);
  // 这个布尔量是「是否存在独立数据目录」的能力开关，下游据此判断能否迁移写入，不能按字符串臆断。
  const hasCustomDataBaseDir = dataBase !== home;
  const roots: StorageRootSpec[] = [
    { id: "home", path: join(home, ZCODE_DATA_DIR_NAME), hasCustomDataBaseDir },
  ];
  // 只有自定义目录与家目录实际不同才追加第二个根；否则两条路径指向同一 .zcode，扫描与去重会翻倍。
  if (hasCustomDataBaseDir) {
    roots.push({
      id: "dataBaseDir",
      path: join(dataBase, ZCODE_DATA_DIR_NAME),
      hasCustomDataBaseDir,
    });
  }
  return roots;
}

// 每次 resolveRoots 都重新取值，使用户运行期修改数据目录后无需重启即可生效。
export function createStorageRootsResolver(params: {
  getHomeDir: () => string;
  getDataBaseDir: () => string;
}): RootsResolverPort {
  return {
    // 每次调用都重新取 homeDir 与 dataBaseDir，用户运行期修改数据目录后无需重启即可生效。
    resolveRoots: async () =>
      resolveStorageRoots({ homeDir: params.getHomeDir(), dataBaseDir: params.getDataBaseDir() }),
  };
}
