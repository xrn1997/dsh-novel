/**
 * 缺键投影：规范值里 null/undefined 的字段整键省略后作为工具输出。
 * harness 的 lossless-JSON 校验一票否决 `undefined` 属性值，故工具面宁可缺键也不发 null；
 * 数组逐项、对象递归，原值不动。这是该纪律的唯一实现。
 *
 * 投影改变类型（可空 → 缺席），出参由调用方断言（TOut 缺省 = TIn）；schema 一致性由
 * `tests/tools/schema-contract.test.ts` 钉住（execute 输出过 harness 同款校验 + schema 属性集断言）。
 */
// TOut 只出现在返回位是刻意的：调用点靠上下文标注推出它
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- 投影改变类型（可空→缺席），去掉这个返回位参数就得在每个调用点写 `as`
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
