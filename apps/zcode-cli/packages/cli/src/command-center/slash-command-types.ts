// INV-01 判别字段固定为 type：守住位置 两个分支；改错故障 分发时无法收窄类型。
// INV-02 已知命令各自独立成员：守住位置 联合成员；改错故障 参数结构退化成字符串。
// INV-03 命令名是唯一分发依据：守住位置 name 字段；改错故障 分支匹配错命令。
// INV-04 原始名单独保留：守住位置 rawName 字段；改错故障 提示无法回显用户输入。
// INV-05 参数已裁剪：守住位置 args 语义；改错故障 下游需要重复去空白。
// INV-06 空参数允许存在：守住位置 args 类型；改错故障 无参数命令被判非法。
// INV-07 技能分支多两个字段：守住位置 skillName 与 task；改错故障 技能无法定位。
// INV-08 技能任务允许空串：守住位置 task 类型；改错故障 只加载技能的场景失败。
// INV-09 未知分支只保留原始名：守住位置 unknown 成员；改错故障 未知命令丢失输入。
// INV-10 每个成员都带参数与原始名：守住位置 公共字段；改错故障 分支处理时字段缺失。
// INV-11 命令名集合封闭：守住位置 联合成员列表；改错故障 新增命令静默落到未知。
// INV-12 不在此处做解析：守住位置 仅类型声明；改错故障 类型文件引入运行时依赖。
// INV-13 不携带执行结果：守住位置 字段范围；改错故障 分发方依赖不该有的状态。
// INV-14 不区分大小写规范化：守住位置 由解析器产出；改错故障 调用方各自转换不一致。
// INV-15 未知分支不带参数：守住位置 成员字段；改错故障 未知命令被误传参执行。
// INV-16 技能名单独成字段：守住位置 与任务分离；改错故障 名称与正文混在一起。
// INV-17 联合保持扁平：守住位置 单层结构；改错故障 收窄需要多层嵌套判断。
// INV-18 类型即契约：守住位置 导出点；改错故障 各方自建副本导致漂移。
//
// 模块职责：声明 slash 命令解析结果的判别联合，供分发层做穷尽匹配。
// 状态所有权：纯类型，无运行时状态。
// 阅读顺序：先看已知分支字段，再看技能分支，最后看未知分支。
// slash 命令解析结果的判别联合：type="known" 时 name 为规范化命令名（唯一可分发依据），
// rawName 为用户原始输入（用于提示回显）；args 为命令名之后的原始参数串（已 trim，可能为空）。
// type="unknown" 时保留 rawName，交给自定义命令查找与未知命令提示；skill 分支额外解析出
// skillName 与 task（task 可能为空串，表示只加载技能）。
// type 只有 "known" 与 "unknown" 两个顶层判别值。
// 已知分支按 name 逐命令展开，如 "compact" 或 "effort"。
// 未知分支只带 rawName，不带 args。
// 分发层按 type 与 name 收窄。
export type SlashCommand =
  | {
      args: string;
      name: "compact";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "effort";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "expert";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "fork";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "help";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "init";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "workflow";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "locale";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "login";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "logout";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "mcp";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "plugins";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "mode";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "model";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "new";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "resume";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "rewind";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      // skill 分支在公共字段外多携带 skillName 与 task 两个字段。
      // skillName 与 task 分离存放，便于分别回显与分发。
      // task 为空串表示只加载技能。
      // args 仍完整保留，不因拆分而截断。
      // rawName 与 type 等其他字段与其他已知分支一致。
      name: "skill";
      rawName: string;
      skillName: string;
      task: string;
      type: "known";
    }
  | {
      args: string;
      name: "goal";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      name: "dwf";
      rawName: string;
      type: "known";
    }
  | {
      args: string;
      rawName: string;
      // 未知分支不展开 name 字段。
      // rawName 是分发层唯一可用线索。
      // 查找与提示统一交给 handler 的自定义命令注册表处理。
      // args 不参与未知分支，避免被误执行。
      // 提示文案由上游 handler 决定，本类型不带文案。
      type: "unknown";
    };
