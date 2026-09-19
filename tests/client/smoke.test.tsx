import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { NovelView } from '../../src/client/views/NovelView.js'
import { SettingsSection } from '../../src/client/views/SettingsSection.js'
import { ImportPane } from '../../src/client/views/SettingsImportPane.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { routeStore } from '../../src/client/store.js'

describe('NovelView smoke（renderToString 不炸——数据获取在 effect，smoke 只锁渲染分支）', () => {
  it.each([
    ['shelf', { name: 'shelf' }],
    ['city', { name: 'city' }],
    ['sources', { name: 'sources' }],
    ['reader', { name: 'reader', sourceId: 's', bookKey: 'k', title: 'T' }],
    ['search', { name: 'search' }],
  ])('route=%s 可渲染', (_n, route) => {
    routeStore.set({ route: route as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel')             // 根容器标记
  })
  it('首页 = 顶部搜索 + 封面网格（书架 tab）', () => {
    routeStore.set({ route: { name: 'shelf' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-view="shelf"')
    expect(html).toContain('placeholder="搜书名 / 作者"')   // 书架搜索框
  })
  it('书城 tab = 占位空态（CityView，内容未上线）', () => {
    routeStore.set({ route: { name: 'city' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-view="city"')
    expect(html).toContain('书城未上线')
  })
  it('导入弹层：内容子面（ImportPane）自带拖放主入口 + 粘贴折叠区；壳层默认不挂载弹层', () => {
    const paneHtml = renderToString(createElement(ImportPane, {
      job: null, refresh: () => {}, unverifiedCount: 0, onVerifyUnverified: () => {},
    }))
    expect(paneHtml).toContain('data-novel-dropzone')                // 拖放区是主入口
    expect(paneHtml).toContain('选择或拖入 legado 书源文件')
    expect(paneHtml).toContain('粘贴 legado 书源')                   // 粘贴降级折叠区仍在
    expect(paneHtml).not.toContain('data-novel-run-card')            // 无任务不渲染运行卡
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('data-novel-import-open')                 // 弹层触发钮在列表头
    expect(html).not.toContain('data-novel-dropzone')                // 弹层默认关闭（低频任务不常驻占版面）
    expect(html).not.toContain('data-novel-status-bar')              // 空闲零占用：无条目时全局状态条整体不渲染
  })
  it('§5.4 风格统一：原生 file input 隐藏（拖放区点击触发，不裸露原生控件）', () => {
    const paneHtml = renderToString(createElement(ImportPane, {
      job: null, refresh: () => {}, unverifiedCount: 0, onVerifyUnverified: () => {},
    }))
    expect(paneHtml).toContain('type="file"')
    expect(NOVEL_CSS).toMatch(/\.novel-file-hidden\s*\{[^}]*display:\s*none/)   // 隐藏规则住样式层
  })
  it('源列表：状态下拉 + 浏览态纯浏览（复选框/危险区不渲染）；待办箱数据未到不渲染', () => {
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('data-novel-source-list')
    expect(html).toContain('data-novel-source-filter')
    expect(html).toContain('data-novel-group-filter')            // 分组下拉过滤
    expect(html).toContain('data-novel-status-filter')           // 状态 chips → 下拉（2026 改版）
    expect(html).not.toContain('data-novel-chip=')               // 状态 chips 退役（读数归待办箱）
    expect(html).toContain('data-novel-edit-toggle')             // 「编辑」显式切换
    expect(html).not.toContain('type="checkbox"')                // 浏览态无复选框
    expect(html).not.toContain('危险操作（整库级）')              // 危险区退役：删除=统一模态二次确认
    expect(html).not.toContain('data-novel-inbox')               // sources 未加载：待办不渲染（不拿未知当「全部良好」）
    expect(html).not.toContain('data-novel-section-toggle')      // 手风琴退役（sections.ts 已删）
  })
  it('IA：列表级操作在表格之前——长列表下表格之下摸不着（2026 改版：操作收进列表头）', () => {
    const html = renderToString(createElement(SettingsSection))
    const atTable = html.indexOf('class="novel-table"')
    expect(atTable).toBeGreaterThan(-1)
    expect(html.indexOf('data-novel-source-filter')).toBeLessThan(atTable)   // 过滤工具在表前
    expect(html.indexOf('data-novel-import-open')).toBeLessThan(atTable)     // 导入入口在表前
  })
  it('设置「小说」区块自带样式层（挂载点无关的自足性：组件在哪棵树渲染 novel-* 类都不裸奔）', () => {
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('data-novel-style')
    expect(html).toContain('.novel-btn')
  })
  it('状态条不吃布局（闪烁修复）：条身 absolute、锚是铺满视口的常驻层（默认 click-through）', () => {
    // 病因：状态条曾以流内元素挂在区块首，一次启停就把整块顶下去 35px 再弹回（真机逐帧实测）
    expect(NOVEL_CSS).toMatch(/\.novel-status-bar\s*\{[^}]*position:\s*absolute/)
    expect(NOVEL_CSS).toMatch(/\.novel-shell-status\s*\{[^}]*pointer-events:\s*none/)
    expect(NOVEL_CSS).toMatch(/\.novel-shell-status \.novel-status-bar\s*\{[^}]*pointer-events:\s*auto/)
  })
  it('样式层注入：渲染含 <style data-novel-style> 与基础类', () => {
    routeStore.set({ route: { name: 'shelf' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-style')
    expect(html).toContain('.novel-btn')
  })
  it('样式层恰一条：书源管理 tab 不再同树注两遍（SettingsSection 单飞时仍自带）', () => {
    const count = (s: string): number => (s.match(/data-novel-style/g) ?? []).length
    routeStore.set({ route: { name: 'sources' } as any })
    expect(count(renderToString(createElement(NovelView)))).toBe(1)   // 宿主根注入，子组件让位
    routeStore.set({ route: { name: 'shelf' } as any })
    expect(count(renderToString(createElement(NovelView)))).toBe(1)
    expect(count(renderToString(createElement(SettingsSection)))).toBe(1)  // 离开宿主仍自足
  })
  it('布局修复：根容器是 flex 列布局（视图区 flex:1——此前被 height:100% 挤出视口）', () => {
    routeStore.set({ route: { name: 'shelf' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-root')
    expect(html).toContain('data-novel-main')
    const css = html.slice(html.indexOf('data-novel-style'))
    expect(css).toContain('.novel-root')                  // 样式串含 flex 列定义
    expect(css).toContain('flex-direction: column')
  })
  it('阅读器：正文承载在宿主 scrollport 上——根容器带 data-novel-view 标记（sticky 工具栏的 :has 钩子）', () => {
    routeStore.set({ route: { name: 'reader', sourceId: 's', bookKey: 'k', title: 'T' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-view="reader"')
    expect(html).toContain('.novel-root:has(')             // 该视图下放开祖先 overflow，否则 sticky 落在自己身上
    expect(html).toContain('.novel-main:has(')
  })
  it('阅读器：未载章节不进 DOM（旧实现渲染 912 个占位块 → scrollHeight 被撑成整本书高，预取判据失效）', () => {
    routeStore.set({ route: { name: 'reader', sourceId: 's', bookKey: 'k', title: 'T' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('目录加载中…')                    // 目录未到：不渲染任何章块，也不渲染哨兵
    expect(html).not.toContain('data-chapter=')
    expect(html).not.toContain('data-novel-sentinel')
  })
  it('小说视图收掉宿主常驻 composer（AI 输入框）——只藏默认层，接管层（提问/审批）仍在', () => {
    // 直接断言样式串本身：renderToString 会把文本节点里的 " 转义成 &quot;，选择器断言走原串更可靠
    expect(NOVEL_CSS).toContain('[data-conversation-scroll]:has([data-novel-root]) [data-chain-overlay-fallback="conversation.composer"]')
    expect(NOVEL_CSS).toContain('display: none !important')  // 盖 inline display:contents；不整座藏（否则吞掉提问/审批接管）
    expect(NOVEL_CSS).not.toContain('[data-composer-seat] { display: none')
    routeStore.set({ route: { name: 'reader', sourceId: 's', bookKey: 'k', title: 'T' } as any })
    expect(renderToString(createElement(NovelView))).toContain('data-novel-style')   // 样式层确实随视图注入
  })
  it('小说视图收掉配套的列宽拖拽把手（data-width-handle，调 AI 输入框宽度那条）——兄弟选择器，不误伤对话视图', () => {
    expect(NOVEL_CSS).toContain('[data-conversation-scroll]:has([data-novel-root]) ~ [data-width-handle]')
    expect(NOVEL_CSS).toContain('~ [data-width-handle] { display: none; }')   // 兄弟（~）而非后代：chat 视图的把手照旧
    expect(NOVEL_CSS).not.toContain(']) [data-width-handle]')             // 不是后代选择器：chat 视图的把手照旧可见可拖
  })
  it('tab 栏已退役', () => {
    routeStore.set({ route: { name: 'shelf' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).not.toContain('data-novel="tabbar"')
  })
  it('搜索面渲染进度容器（分批进度条常驻）', () => {
    routeStore.set({ route: { name: 'search' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-search-progress')
  })
  it('未知 route 兜底 shelf', () => {
    routeStore.set({ route: { name: 'nonexistent' } as any })
    expect(renderToString(createElement(NovelView))).toContain('data-novel-view="shelf"')
  })
})
