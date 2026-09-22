/**
 * 缺键投影（CONTEXT.md「缺键投影」）：把规范值里 null/undefined 的字段**整键省略**后投影为
 * 工具输出。harness 对工具输出做 lossless-JSON 校验，`undefined` 属性值一票否决（整个工具调用
 * 报 "value is not lossless JSON"，真实结果被吞掉）——早期各工具的 execute 各自手抹
 * `...(x == null ? {} : { x })` 六处，纪律靠抄；本 module 是该纪律的唯一实现。
 *
 * 口径：null 与 undefined 同等对待（都省键）——wire 上 null 表示「源没这条信息」，工具面
 * 宁可缺键也不发 null（调用方拿不到字段即知道没有）。数组逐项投影，对象递归，原值不动。
 *
 * 形状说明：投影**改变类型**（可空字段变为缺席），故出参类型由调用方断言（TOut 缺省 = TIn）——
 * 这是投影的固有代价；schema 侧的一致性由 tests/tools/schema-contract.test.ts 钉住
 * （execute 输出过 harness 同款校验 + schema 属性集 ≡ wire 字段集表断言）。
 */
export function project<TIn, TOut = TIn>(value: TIn): TOut {
  return projectUnknown(value) as TOut
}

function projectUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectUnknown)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || v === null) continue
      out[k] = projectUnknown(v)
    }
    return out
  }
  return value
}
