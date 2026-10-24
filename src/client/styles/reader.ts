/** 阅读器块（`NOVEL_CSS` 的第 6 块）：控制器条、正文列、目录抽屉、Aa 面板，以及 EPUB
 *  三组件（图文正文 / 目录树 / 注释面板）的规则。 */
export const READER_CSS = `
/* ── 阅读器：控制器条/正文列/目录抽屉/Aa 面板（z 序仍归 CTRL_Z 常量，布局归样式类）── */
/* 纸面 full-bleed：**纸张色涂满整个阅读区**（值槽 --novel-paper 由 ReaderView 行内写在阅读区根上），
   正文列只决定「文字排到哪儿为止」。旧做法把纸色涂在 .novel-rdr-body 上，宽屏下就是一张
   680px 的窄带飘在宿主底色里（实测 1500px 视口左右各漏底 410px）——那不是留白，是纸没铺开。
   min-height 一屏：正文短于一屏时纸面也要铺满，不许下面漏底色。 */
.novel-rdr { position: relative; display: flex; flex-direction: column; min-height: 100vh; }
/* 控制器条**跟纸走，不跟宿主 chrome 走**：条底 = 纸往墨压一档，整屏读作「一张纸的顶部折了一道」。
   旧做法条底读 --novel-bg（宿主 App 底色），与用户自选纸色毫无关系——实测接缝对比度 15.51:1，
   而黑白极限才 21:1，那是「两块板拼起来」而不是「一页纸」。判据到这句就闭合：条底与纸底不同源，
   接缝就是可量的缺陷，不需要拿别的产品的做法来背书（那种断言在盘上回查不到）。
   条上的深浅一律 inherit + opacity 分主次——这样「控制器层跟随深色」只需重钉条根一个 color，
   不必给每一档灰度各写一条覆盖。 */
.novel-rdr-bar {
  display: flex; gap: var(--novel-sp-2); align-items: center; min-height: 40px;
  padding: var(--novel-sp-1) var(--novel-sp-4);
  background: color-mix(in srgb, var(--novel-paper-ink) 6%, var(--novel-paper));
  border-bottom: 1px solid color-mix(in srgb, var(--novel-paper-ink) 12%, transparent);
  color: var(--novel-paper-ink);
}
/* 「控制器层跟随深色」在条上仍是完整的一档：勾上即整条让回宿主暗底，纸色派生那一套整体作废。
   复合选择器不是冗余——.novel-dark 与 .novel-rdr-bar 同特异度，靠文件次序决胜太脆。 */
.novel-rdr-bar.novel-dark {
  background: var(--novel-bg); color: var(--novel-text);
  border-bottom-color: var(--novel-border);
}
/* 读数：当前章在**主位**（这一屏唯一在变的量），书名退副位——书名刚在书架上点过，在条上是冗余；
   总章数由「N / M」的分母承担，不再单独占一句「共 M 章」。 */
.novel-rdr-title {
  flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--novel-sp-2);
  font-size: var(--novel-fs-md); overflow: hidden;
}
.novel-rdr-chap { min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-rdr-pos, .novel-rdr-book { flex: none; font-size: var(--novel-fs-xs); opacity: .62; white-space: nowrap; }
.novel-rdr-pos { font-variant-numeric: tabular-nums; }
.novel-rdr-book { max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
/* 返回入口与读数之间的发丝：把「去哪」和「在哪」分成两组，比一排同权重方框好扫读 */
.novel-rdr-sep { width: 1px; height: 14px; flex: none; background: currentColor; opacity: .25; }
/* 条上控件：去框的一档 pill。文案一字不动（歧义出在形状语言那一层，就在那一层修），字形换成与汉字
   同源的 SVG——stroke: currentColor 跟着条的 color 走，深浅两态不必各写一份。
   代价如实记着：pill 的内边距比描边钮大，钮组实测比现状宽 46px。 */
.novel-rdr-ctl {
  font: inherit; font-size: var(--novel-fs-sm); padding: var(--novel-sp-1) var(--novel-sp-3);
  border: none; border-radius: 999px; background: none; cursor: pointer; color: inherit; opacity: .8;
  display: inline-flex; align-items: center; gap: var(--novel-sp-1); white-space: nowrap;
  transition: background var(--novel-dur) var(--novel-ease), opacity var(--novel-dur) var(--novel-ease);
}
.novel-rdr-ctl:hover { background: color-mix(in srgb, currentColor 10%, transparent); opacity: 1; }
.novel-rdr-ctl svg { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
/* 章进度：墨色凹槽（底槽 + 实心），不再是压在纸上的第三条外来横带。brand 蓝在控制器层只留给
   选中态（Aa 面板的 .on），条下沿这一道归纸。跨章才变——低频量，故不进每帧读数的滚动路径。
   实心走 ::after：轨道本体留着承载行内写入的 --novel-pct（浏览器台按它读「读到第几章」）。 */
.novel-rdr-trail {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  background: color-mix(in srgb, var(--novel-paper-ink) 9%, transparent);
}
.novel-rdr-trail::after {
  content: ''; display: block; width: 100%; height: 100%;
  background: color-mix(in srgb, var(--novel-paper-ink) 42%, transparent);
  transform-origin: left; transform: scaleX(var(--novel-pct, 0));
  transition: transform var(--novel-dur) var(--novel-ease);
}
.novel-rdr-bar.novel-dark .novel-rdr-trail { background: var(--novel-border-faint); }
.novel-rdr-bar.novel-dark .novel-rdr-trail::after { background: var(--novel-brand); }
.novel-rdr-acts { display: flex; gap: var(--novel-sp-1); align-items: center; }
.novel-rdr-main { position: relative; flex: 1 1 auto; min-height: 0; display: flex; align-items: flex-start; background: var(--novel-paper); }
/* 正文列宽随字号走：--novel-measure（缺省 36em，行内由 prefs.measure 覆写；em 跟着
   prefs.fontSize 变，中文一行约 36 字）。
   旧实现 padding 写死 calc(50% - 320px) = 恒 640px 列 → 12px 字号约 53 字/行、
   28px 字号约 23 字/行，两端都出了舒适区。 */
.novel-rdr-body {
  flex: 1 1 auto; min-width: 0; max-width: var(--novel-measure); margin-inline: auto;
  overflow-y: auto; padding: var(--novel-sp-7) var(--novel-sp-5) calc(var(--novel-sp-7) * 3);
  color: var(--novel-paper-ink);
}
/* 章界：一条「发丝 + 小字 + 发丝」的分带，不再刷成 1.3em 居中大标题——相当一部分在线源的正文
   第一行就是同一句章名（stripLeadingTitle 剥得掉），但即便剥掉，居中粗体大标题在连续滚动的
   章与章之间也像另起了一页书。仍是 h2：阅读器这一屏没有更高的标题占位，从 h3 起等于给读屏一份
   断了头的大纲。字号走 em：它随 prefs.fontSize 一起缩放，28px 字号下不该还是 12px。
   正文里嵌来的 h2（图文章）不再被这条规则命中——那是 .novel-body h1..h6 的地盘，
   旧写法把内容标题一起居中了，属误伤。 */
.novel-rdr-body h2.novel-rdr-mark {
  display: flex; align-items: center; gap: var(--novel-sp-3);
  font-size: .72em; font-weight: 400; letter-spacing: .06em; opacity: .55;
  margin: 0 0 var(--novel-sp-5);
}
.novel-rdr-mark::before, .novel-rdr-mark::after { content: ''; flex: 1; height: 1px; background: currentColor; opacity: .35; }
.novel-rdr-body p { margin: .5em 0; text-indent: 2em; }
.novel-rdr-body [data-chapter] { margin-bottom: 1.2em; }
.novel-rdr-loading { padding: var(--novel-sp-7) 0; text-align: center; opacity: .6; font-size: var(--novel-fs-md); }
.novel-sentinel { opacity: .5; font-size: var(--novel-fs-sm); padding: var(--novel-sp-6) 0; text-align: center; }
/* 目录抽屉：锚视口靠**外层 .novel-drawer-slot 的 sticky**，抽屉本体 absolute 浮在正文右缘。
   为什么外层宽度给 0：抽屉当「有宽度的 flex 兄弟」会从正文列里切走宽度（实测 766px 视口下
   38 字/行 → 22 字/行）。0 宽槽 + 绝对定位子件 = sticky 跟随性保留、正文列不缩水、窄屏时
   抽屉压在正文上（选章是瞬时态，压字可接受，挤列不可接受）。
   三版死法（各自错在哪一条前提上）：
     ① flex 兄弟 + sticky 无高度上限 → 整页被目录撑到两万多 px；
     ② absolute 锚 .novel-rdr-main → 锚的是内容盒起点（读到第 500 章点目录画在头顶上方），
        且 max-height 的 100% 也是正文高度，形同虚设；
     ③ 兄弟 + 视口上限 → flex 列里的条目在滚动发生前先被 flex-shrink 压扁（每条只剩 12px）。
        ③ 的两处修正：条目 flex: none（守卫钉住）+ 槽宽 0。
   sticky 在本环境已被工具栏证明可用（同一祖先链、同一 .novel-main 滚动口径）。
   槽几何是**共用的一条**（选择器组）：目录抽屉与右上角那两块面板（注释 / 导入说明）同住阅读区，
   各抄一份 sticky 就会漂移——漂移的代价实测过两次（面板锚在内容盒上 ⇒ 一滚就飘出视口，
   且对位时把主滚动拉回内容顶部）。守卫：ui-system 的「共用同一份槽几何」那条。 */
.novel-drawer-slot, .novel-notes-slot {
  position: sticky; align-self: flex-start; top: calc(var(--novel-sp-7) + var(--novel-sp-1));
  flex: none; width: 0; height: 0; z-index: var(--novel-z-panel);
}
.novel-drawer {
  position: absolute; right: var(--novel-sp-3); top: var(--novel-sp-3);
  width: min(280px, calc(100vw - 48px)); max-height: calc(100vh - 88px);
  overflow-y: auto; overscroll-behavior: contain;
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); padding: var(--novel-sp-2);
  display: flex; flex-direction: column; gap: var(--novel-sp-0);
  box-shadow: var(--novel-shadow-2);
}
.novel-drawer-item {
  flex: none;                                       /* 见上：可滚动容器里的 flex 条目必须先拒绝收缩 */
  background: none; border: none; text-align: left; width: 100%; color: var(--novel-text-2);
  font: inherit; font-size: var(--novel-fs-md); padding: var(--novel-sp-2) var(--novel-sp-4);
  cursor: pointer; border-radius: var(--novel-r-sm);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-drawer-item:hover { background: var(--novel-hover); color: var(--novel-text); }
/* 当前章：底色 + 左侧 brand 标记。选择器用 aria-current（语义与样式同一个源——
   抽屉条目被 memo 住，高亮靠视图把一个属性挪到那一条上，不重建整份列表） */
.novel-drawer-item[aria-current="true"] {
  background: var(--novel-brand-tint); color: var(--novel-brand-strong); font-weight: 500;
  box-shadow: inset 3px 0 0 var(--novel-brand);
}
.novel-prefs {
  display: flex; flex-direction: column; gap: var(--novel-sp-4); padding: var(--novel-sp-5);
  width: 280px; background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); box-shadow: var(--novel-shadow-2);
}
.novel-prefs-label { font-size: var(--novel-fs-xs); color: var(--novel-text-3); margin-bottom: var(--novel-sp-2); }
.novel-prefs label { font-size: var(--novel-fs-sm); color: var(--novel-text-2); display: flex; gap: var(--novel-sp-3); align-items: center; }
.novel-prefs-color { width: 28px; height: 22px; padding: 0; border: 1px solid var(--novel-border-strong); border-radius: var(--novel-r-xs); background: none; cursor: pointer; }
/* ── 图文正文 / 目录树 / 注释面板（EPUB 三组件，规则一律住本层）───────────────
   三条口径：
   ① 正文组件**不钉颜色与字号**，只继承容器——它同在两处渲染（阅读流是纸张色 + 阅读设置字号，
      注释面板是控制器层 token），组件自己钉色必有一处不可读；下面这组规则只管结构与间距。
   ② 动态量走值槽（--novel-fig-ratio，由 ChapterBody 行内写可信比值），规则里不落行内像素。
   ③ 宽内容在阅读栏内滚（.novel-table-wrap / 图片 max-width），代价是内滚，不是整页横滚。 */
.novel-body { min-width: 0; }
.novel-body p { margin: .5em 0; text-indent: 2em; }
.novel-body h1, .novel-body h2, .novel-body h3, .novel-body h4, .novel-body h5, .novel-body h6 {
  margin: 1.1em 0 .5em; font-weight: 600; line-height: 1.35; text-indent: 0;
}
.novel-body ul, .novel-body ol { margin: .5em 0; padding-left: 2em; }
.novel-body li { margin: var(--novel-sp-1) 0; }
.novel-body blockquote {
  margin: .8em 0; padding-left: var(--novel-sp-5);
  border-left: 3px solid var(--novel-border-strong); text-indent: 0;
}
/* pre 的空白是内容不是排版：换行与缩进原样保留。折行靠 pre-wrap + word-break（超长的词断开，
   不是一条横滚到底的窄带）；overflow-x: auto 只兜确实撑出去的内容。 */
.novel-body pre {
  margin: .8em 0; padding: var(--novel-sp-4); border-radius: var(--novel-r-xs);
  background: var(--novel-skeleton); overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  text-indent: 0; font-family: ui-monospace, Consolas, monospace; font-size: .95em;
}
.novel-body code { font-family: ui-monospace, Consolas, monospace; font-size: .95em; }
.novel-body sup, .novel-body sub { font-size: .75em; line-height: 0; }
.novel-body hr { margin: 1.4em 0; border: none; border-top: 1px solid var(--novel-border); }
/* 宽表在栏内滚：滚动归容器（表格本体不缩），否则整页被一张表撑出横滚条 */
.novel-table-wrap { margin: .8em 0; max-width: 100%; overflow-x: auto; text-indent: 0; }
.novel-body table { border-collapse: collapse; max-width: 100%; }
.novel-body th, .novel-body td {
  border: 1px solid var(--novel-border); padding: var(--novel-sp-1) var(--novel-sp-3); vertical-align: top;
}
.novel-body caption { color: var(--novel-text-3); font-size: var(--novel-fs-sm); text-align: left; }
/* 插图：按可信宽高比先占位，加载完成/失败都不收缩框（失败仍是同一块框，只换内容）。
   宽高比走值槽；容器 max-width: 100% 受阅读栏限制，图片不撑破栏宽。
   text-indent: 0 不是冗余：图常被包在 p 里，段首缩进会继承到这块块级框上、把居中图挪偏。 */
.novel-fig {
  display: block; margin: var(--novel-sp-5) auto; width: 100%; max-width: 100%;
  aspect-ratio: var(--novel-fig-ratio, 4 / 3); text-indent: 0;
  background: var(--novel-skeleton); border-radius: var(--novel-r-xs); overflow: hidden;
}
.novel-fig img { display: block; width: 100%; height: 100%; object-fit: contain; }
.novel-fig-fail {
  display: grid; place-items: center; height: 100%;
  font-size: var(--novel-fs-sm); color: var(--novel-text-3);
}
/* 正文内链：不是 <a>（raw href = 把书内 URL 变成可点击导航），是按钮——字色继承、能聚焦。
   hover 不改色：正文层可能是纸张色，宿主强调色压在上面不一定有对比度。 */
.novel-ref {
  font: inherit; color: inherit; padding: 0; border: none; background: none; cursor: pointer;
  text-align: left; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: .18em;
}
/* 含块级内容的链接（插图/表格/段落等，XHTML5 的透明内容模型允许）本身是块级容器，且**宽度要显式写满**：
   按钮的 width: auto 是「内在宽度」（收缩包裹），不像 div 那样填满包含块——只写 display: block 时
   里面插图的百分比宽度仍解析成 auto，图未解码就没有内在尺寸，占位框塌成 0（实测真浏览器里 0×0，
   图一到手跳到 600×900、后文位移近一屏）。width: 100% 让按钮的宽度基准由包含块（正文栏）给出。 */
.novel-ref-block { display: block; width: 100%; }
/* 链接内容里的块级子节点：XHTML 的 a 允许它们做子节点（源书合法），HTML 的 button 只收短语级元素，
   所以渲染层把块级标签降级成 span，块状观感在这里用 CSS 拿回（内容模型管元素类型，不管 display）。
   novel-ref-rule 是链接里的 hr——那条线还是要画出来。 */
.novel-ref-part { display: block; }
.novel-ref-rule { border-top: 1px solid var(--novel-border-strong); margin: .8em 0; }
/* 目录树：深度靠嵌套列表（结构即层级，不写行内缩进值）；组头不可点，故不是按钮样。 */
.novel-nav { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0); }
.novel-nav .novel-nav { padding-left: var(--novel-sp-4); }
.novel-nav-group {
  padding: var(--novel-sp-2) var(--novel-sp-4) 0;
  color: var(--novel-text-3); font-size: var(--novel-fs-sm); font-weight: 600;
}
/* 注释面板（与导入说明面板同几何）：尺寸与锚定**都**走目录抽屉那一条——外层 .novel-notes-slot
   的 sticky 锚视口（槽几何与抽屉共用同一条规则，见上），本体 absolute 浮在右上。
   曾经的缺陷正是同族浮层并存两套锚定：面板 absolute 挂在 .novel-rdr-main（**内容盒**）上，
   内容盒一滚面板就跟着走，读到章末时飘在视口上方，对位还顺手把主滚动拉回内容顶部。
   落位只滚面板自己的 body，理由与口径见 src/client/util.ts 的 centerInScroller。
   z 走浮层单表——面板挂阅读区任意一层都不必依赖外层槽的 z。
   body 自己滚：脚注可能很长，面板整体不外扩。 */
.novel-notes {
  position: absolute; right: var(--novel-sp-3); top: var(--novel-sp-3); z-index: var(--novel-z-panel);
  display: flex; flex-direction: column; width: min(360px, calc(100vw - 48px));
  max-height: calc(100vh - 88px); overflow: hidden;
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); box-shadow: var(--novel-shadow-2);
}
.novel-notes-head {
  flex-wrap: nowrap; padding: var(--novel-sp-3) var(--novel-sp-4);
  border-bottom: 1px solid var(--novel-border-faint);
}
.novel-notes-title { flex: 1 1 auto; text-align: center; font-size: var(--novel-fs-sm); color: var(--novel-text-2); }
.novel-notes-body {
  padding: var(--novel-sp-2) var(--novel-sp-4) var(--novel-sp-4);
  overflow-y: auto; overscroll-behavior: contain;
  font-size: var(--novel-fs-md); line-height: 1.7;
}
/* 导入说明清单（导入回执与阅读器的导入说明面板共用一份规则）：一条 = 码 + 资源 + 人读的交代。
   列表去掉默认项目符号与缩进——这里的层级是「一条说明」，不是嵌套列表。 */
.novel-warn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--novel-sp-3); }
.novel-warn-list li { text-indent: 0; }
.novel-warn-code { font-size: var(--novel-fs-xs); color: var(--novel-warn); font-family: ui-monospace, Consolas, monospace; }
/* 导入回执（书架顶栏下方那块）：只在有持久告警时出现。左缘竖条说「这是说明不是错误」
   （错的用 .novel-err 那条红字），封面位是 44px 的小缩略图——与卡片同一套封面类，不发明第二套。 */
.novel-import-note {
  display: flex; flex-direction: column; gap: var(--novel-sp-2);
  margin: var(--novel-sp-4) 0; padding: var(--novel-sp-4) var(--novel-sp-5);
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-left: 3px solid var(--novel-warn); border-radius: var(--novel-r-md); box-shadow: var(--novel-shadow-1);
}
.novel-import-head { display: flex; align-items: center; gap: var(--novel-sp-4); }
.novel-import-head > .novel-cover, .novel-import-head > .novel-cover-fallback {
  width: 44px; margin-bottom: 0; flex: none;
}
.novel-import-who { min-width: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0); }
.novel-import-acts { display: flex; justify-content: flex-end; gap: var(--novel-sp-3); }
`
