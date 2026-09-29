/**
 * **沙箱 `java` 挂载面的唯一权威问法**（两个消费者——parse-census 面 B 与 host-methods——必须问
 * 同一个对象，否则两份判据各漂，故从普查里搬出来单点）。
 *
 * 不抄协议表、也不正则抠 BOOTSTRAP——两者都是第二份抄本，必漂（第一版拿桥表当分母误报 async 行
 * 与 no-op 族，改正则后又漏了「一行挂两个键」）。**真挂载面只住在沙箱对象里**。
 *
 * 顺带产出的**桩名单**给普查面 C：2026-09-22 实证 digestHex 一族同时在协议表（真实现）与 BOOTSTRAP
 * 桩名单、后挂的桩覆盖了真实现——协议表全绿而脚本一调就抛；「实现了但够不着」只有问沙箱本体查得出。
 */
import { expect } from 'vitest'
import { evalJs } from '../src/engine/js-sandbox.js'

export async function probeJavaSurface(): Promise<{ names: Set<string>; stubs: Set<string> }> {
  const url = 'https://census.example.com/read/1'
  const out = await evalJs(
    'var o = []; for (var n in java) { var f = java[n]; o.push(n + (typeof f === "function" ' +
    '&& String(f).indexOf("需要安卓宿主环境") >= 0 ? "\\tSTUB" : "")); } return o.join("\\n")',
    { result: '', baseUrl: url, source: 'https://census.example.com' },
    { baseUrl: url, source: 'https://census.example.com', vars: {} },
    { segmentIndex: 0, segmentRaw: '@js:probeJavaSurface' },
    'content',
  )
  const text = out.value.kind === 'value' ? out.value.text : ''
  const names = new Set<string>()
  const stubs = new Set<string>()
  for (const line of text.split('\n').filter(Boolean)) {
    const [n, tag] = line.split('\t')
    names.add(n)
    if (tag === 'STUB') stubs.add(n)
  }
  expect(names.size, `沙箱报出的 java 方法名只有 ${names.size} 个，探针或挂载面出了问题`).toBeGreaterThan(20)
  return { names, stubs }
}
