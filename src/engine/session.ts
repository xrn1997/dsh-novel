/** 源会话契约：脚本可见的按源状态；两个 adapter——进程内默认与 FileSourceSession。
 *  契约零 import：基础类型与协议面才不必为了一个类型反向依赖沙箱实现。 */

/**
 * 源会话：脚本可见的按源状态——cookie 垫片与源变量。显式 interface 而非裸模块 Map（后者无 reset、
 * 跨服务实例永生，跨源污染用例写不出来）。缺省 processSession（进程内）；生产组合根注入
 * FileSourceSession，测试注入 createSourceSession() 隔离实例。
 */
export interface SourceSession {
  /** 某源的 cookie 垫片（键值表，缺省建档） */
  cookieJar(sourceKey: string): Map<string, string>
  /** 某源的**键值变量表**（source.put/get 落这里） */
  sourceVars(sourceKey: string): Map<string, string>
  /** 某源键值表的非建档读口：从未碰过 → undefined（java.get 的 source 层要区分「从未设置」） */
  peekSourceVars(sourceKey: string): Map<string, string> | undefined
  /** 某源的**自定义变量单串槽**（source.setVariable/getVariable 落这里）。
   *  与键值表是两个存储：写串槽不许动键值表，反之亦然。不要合并成同一张 Map——
   *  setVariable 会顺手 clear() 掉 source.put 的键，getVariable 还会返回整表 JSON 壳。 */
  sourceString(sourceKey: string): string
  setSourceString(sourceKey: string, value: string | null): void
  /** 某源的 cache 垫片表（缓存本是全局表；按源隔离是 SourceSession 的既定口径；TTL 未接见矩阵 h-cache-ttl）。
   *  独立于键值表——不要借 sourceVars 加 `cache:` 前缀，否则脚本用 `source.get('cache:x')` 会串味。 */
  cacheStore(sourceKey: string): Map<string, string>
  /** 可选：删源时清掉该源的全部状态（文件实现有；进程内实现无） */
  forget?(sourceKey: string): void
  /** 可选落盘收尾（内存实现无此方法） */
  flush?(): void
}
