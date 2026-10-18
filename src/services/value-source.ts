/**
 * 配置缝的活值形态：纯值（测试 / 直装路径）与 getter（Loader 解析出的 volatile 读数）同收，
 * 消费方只认一个读口。配置页可在运行中改字段，服务因此在**使用时**读当前值，而不是装配时
 * 抄一份快照——抄下来的副本会让热改等到重启才生效。
 */
export type ValueSource<T> = T | (() => T)

/** 活值的唯一读者：每次调用读一次当前值，不缓存、不回写（缓存会把热改拖到下一次重建）。
 *  形态判定只住这里——`T` 自身可以是函数类型，泛型无法靠运行时收窄，故断言也收在这一处；
 *  消费方各写一遍判定就会长出第二套「什么时候读」的口径。 */
export function readValue<T>(source: ValueSource<T>): T {
  return typeof source === 'function' ? (source as () => T)() : source
}
