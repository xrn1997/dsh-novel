// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteTarget, WriteMethod } from '../../src/shared/wire.js'
import { BROWSER_TTS_ENGINE_ID, ROUTES } from '../../src/shared/wire.js'
import type * as ApiModule from '../../src/client/api.js'
import { FakeAudio, FakeSpeechSynthesis, FakeUtterance, FakeVoice } from './tts-fakes.js'
import { fakeCtx, fakeHost, fiberCleanupOf } from './fake-host.js'

/**
 * 播放层与**插件生命周期**的边界：常驻播放层跨面板卸载存活（`ADR-0072`），但插件本身
 * 被卸载（客户端热替换 / 停用 / 升级）时，模块级单例与它正在放的 Audio 一起被留在旧模块里——
 * 宿主控制面（听书条 / 浮窗）随槽位注册撤走，声音却还在念。
 *
 * 为什么必须钉这一条：热替换后宿主会重新 import 整份 client bundle，新模块有**第二个**
 * 单例。旧会话不收口，两次「听书」就是两路声音同时念；而且旧会话是幽灵——它的控制面已经
 * 不存在，没人能暂停它，它会一章章念到书末。所以本文件从宿主视角仿真两次页面装载：
 * 装 `apply` → 起播 → 拆掉 fiber（跑完所有 `ctx.effect` 的清理）→ 重新 import 模块 → 再起播。
 *
 * 模块身份是本文件的核心：两次装载必须真的拿到两套模块（`vi.resetModules()` + 动态 import），
 * 否则测的只是同一个单例被调了两次。API 的替身因此在每次装载后重新装一遍——重置模块图会让
 * `vi.mock` 工厂重新执行，旧闭包里的 `apiGet` / `apiSend` 不再是新模块看见的那两个。
 */

vi.mock('../../src/client/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() }
})

/** 一次「页面装载」拿到的半套模块：宿主每次热替换都重建一份，模块级现场随之各有一份。 */
interface PageModules {
  api: typeof ApiModule
  client: typeof import('../../src/client/index.js')
  player: typeof import('../../src/client/tts/player.js')
}

const FIXTURE = {
  names: ['第一章', '第二章'],
  texts: [['第一段。', '第二段。', '第三段。'], ['第二章第一段。']],
}

function configureApi(api: typeof ApiModule): void {
  vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
    if (path.startsWith('navigation')) {
      return { chapters: FIXTURE.names.map((name, i) => ({ name, url: `u${i}` })), items: [] }
    }
    if (path.startsWith('chapter')) {
      const match = /[?&]index=(\d+)/.exec(path)
      const index = match === null ? 0 : Number(match[1])
      return { kind: 'text', text: FIXTURE.texts[index]?.join('\n') ?? '' }
    }
    if (path === ROUTES.shelf.path) return []
    throw new Error(`unexpected GET ${path}`)
  })
  vi.mocked(api.apiSend).mockImplementation(async (target: RouteTarget<WriteMethod>, body?: unknown) => {
    if (target.path === ROUTES.ttsSynthesize.path) {
      const record = (body ?? {}) as { text?: unknown }
      return { key: `k-${String(record.text)}`, mediaType: 'audio/mpeg' }
    }
    if (target.path.startsWith('shelf/')) return {}
    throw new Error(`unexpected ${target.method} ${target.path}`)
  })
}

/** 按宿主的方式装载一份新模块图：先重置，再装替身，再取插件半的模块。 */
async function bootPage(): Promise<PageModules> {
  vi.resetModules()
  const api = await import('../../src/client/api.js')
  configureApi(api)
  const client = await import('../../src/client/index.js')
  const player = await import('../../src/client/tts/player.js')
  return { api, client, player }
}

/** 假宿主 + 一份「fiber 销毁」把手：cordis 的 `ctx.effect` 清理由 fiber 销毁统一跑。 */
function mountPage(page: PageModules): {
  host: ReturnType<typeof fakeHost>
  dispose: () => void
} {
  const host = fakeHost()
  const ctx = fakeCtx(host)
  const dispose = fiberCleanupOf(ctx)
  page.client.apply(ctx as never)
  return { host, dispose }
}

async function microtasks(count = 40): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve()
}

function playingAudio(): FakeAudio[] {
  return FakeAudio.instances.filter((audio) => !audio.paused)
}

function start(page: PageModules): Promise<void> {
  return page.player.startListening({
    sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
  })
}

beforeEach(() => {
  FakeAudio.reset()
  FakeUtterance.reset()
  vi.stubGlobal('Audio', FakeAudio)
  vi.clearAllMocks()
})

afterEach(async () => {
  // 收掉当前这份模块图里可能还在放的那一路，别把声音漏到下一个用例
  const player = await import('../../src/client/tts/player.js')
  player.resetTtsPlayerForTests()
  vi.unstubAllGlobals()
})

describe('播放层随插件生命周期收口（客户端热替换 / 停用）', () => {
  it('拆掉插件 fiber 后旧会话不再出声，也不再替没人听的内容合成（幽灵朗读）', async () => {
    const page = await bootPage()
    const mounted = mountPage(page)
    await start(page)
    await microtasks()

    expect(playingAudio(), '前置：起播后确有一路在放').toHaveLength(1)
    const synthBefore = vi.mocked(page.api.apiSend).mock.calls
      .filter(([target]) => target.path === ROUTES.ttsSynthesize.path).length

    mounted.dispose()
    await microtasks()

    expect(playingAudio(), '插件已卸载，耳朵里不许还有声音').toHaveLength(0)
    expect(page.player.ttsPlayer.get().active, '会话随插件卸载收口').toBe(false)
    const synthAfter = vi.mocked(page.api.apiSend).mock.calls
      .filter(([target]) => target.path === ROUTES.ttsSynthesize.path).length
    expect(synthAfter, '卸载后不再替幽灵会话继续合成').toBe(synthBefore)
  })

  it('热替换后重新点听书：只有新模块那一路出声，旧模块不许同时念（二重奏）', async () => {
    const pageA = await bootPage()
    const mountedA = mountPage(pageA)
    await start(pageA)
    await microtasks()
    expect(playingAudio(), '前置：旧模块起播').toHaveLength(1)

    // 宿主热替换：拆旧 fiber → 旧模块作废 → 重新 import 整份 client bundle
    mountedA.dispose()
    const pageB = await bootPage()
    const mountedB = mountPage(pageB)
    const hearing = pageB.player.ttsPlayer
    await start(pageB)
    await microtasks()

    expect(hearing.get().active, '前置：新模块重新起播').toBe(true)
    expect(playingAudio(), '两路声音同时念——幽灵会话没收口').toHaveLength(1)
    mountedB.dispose()
  })

  it('直出型（浏览器 TTS）同样收口：dispose 撤掉平台队列，热替换后不留没人能停的朗读', async () => {
    // 幽灵朗读的另一半症状面在 direct 分支：收口链是 `releaseAll` → `DirectOutput.release`
    // → `speechSynthesis.cancel()`。字节型的用例只盯 `Audio`，盯不到浏览器语音队列——这里用
    // 假 `speechSynthesis` 把那一半也钉上。
    const speech = new FakeSpeechSynthesis()
    speech.voices = [new FakeVoice('v1', '音色一')]
    vi.stubGlobal('speechSynthesis', speech)
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)

    const pageA = await bootPage()
    const mountedA = mountPage(pageA)
    await pageA.player.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
      engineId: BROWSER_TTS_ENGINE_ID,
    })
    await microtasks()
    expect(speech.spoken, '前置：直出分支已把 utterance 交给平台').toHaveLength(1)
    expect(speech.speaking, '前置：平台队列里有一支在念').toBe(true)
    const cancelsBeforeDispose = speech.cancelCount

    mountedA.dispose()
    await microtasks()
    expect(speech.speaking, '旧 utterance 不许继续念').toBe(false)
    // 停声与放介质是两步：只把读数写成「不在放」的收口会少撤一次队。撤队次数因此是
    // 「releaseAll 真的跑了」的可观察面（只由 `stopListening` 停声时这里只会有 1 次）。
    expect(speech.cancelCount - cancelsBeforeDispose, 'dispose 要撤平台队列：停声一次、放介质再一次')
      .toBeGreaterThanOrEqual(2)

    // 宿主热替换：重新 import 整份 client bundle，新模块再起播
    const pageB = await bootPage()
    const mountedB = mountPage(pageB)
    expect(speech.speaking, '热替换重启后平台队列是干净的：没有旧模块的幽灵朗读').toBe(false)
    await pageB.player.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
      engineId: BROWSER_TTS_ENGINE_ID,
    })
    await microtasks()
    expect(speech.spoken, '只有新模块那一支开口').toHaveLength(2)
    expect(speech.speaking, '在念的是新模块那一支').toBe(true)

    mountedB.dispose()
    expect(speech.speaking, '新模块收口后同样不留朗读').toBe(false)
  })

  it('卸载瞬间的位置写失败不阻断收口：声音照停、会话照收（ADR-0092 边界）', async () => {
    const page = await bootPage()
    const mounted = mountPage(page)
    await start(page)
    await microtasks()
    expect(playingAudio(), '前置：起播后确有一路在放').toHaveLength(1)

    // 收口会 flush 最后一笔位置；这里让那次写失败，验证它不是收口的前置条件。
    vi.mocked(page.api.apiSend).mockImplementation(async (target: RouteTarget<WriteMethod>) => {
      if (target.path === ROUTES.ttsSynthesize.path) return { key: 'k', mediaType: 'audio/mpeg' }
      if (target.path.startsWith('shelf/')) throw new Error('位置写不出去')
      throw new Error(`unexpected ${target.method} ${target.path}`)
    })

    mounted.dispose()
    await microtasks()

    expect(playingAudio(), '位置写失败不阻断收口：声音照样停').toHaveLength(0)
    expect(page.player.ttsPlayer.get().active, '读数照样收口').toBe(false)
  })
})