/**
 * **沙箱 `java` 挂载面的唯一权威问法**（parse-census 面 B 问它；探针从普查里搬出来单点，
 * 免得第二处再抄一份挂载面）。
 *
 * 不抄协议表、也不正则抠 BOOTSTRAP——两者都是第二份抄本，必漂：
 * 拿桥表当分母会误报 async 行与 no-op 族，正则又会漏掉「一行挂两个键」。**真挂载面只住在沙箱对象里**。
 *
 * 顺带产出的**桩名单**给桥面自证（`tests/legado-coverage/bridge-surface.test.ts`）：同一方法可能同时在协议表（真实现）与 BOOTSTRAP 桩名单，
 * 后挂的桩会覆盖真实现——协议表全绿而脚本一调就抛；「实现了但够不着」只有问沙箱本体查得出。
 */
import { expect } from 'vitest'
import { evalJs } from '../src/engine/js-sandbox.js'

export async function probeJavaSurface(): Promise<{ names: Set<string>; stubs: Set<string> }> {
  const url = 'https://census.example.com/read/1'
  const out = await evalJs({
    code: 'var o = []; for (var n in java) { var f = java[n]; o.push(n + (typeof f === "function" ' +
      '&& String(f).indexOf("需要安卓宿主环境") >= 0 ? "\\tSTUB" : "")); } return o.join("\\n")',
    host: { result: '', baseUrl: url, source: 'https://census.example.com' },
    ctx: { baseUrl: url, source: 'https://census.example.com', vars: {} },
    loc: { segmentIndex: 0, segmentRaw: '@js:probeJavaSurface' },
    facet: 'content',
  })
  const text = out.value.kind === 'value' ? out.value.text : ''
  const names = new Set<string>()
  const stubs = new Set<string>()
  for (const line of text.split('\n').filter(Boolean)) {
    const [name, tag] = line.split('\t')
    // 每行形如「方法名」或「方法名<TAB>STUB」：名字位缺席只可能是自报格式崩了，宁可炸
    if (name === undefined) throw new Error(`沙箱自报的挂载行没有方法名：${JSON.stringify(line)}`)
    names.add(name)
    if (tag === 'STUB') stubs.add(name)
  }
  expect(names.size, `沙箱报出的 java 方法名只有 ${names.size} 个，探针或挂载面出了问题`).toBeGreaterThan(20)
  return { names, stubs }
}
