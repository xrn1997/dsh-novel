import { describe, expect, it } from 'vitest'
import { ReaderSession } from '../../src/client/reader-session.js'
import type { ReaderPort, ReaderSessionDeps, VisibleNode } from '../../src/client/reader-session.js'
import type { ChapterAnchor } from '../../src/client/progress.js'
import type { ChapterContent, ChapterEntry, NavigationItem } from '../../src/client/views/types.js'

/**
 * EPUB 图文阅读流：图文正文进已载表、目录树高亮、正文内链的返回栈、补充文档不碰主进度。
 *
 * 与 `reader-session.test.ts` 的分工：那份钉「时序不变量」（在途槽/防抖/代际），用文字章当载荷；
 * 这份钉**图文载荷与锚点**——rich 树的节点 ID 就是 `targetOffset` 的查表键、目录树的多个条目
 * 可以指向同一章的不同锚点。载荷形态对会话是透明的（它只搬 ChapterContent），所以这里不重复加载算法。
 */

const chapters: ChapterEntry[] = [
  { name: '第一章', url: 'local:c/0' },
  { name: '第二章', url: 'local:c/1' },
  { name: '第三章', url: 'local:c/2' },
]
const rich0: ChapterContent = {
  kind: 'rich', documentId: 'd0', nodes: [
    { kind: 'element', id: 'p7', tag: 'p', children: [{ kind: 'text', text: '第一段' }], rowSpan: null, colSpan: null, start: null, value: null },
    { kind: 'image', id: 'i1', resourceId: 'r1', alt: '插图', width: 40, height: 30 },
  ],
}
const rich1: ChapterContent = {
  kind: 'rich', documentId: 'd1', nodes: [
    { kind: 'element', id: 'q1', tag: 'p', children: [{ kind: 'text', text: '第二章正文' }], rowSpan: null, colSpan: null, start: null, value: null },
  ],
}
const rich2: ChapterContent = {
  kind: 'rich', documentId: 'd2', nodes: [
    { kind: 'element', id: 's1', tag: 'p', children: [{ kind: 'text', text: '第三章正文' }], rowSpan: null, colSpan: null, start: null, value: null },
  ],
}
const docOf = (i: number): ChapterContent => (i === 0 ? rich0 : i === 1 ? rich1 : rich2)

const nav: NavigationItem[] = [
  {
    id: 'g1',
    label: '第一卷',
    target: null,
    children: [
      { id: 'n0', label: '第一章', target: { kind: 'chapter', index: 0, anchorId: null }, children: [] },
      { id: 'n1', label: '第一节', target: { kind: 'chapter', index: 0, anchorId: 'a1' }, children: [] },
      { id: 'n2', label: '第二节', target: { kind: 'chapter', index: 0, anchorId: 'a2' }, children: [] },
      { id: 'n3', label: '第二章', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
      { id: 'n4', label: '第三章', target: { kind: 'chapter', index: 2, anchorId: null }, children: [] },
    ],
  },
]

/** 可编程假 port（与 reader-session.test 同款，只留本文件要用的旋钮） */
function fakePort() {
  const port = {
    anchors: [] as ChapterAnchor[],
    top: 0,
    chapterOff: null as number | null,
    targetOffs: new Map<string, number>(),
    node: null as VisibleNode | null,
    tops: [] as number[],
    measureAnchors: (): ChapterAnchor[] => port.anchors,
    scrollTop: (): number => port.top,
    setScrollTop: (px: number): void => { port.top = px; port.tops.push(px) },
    viewHeight: (): number => 1000,
    scrollHeight: (): number => 5000,
    sentinelOffset: (): number | null => null,
    targetOffset: (_i: number, anchorId: string | null): number | null =>
      (anchorId === null ? port.chapterOff : (port.targetOffs.get(anchorId) ?? null)),
    currentNode: (): VisibleNode | null => port.node,
  }
  return port
}

function makeHarness(opts?: { navigation?: NavigationItem[] }): {
  session: ReaderSession
  port: ReturnType<typeof fakePort>
  fetched: number[]
  saves: Array<[number, number]>
} {
  const port = fakePort()
  const fetched: number[] = []
  const saves: Array<[number, number]> = []
  const deps: ReaderSessionDeps = {
    fetchNavigation: async () => ({ chapters, items: opts?.navigation ?? nav }),
    fetchChapter: async (_s, _b, i) => {
      fetched.push(i)
      return docOf(i)
    },
    fetchShelf: async () => [],
    saveProgress: (i, r) => { saves.push([i, r]) },
    saveTotalChapters: () => {},
    afterFrames: (cb) => cb(),
  }
  return { session: new ReaderSession(deps, port, 5), port, fetched, saves }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('图文载荷（rich 树进已载表，节点 ID 就是锚点查表键）', () => {
  it('rich 章原样进已载表（会话不转文本、不拆节点）', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    expect(h.session.state.chapters[0]).toEqual(rich0)
    expect(h.session.state.navigation).toEqual(nav)
    expect(h.session.state.toc).toEqual(chapters)          // 线性序列仍按阅读单元
  })
})

describe('目录高亮：当前章内最近的已登记导航锚点', () => {
  it('同章两个锚点：视口停在第一节内 → 高亮第一节；越过第二节 → 高亮第二节', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.targetOffs.set('a1', -200)                      // 视口顶已越过 a1 200px
    h.port.targetOffs.set('a2', 400)                       // a2 还在视口之下
    expect(h.session.activeNavId()).toBe('n1')

    h.port.targetOffs.set('a2', -50)                       // 继续滚：a2 也越过了
    expect(h.session.activeNavId()).toBe('n2')             // 取最近的一个（-50 比 -200 近）
  })

  it('导航顺序 ≠ 文档顺序时，下方候选取「最小正偏移」而不是导航序第一条', async () => {
    // 目录允许把靠后的节排在前面（EPUB nav 就是这个形态）。一个锚点都没越过时，
    // 「下一个要读到的锚点」是文档里离视口最近的那个，不是列表里第一条——取后者会在
    // 视口明明停在第二节头上时把高亮打到第四节。
    const items: NavigationItem[] = [{
      id: 'g1',
      label: '卷',
      target: null,
      children: [
        { id: 'far', label: '第四节', target: { kind: 'chapter', index: 0, anchorId: 'a2' }, children: [] },
        { id: 'near', label: '第二节', target: { kind: 'chapter', index: 0, anchorId: 'a1' }, children: [] },
      ],
    }]
    const h = makeHarness({ navigation: items })
    await h.session.open('local:b1', 'local:b1')
    h.port.targetOffs.set('a1', 120)                       // 文档里更靠前、也离视口更近
    h.port.targetOffs.set('a2', 900)
    expect(h.session.activeNavId()).toBe('near')
  })

  it('视口在章首条目之后、第一个锚点之前 → 高亮章首条目（不落成「无当前项」）', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.chapterOff = -3000                              // 章块顶已在视口之上（正常形态）
    h.port.targetOffs.set('a1', 120)                       // 第一个锚点还在视口之下
    h.port.targetOffs.set('a2', 900)
    expect(h.session.activeNavId()).toBe('n0')             // 章首条目就是「当前所在的最近锚点」

    h.port.chapterOff = 200                                // 整章还在视口下方（视口在上一章尾部）
    // 章块顶是本章**最靠上**的可定位点，所以它的偏移必然 ≤ 章内任何锚点——假 port 也要守这条，
    // 否则测的是「取导航序第一条」而不是「取文档序最近的那个」（下方候选现在按最小正偏移取）。
    h.port.targetOffs.set('a1', 900)
    h.port.targetOffs.set('a2', 1400)
    expect(h.session.activeNavId()).toBe('n0')             // 一个都没越过 → 取章首那条，不是 null
  })

  it('多个条目指向同一目标 → 按导航顺序取第一条（不产生第二个 aria-current）', async () => {
    const dup: NavigationItem[] = [
      {
        id: 'g1', label: '卷', target: null,
        children: [
          { id: 'n1', label: '第一节', target: { kind: 'chapter', index: 0, anchorId: 'a1' }, children: [] },
          { id: 'n1b', label: '第一节（重复目标）', target: { kind: 'chapter', index: 0, anchorId: 'a1' }, children: [] },
        ],
      },
    ]
    const h = makeHarness({ navigation: dup })
    await h.session.open('local:b1', 'local:b1')
    h.port.targetOffs.set('a1', -10)
    expect(h.session.activeNavId()).toBe('n1')
  })

  it('本章没有已登记锚点 / 节点都没挂载 → null（视图不打 aria-current）', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.chapterOff = null                               // 章块不在 DOM（视口章在途）
    expect(h.session.activeNavId()).toBeNull()
  })

  it('其它章的条目不是候选：当前章只在本章的锚点里选', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.targetOffs.set('a1', -10)                       // 第 1 章的锚点还在表里（旧章被裁前）
    h.session.requestJump('local:b1', 1)                   // 视口落到第 2 章
    await tick()
    h.port.chapterOff = -500
    h.session.settleJump()
    expect(h.session.activeNavId()).toBe('n3')             // 第 2 章自己的章首条目（不是第 1 章的 n1）
  })
})

describe('正文内链的返回栈（窗口内状态，绝不落盘）', () => {
  it('内链跳走前采点（章+节点+节点内偏移）；返回时重新加载被裁掉的来源章并回到原处', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.anchors = [{ index: 0, start: 0, height: 2000 }]
    h.port.node = { index: 0, nodeId: 'p7', offsetWithinNode: 64 }   // 视口顶在 p7 内 64px 处

    h.session.followLink('local:b1', { kind: 'chapter', index: 2, anchorId: null }, 'normal')
    expect(h.session.state.returnDepth).toBe(1)
    expect(h.session.state.pendingJump).toMatchObject({ index: 2, anchorId: null })
    h.port.chapterOff = 500
    await tick()                                                     // 第 3 章到货（窗口随之裁到视口章）
    h.session.settleJump()
    expect(h.port.top).toBe(500)
    expect(h.session.state.chapters[0]).toBeNull()                   // 与视口章不相邻：来源章被裁掉

    h.session.goBack('local:b1')
    expect(h.session.state.returnDepth).toBe(0)
    expect(h.session.state.pendingJump).toMatchObject({ index: 0, anchorId: 'p7', offsetWithinNode: 64 })
    await tick()                                                     // 同一单在途加载路径补回来源章
    expect(h.session.state.chapters[0]).toEqual(rich0)
    h.port.targetOffs.set('p7', 300)                                 // 节点此刻在视口下 300px
    h.session.settleJump()
    expect(h.port.top).toBe(500 + 300 + 64)                          // 回到「节点顶在视口顶上方 64px」
    expect(h.saves.at(-1)?.[0]).toBe(0)                              // 位置提交仍归会话
    expect(h.saves.at(-1)?.[1]).toBeCloseTo((500 + 300 + 64) / 2000)
  })

  it('返回链接（backlink）是返回动作本身：不压栈，并消费掉栈里那条', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.node = { index: 0, nodeId: 'p7', offsetWithinNode: 0 }
    h.session.followLink('local:b1', { kind: 'chapter', index: 1, anchorId: null }, 'normal')
    expect(h.session.state.returnDepth).toBe(1)

    h.port.node = { index: 1, nodeId: 'q1', offsetWithinNode: 8 }
    h.session.followLink('local:b1', { kind: 'chapter', index: 0, anchorId: 'a1' }, 'backlink')
    expect(h.session.state.returnDepth).toBe(0)                      // 旧实现：返回动作又压了一条
    expect(h.session.state.pendingJump).toMatchObject({ index: 0, anchorId: 'a1' })
  })

  it('无返回项可弹时 goBack 是空操作（不造幽灵落位、不写进度）', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.session.goBack('local:b1')
    expect(h.port.tops).toEqual([])
    expect(h.saves).toEqual([])
    expect(h.session.state.pendingJump).toBeNull()
  })

  it('面板里再点主序列链接：同一处不重复压返回项（返回栈不因同一次落点长两层）', async () => {
    // 脚注引用开面板 + 面板里的「见第 N 章」问的是同一个位置：视口顶没动过。
    // 压两份只会让工具栏多一次「返回原处」（点它回到原地，像什么都没发生）。
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.node = { index: 0, nodeId: 'p7', offsetWithinNode: 64 }
    h.session.followLink('local:b1', { kind: 'supplement', documentId: 'd9', anchorId: 'f1' }, 'noteref')
    expect(h.session.state.returnDepth).toBe(1)

    h.session.followLink('local:b1', { kind: 'chapter', index: 1, anchorId: null }, 'normal')   // 面板里点到主序列
    expect(h.session.state.returnDepth).toBe(1)                       // 旧实现：2（同一处的第二份抄本）
  })

  it('关闭面板只消费「开面板时压入的那一条」：栈顶已换人时只关面板，不动主序列', async () => {
    // 实测路径：跟正文链 → 在新章点脚注引用 → 点工具栏「返回原处」→ 关面板。
    // 关闭若按「面板是内链开的」这个标志弹栈，弹掉的是**更早那条**（别人记的原处），
    // 于是关闭面板真的把主序列带回用户没点过的章，并把这一跳写进存档。
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.anchors = [{ index: 0, start: 0, height: 2000 }]
    h.port.node = { index: 0, nodeId: 'p7', offsetWithinNode: 64 }
    h.session.followLink('local:b1', { kind: 'chapter', index: 2, anchorId: null }, 'normal')     // ① 押下 E1
    await tick()                                                     // 第 3 章到货
    expect(h.session.state.returnDepth).toBe(1)

    h.port.node = { index: 2, nodeId: 's1', offsetWithinNode: 12 }
    const entry = h.session.followLink('local:b1', { kind: 'supplement', documentId: 'd9', anchorId: 'f1' }, 'noteref')
    expect(h.session.state.returnDepth).toBe(2)                      // ② 面板打开时压入 E2

    h.session.goBack('local:b1')                                     // ③ 工具栏返回：消费 E2（面板还开着）
    expect(h.session.state.returnDepth).toBe(1)
    h.port.targetOffs.set('s1', 100)
    h.session.settleJump()                                           // 落回引用节点，落位收口
    expect(h.session.state.pendingJump).toBeNull()

    const saves = [...h.saves]
    h.session.closeSupplement('local:b1', entry)                     // ④ 关面板：栈顶已是 E1（别人的原处）
    expect(h.session.state.pendingJump).toBeNull()                   // 旧实现：指向第 1 章（真的跳了）
    expect(h.saves).toEqual(saves)                                   // 旧实现：多一笔 [0, …]（写进存档）
    expect(h.session.state.returnDepth).toBe(1)
  })
})

describe('补充文档（脚注/附录）不碰主阅读进度', () => {
  it('目标落在补充文档：不跳章、不落位、不写进度，但仍采点（面板里再点主序列要有原处可回）', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.node = { index: 0, nodeId: 'p7', offsetWithinNode: 64 }
    const entry = h.session.followLink('local:b1', { kind: 'supplement', documentId: 'd9', anchorId: 'f1' }, 'noteref')
    expect(h.session.state.pendingJump).toBeNull()           // 面板是浮层：主序列位置一动不动
    expect(h.port.tops).toEqual([])
    expect(h.saves).toEqual([])
    expect(h.session.state.returnDepth).toBe(1)              // 引用处已采点（关闭面板即回这里）

    h.session.closeSupplement('local:b1', entry)             // 关闭面板 = 回引用处（栈顶仍是那一条 → 消费它）
    expect(h.session.state.returnDepth).toBe(0)
    h.port.targetOffs.set('p7', 300)
    h.session.settleJump()
    expect(h.port.top).toBe(300 + 64)                        // 落回「节点顶在视口顶上方 64px」
  })

  it('目录直接打开的补充文档：没有引用处 → 关面板不消费任何返回项', async () => {
    const h = makeHarness()
    await h.session.open('local:b1', 'local:b1')
    h.port.node = { index: 0, nodeId: 'p7', offsetWithinNode: 64 }
    h.session.followLink('local:b1', { kind: 'chapter', index: 1, anchorId: null }, 'normal')   // 先垫一条别人的原处
    await tick()
    expect(h.session.state.returnDepth).toBe(1)
    h.session.closeSupplement('local:b1', null)              // 目录路径：视图没有「开面板时压入的那条」
    expect(h.session.state.returnDepth).toBe(1)
    expect(h.session.state.pendingJump).toMatchObject({ index: 1, anchorId: null })   // 第 0 条的原处还在
  })
})
