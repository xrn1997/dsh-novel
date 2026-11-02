/**
 * 测试夹具的取位与存在性收口。
 *
 * 这批数组、记录表与 `.find()` 结果都是用例自己按已知内容造出来的（注册表快照、目录条目、
 * 搜索结果分组、资源表、导航树、调用记录）。开启越界检查后它们一律变成"可能没有"，而**这里
 * 没有"没有"这一档**：拿不到就是夹具与断言脱节。那时要的是「缺了哪一格」这条信息，而不是深处
 * 冒出来的 TypeError，也不是被可选链或断言折叠过去、由下一行断言蒙对的假绿。
 *
 * 越界在这里不是真实输入状态（不像盘上的字节流或宿主给的数据），所以不落到任何 Miss / 空集合
 * 口径上，只落一句可读的抛错。只给测试用：生产代码的越界要走各层已有的失败通道
 * （档位与口径见 `ADR-0053`）。
 */

/** 值缺席即夹具脱节：把缺的那一格说出来。缺席在索引面是 `undefined`，在 DOM 查询面是 `null`，两者都算。 */
export function must<T>(value: T | null | undefined, what: string): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(`夹具缺${what}`)
  return value
}

/** 按位置取夹具条目；越界即响亮失败（序号按人的第几项说，共几项一起给出）。 */
export function pick<T>(items: readonly T[], index: number): NonNullable<T> {
  return must(items[index], `第 ${index + 1} 项（共 ${items.length} 项）`)
}

/** 按末项取夹具条目；空数组即夹具脱节。 */
export function last<T>(items: readonly T[]): NonNullable<T> {
  return must(items.at(-1), `末项（共 ${items.length} 项）`)
}
