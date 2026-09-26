import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { planarNavigation } from '../../src/shared/wire.js'
import { prodCoreDeps, prodDeps, prodReaderDeps } from '../../src/client/deps.js'
import type { ClientCoreDeps, ReaderDeps, SettingsDeps } from '../../src/client/deps.js'

/**
 * 测试假依赖束——桩工厂唯一住址。
 *
 * 此前三处测试文件各造一份形状略异的桩（import-pane.test / settings-toggle.test /
 * views-wiring.test），SettingsDeps 加一个成员要同步多处且漂移无编译信号。现在：
 * - 返回类型绑主干束（SettingsDeps / ReaderDeps / ClientCoreDeps）——主干加成员，
 *   工厂靠 `...prod*` spread 自动跟上，缺一个成员声明处即红（「只动一处桩」的类型保障）；
 * - 覆写键集绑 `keyof <主干束>`——写错成员名即红；
 * - 缺省值全为确定性 vi.fn 假实现（零网络），成员级 Mock 可直接断言调用次数/载荷。
 *
 * `as` 收在本文件内各一处：Mock 与真实现的泛化签名（如 apiGet<T>）互不兼容，
 * 测试侧不该逐处 cast——那是工厂的职责。
 */

/** 覆写集：键绑主干束成员名；值放宽 unknown（测试传 vi.fn() 不必逐处 cast） */
type Overrides<T> = Partial<Record<keyof T, unknown>>

/** 各工厂的覆写参数类型（测试侧的局部工厂包装它，键面同样绑主干束） */
export type SettingsDepsOverrides = Overrides<SettingsDeps>
export type ReaderDepsOverrides = Overrides<ReaderDeps>
export type CoreDepsOverrides = Overrides<ClientCoreDeps>

/** 设置区束的可断言形态：wire 口/上报口/任务口全部是 Mock */
export type FakeSettingsDeps = SettingsDeps & {
  apiGet: Mock
  apiSend: Mock
  apiUpload: Mock
  pushError: Mock
  pushOk: Mock
  startImportJob: Mock
  startBatchProbeJob: Mock
}

/** 阅读区束的可断言形态（views-wiring 的 ReaderView 套件用） */
export type FakeReaderDeps = ReaderDeps & {
  apiGet: Mock
  apiSend: Mock
  apiUpload: Mock
  pushError: Mock
  streamExport: Mock
  saveBlob: Mock
}

/** 核心束的可断言形态（ShelfView/SearchView 套件用） */
export type FakeCoreDeps = ClientCoreDeps & {
  apiGet: Mock
  apiSend: Mock
  apiUpload: Mock
  apiEventStream: Mock
  pushError: Mock
}

/** 设置区假依赖：缺省全假实现；over 按成员覆写（如 `{ apiSend: vi.fn(() => Promise.reject(...)) }`） */
export function makeDeps(over: Overrides<SettingsDeps> = {}): FakeSettingsDeps {
  return {
    ...prodDeps,
    apiGet: vi.fn(async () => null),
    apiSend: vi.fn(async () => ({})),
    apiUpload: vi.fn(async () => ({})),
    apiEventStream: vi.fn(async () => {}),
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
 *  ReaderDeps 是 ClientCoreDeps 超集，apiUpload/pushError 也必须盖成假实现，否则 spread
 *  prodReaderDeps 会把生产真实现带进来（真发 fetch / 写模块级 store）——与文件头「零网络」自述矛盾。 */
export function makeReaderDeps(over: Overrides<ReaderDeps> = {}): FakeReaderDeps {
  return {
    ...prodReaderDeps,
    apiGet: vi.fn(async (path: string) => {
      if (path.includes('navigation')) {
        const chapters = [{ name: '第一章', url: 'u1' }]
        return { chapters, items: planarNavigation(chapters) }
      }
      if (path.includes('chapter')) return { kind: 'text', text: '第一章正文' }
      return []
    }),
    apiSend: vi.fn(async () => ({})),
    apiUpload: vi.fn(async () => ({})),
    apiEventStream: vi.fn(async () => {}),
    pushError: vi.fn(),
    streamExport: vi.fn(async () => new Blob(['正文'])),
    saveBlob: vi.fn(),
    ...over,
  } as FakeReaderDeps
}

/** 核心束假依赖：pushError 恒为 Mock；apiGet/apiSend 缺省空实现，over 覆写。
 *  `apiEventStream` 缺省「立刻结束、一帧不发」= 服务端没有推送可用 ⇒ 用例默认走轮询那条地基；
 *  要测推送就覆写它（帧由用例自己喂）。 */
export function makeCoreDeps(over: Overrides<ClientCoreDeps> = {}): FakeCoreDeps {
  return {
    ...prodCoreDeps,
    apiGet: vi.fn(async () => null),
    apiSend: vi.fn(async () => ({})),
    apiUpload: vi.fn(async () => ({})),
    apiEventStream: vi.fn(async () => {}),
    pushError: vi.fn(),
    ...over,
  } as FakeCoreDeps
}
