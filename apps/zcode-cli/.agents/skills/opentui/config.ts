/**
 * opentui skill 文档集合的 Astro content 配置。
 *
 * 职责：声明 `docs` 集合的 frontmatter schema，并把它注册到 `collections`，
 * 供 Astro 在构建期校验每篇文档的元数据。
 * 输入：每篇文档的 frontmatter（title 必填，其余可选）。
 * 输出：`collections.docs`，只被 Astro 构建消费，不在运行期产生副作用。
 * 失败语义：frontmatter 不符合 schema 时由 Astro 在构建期报错并终止构建，
 * 因此新增必填字段等同于对所有既有文档的强制迁移。
 */
import { defineCollection, z } from "astro:content"

const docs = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    order: z.number().int().nonnegative().optional(),
    navTitle: z.string().optional(),
    skill: z
      .object({
        include: z.boolean().default(true),
        entry: z.boolean().default(false),
        intents: z.array(z.string().trim().min(1)).default([]),
      })
      .optional(),
  }),
})

// Astro 约定的集合注册表出口：新增集合必须在此登记，否则构建期收集不到对应内容。
export const collections = {
  docs,
}
