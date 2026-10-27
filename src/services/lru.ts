/** 有界 LRU：Map 迭代序 = 新旧序。命中提升，写入超限淘汰最旧；缓存只装派生数据。 */
export function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const hit = map.get(key)
  if (hit === undefined) return undefined
  map.delete(key)
  map.set(key, hit)
  return hit
}

export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value as K)
}
