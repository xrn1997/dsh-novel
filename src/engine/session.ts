/** 源会话契约：脚本可见的按源状态；两个 adapter——进程内默认与 FileSourceSession。契约零 import。 */

/**
 * 源会话：显式 interface 而非裸模块 Map（后者无 reset、跨服务实例永生，跨源污染用例写不出来）。
 * 缺省 processSession（进程内）；生产组合根注入 FileSourceSession，测试注入 createSourceSession()。
 */
export interface SourceSession {
  cookieJar(sourceKey: string): Map<string, string>
  sourceVars(sourceKey: string): Map<string, string>
  /** 某源键值表的非建档读口：从未碰过 → undefined（java.get 的 source 层要区分「从未设置」） */
  peekSourceVars(sourceKey: string): Map<string, string> | undefined
  /** 某源的**自定义变量单串槽**（source.setVariable/getVariable 落这里）。与键值表是两个存储：写串槽不许
   *  动键值表，反之亦然——合并成一张 Map 会让 setVariable 顺手 clear() 掉 source.put 的键。 */
  sourceString(sourceKey: string): string
  setSourceString(sourceKey: string, value: string | null): void
  /** 某源的 cache 垫片表（脚本侧 cache 是全局表，本仓刻意按源隔离；TTL 未接见矩阵 h-cache-ttl）。
   *  独立于键值表——不要借 sourceVars 加 `cache:` 前缀，否则 `source.get('cache:x')` 会串味。 */
  cacheStore(sourceKey: string): Map<string, string>
  forget?(sourceKey: string): void
  flush?(): void
}
