# 翻页阅读用 CSS 多栏切页，窄屏单页宽屏双页，不复制正文 DOM

Status: accepted

连续滚动在宽屏上留白多、长章容易失去「一本书」的节奏；翻页阅读要按舞台实际宽高切页，同时不复制正文 DOM、不把滚动会话的锚点与回补时序硬套进来。决定：**用浏览器原生 CSS 多栏轨道切页**，宽屏双页、窄屏单页；阅读会话为翻页模式开一条无 `pendingJump`、无滚动回补的路径，进度按实际页位上报，切回滚动时按页内比例投影回 `scrollTop`。

## 决定

1. **几何**：舞台可用宽 ≥ 860px 时双页对开，否则单页。每栏宽按 `measure`（em）× 字号算，栏间距单页 32px、双页 64px；轨道固定页高、`column-fill: auto`，总栏数由 `scrollWidth` 推算，总屏数按每屏栏数向上取整。翻页位移 = 屏号 × 每屏步进。
2. **切页单位是整章**：整章正文一次进多栏轨道，靠 `overflow: hidden` 的裁剪盒只露当前屏，不对正文做分页复制或逐页懒加载。图片沿用正文层的可信宽高占位框；标题与插图 `break-after/inside: avoid`，正文段落留 `orphans/widows`。
3. **交互**：点击左/右 30% 翻页，中间 40% 留给选词、内链与注释；`←`/`→`、PageUp/PageDown、Space、滚轮与触摸横向滑动也能翻。键盘在阅读浮层（偏好、目录、导出、注释、离开一问）打开时让出；点击与滚轮不因浮层打开而改判（浮层本身盖住页面）。
4. **动效**：拟真翻书、顺滑平移、极速直切三种纯 CSS 动效，零正文 DOM 复制；`prefers-reduced-motion` 下直接切页。翻书层与扫影只是 `aria-hidden` 的临时覆盖层，不改正文树。
5. **会话另开 paged 路径**：翻页模式没有滚动视口，也没有 `binding.rendered` 的拍点；`requestJump` / `reveal` 只写章号与载章，不挂 `pendingJump` / `pendingReveal`，`cancelJump` 不清算滚动锚点。翻页模式关掉滚动回补；载章失败只清在途槽，不拿旧锚点重记位置。
6. **进度按页位**：页内翻动经 `reportPosition` 走原有 commit / 防抖落盘；跨章落位（起点/末页）由 `BookStage` 在测量完成后补报实际页位比例——回翻在末页时不能把存档留在章首。切回滚动前按该比例摆好 `scrollTop`，再让绑定喂首帧。
7. **预取静默**：翻页模式在章正文到位后预取下一章，复用单在途槽与失败闸；预取失败不写全局错误条、不占错误现场，也不触发挥滚回补。
8. **页脚**：页码按「栏」计（双页显示区间），上一页/下一页按钮到章界时跨章；书末/书首禁用。

## 边界

- 翻页模式只负责章级导航；章内锚点与段级返回不声称精确落位：同章目标保持当前页，跨章目标落章首。需要精确锚点时用滚动模式。
- 不接固定版式、PDF、漫画或需脚本交互的页面；流式 EPUB 的图文正文可读，图片占位框不因加载完成收缩。
- 滚动模式的锚点、回补、拍点与 `pendingJump` 结算不变；翻页模式不去改这些语义。
- `ADR-0084` 的「往回翻页不做」约束滚动会话的已载窗口与补载；翻页路径的上一章落末页走 `requestJump` 的单章跳转，不建双向滚动窗口，不构成对它的取代。
- 听书播放层仍归播放层；翻页模式只消费段号/章号，不写播放状态。用户主动翻页按滚动模式的接管口径让跟随让位（点「定位」恢复）；播放自然推进仍自动翻页 / 切章。

## 被否方案

- **按页复制正文 DOM**：长章会复制大量节点，翻页动画与文本选择都变复杂，且页码与真实正文树脱节；零复制是纯 CSS 方案的主要收益。
- **JS 逐段测量分页**：要自己处理断行、行高、图片与标点，结果随字体/缩放漂移；浏览器原生多栏已经给出稳定切页。
- **让翻页模式复用滚动会话的 `pendingJump` / `settleJump`**：翻页没有滚动视口与 `afterRender` 拍点，`pendingJump` 永不结算，页内翻页还会触发 `cancelJump` 按旧锚点重记；必须另开 paged 路径。
- **翻页模式逐页懒加载正文**：页码与总页数要先知道整章布局；懒加载会让总屏数随时变化，末页与跨章落位都不稳定。

## 后果

- 整章必须在 DOM 里完成多栏排版：长章首次进入的布局成本高于滚动模式；页数依赖实测，字体、字号、行距、窗口尺寸变化都会重排并按页内比例重新站定。
- 翻页模式没有滚动锚点，章内锚点精度受限；这是接受的边界，精确锚点仍走滚动模式。
- 进度口径增加一条「页位比例」：它复用 `progress.offsetRatio`，切模式时是近似换算，不是文本比例；两端各自重排时可能有半个屏的误差。
- 守护落在分页几何单测、`BookStage` 组件与真浏览器几何、ReaderView 翻页接线与跨章进度回归上。

锚点：`src/client/reader-pagination.ts` 的 `computeSpreadLayout` / `computePageCount` / `spreadForRatio` / `ratioForSpread` / `classifyClickZone` / `firstParagraphInSpread`；`src/client/views/BookStage.tsx`；`src/client/views/ReaderView.tsx` 的 `isPaged` / `takeOverReading`；`src/client/reader-session.ts` 的 `setPaged` / `reportPosition` / `prefetchChapter` / `scrollToSavedPosition`；`src/client/styles/reader.ts` 的 `.novel-book-stage` / `.novel-book-track`；`tests/client/reader-pagination.test.ts`；`tests/client/book-stage.test.tsx`；`tests/client/reader-session.test.ts`；`tests/client/wiring-reader.test.tsx`；`docs/ui-spec.md` §3.5。
