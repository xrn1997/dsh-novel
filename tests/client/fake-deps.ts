import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { planarNavigation } from '../../src/shared/wire.js'
import { prodCoreDeps, prodDeps, prodReaderDeps } from '../../src/client/deps.js'
import type { ClientCoreDeps, JobViewDeps, ReaderDeps, SettingsDeps, ShelfDeps } from '../../src/client/deps.js'

/**
 * 测试假依赖束——桩工厂唯一住址（此前三处测试各造一份形状略异的桩，主干加成员要同步多处且漂移
 * 无编译信号）。现在：返回类型绑主干束、靠 `...prod*` spread 自动跟上（缺成员声明处即红），
 * 覆写键绑**所有束的成员并集**（写错成员名即红，而不必先想清楚这个读者吃哪一束），
 * 缺省值全是确定性 vi.fn 假实现（零网络）。
 * `as` 收在本文件内各一处——Mock 与真实现的泛化签名互不兼容，逐处 cast 是工厂的职责。
 */

/** 覆写面：束按读者分家后，一条用例覆写的可能是任一束的成员；键仍绑真成员名，写错照样红 */
type DepKeys = keyof (ClientCoreDeps & ShelfDeps & JobViewDeps & SettingsDeps & ReaderDeps)
export type DepsOverrides = Partial<Record<DepKeys, unknown>>

/** 设置区束的可断言形态：wire 口/上报口/任务口全部是 Mock */
export type FakeSettingsDeps = SettingsDeps & {
  apiGet: Mock
  apiSend: Mock
  pushError: Mock
  pushOk: Mock
  startImportJob: Mock
  startBatchProbeJob: Mock
}

/** 阅读区束的可断言形态（views-wiring 的 ReaderView 套件用） */
export type FakeReaderDeps = ReaderDeps & {
  apiGet: Mock
  apiSend: Mock
  pushError: Mock
  streamExport: Mock
  saveBlob: Mock
}

/** 视图束的可断言形态：书架（+apiUpload）与带观察通道的三处（+apiEventStream）都吃这一份，
 *  工厂给超集，读者的参数类型各自收窄——测试不必按界面区分构造哪一束 */
export type FakeViewDeps = ShelfDeps & JobViewDeps & {
  apiGet: Mock
  apiSend: Mock
  apiUpload: Mock
  apiEventStream: Mock
  pushError: Mock
  pushOk: Mock
}

/** 设置区假依赖：缺省全假实现；over 按成员覆写（如 `{ apiSend: vi.fn(() => Promise.reject(...)) }`） */
export function makeDeps(over: DepsOverrides = {}): FakeSettingsDeps {
  return {
    ...prodDeps,
    apiGet: vi.fn(async () => null),
    apiSend: vi.fn(async () => ({})),
    pushError: vi.fn(),
    pushOk: vi.fn(),
    startImportJob: vi.fn(async () => ({ jobId: 'j-fake' })),
    startBatchProbeJob: vi.fn(async () => ({ jobId: 'j-fake' })),
    lastImportJob: () => null,
    fetchJobStatus: async () => null,
    ...over,
  } as FakeSettingsDeps
}

/** 阅读区假依赖（apiGet 按路径分流的缺省：navigation/chapter 各回一条——阅读会话挂载即取数）。
 *  目录读面是 `BookNavigation`（线性 chapters + 展示树 items），正文是 `ChapterContent`
 *  （阅读器只吃这一种形状；返回裸字符串的假实现会让阅读器当图文树解，直接崩）。
 *  凡束里真实现会发网络或写模块级 store 的成员，都必须盖成假实现——spread `prod*` 带进来的
 *  生产实现与文件头「零网络」的自述矛盾。
 *  第二参 `shelf` = 分流兜底那一支的读数（缺省空表 = 不在架）；用例要「已在架」只改这一格，
 *  别整段复制 navigation/chapter 分流——复制体一漂，测的就不是缺省形了。 */
export function makeReaderDeps(over: DepsOverrides = {}, shelf: unknown[] = []): FakeReaderDeps {
  return {
    ...prodReaderDeps,
    apiGet: vi.fn(async (path: string) => {
      if (path.includes('navigation')) {
        const chapters = [{ name: '第一章', url: 'u1' }]
        return { chapters, items: planarNavigation(chapters) }
      }
      if (path.includes('chapter')) return { kind: 'text', text: '第一章正文' }
      return shelf
    }),
    apiSend: vi.fn(async () => ({})),
    pushError: vi.fn(),
    pushOk: vi.fn(),
    streamExport: vi.fn(async () => new Blob(['正文'])),
    saveBlob: vi.fn(),
    ...over,
  } as FakeReaderDeps
}

/** 视图束假依赖：pushError 恒为 Mock；apiGet/apiSend 缺省空实现，over 覆写。
 *  `apiEventStream` 缺省「立刻结束、一帧不发」= 服务端没有推送可用 ⇒ 用例默认走轮询那条地基；
 *  要测推送就覆写它（帧由用例自己喂）。
 *  `jobPollMs` 缺省给观察通道的生产节拍；要按拍驱动的用例把它调小或换成假时钟，
 *  免得用例拿墙钟干等（原 explore-job 一条用例等 700ms 就是这么来的）。 */
export function makeCoreDeps(over: DepsOverrides = {}): FakeViewDeps {
  return {
    ...prodCoreDeps,
    apiGet: vi.fn(async () => null),
    apiSend: vi.fn(async () => ({})),
    apiUpload: vi.fn(async () => ({})),
    apiEventStream: vi.fn(async () => {}),
    pushError: vi.fn(),
    pushOk: vi.fn(),
    ...over,
  } as FakeViewDeps
}
