/** 搜索块（`NOVEL_CSS` 的第 5 块）：聚合搜索的分批/分组/失败折叠，以及书架与搜索共用的
 *  简约版通用内容列。 */
export const SEARCH_CSS = `
/* ── 搜索（IA 不变：分批进度 + 逐源分组 + 失败折叠；仅呈现收敛为简约版）── */
.novel-search-bar {
  display: flex; flex-wrap: wrap; gap: var(--novel-sp-3) var(--novel-sp-4); align-items: center;
  padding: var(--novel-sp-6) 0 var(--novel-sp-5);
}
.novel-search-form { flex: 1 1 240px; display: flex; gap: var(--novel-sp-3); min-width: 0; }
.novel-search-form .novel-searchbox { flex: 1 1 180px; }
.novel-search-prog { display: flex; flex-direction: column; gap: var(--novel-sp-3); }
.novel-search-prog .novel-progress { height: 4px; border-radius: 2px; }
.novel-prog-text { font-size: var(--novel-fs-sm); color: var(--novel-text-3); display: flex; flex-wrap: wrap; gap: var(--novel-sp-3) var(--novel-sp-4); align-items: baseline; }
.novel-prog-text b { color: var(--novel-text-2); font-weight: 600; }
.novel-groups { display: flex; flex-direction: column; gap: var(--novel-sp-6); }
.novel-group-head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--novel-sp-3) var(--novel-sp-4);
  margin-bottom: var(--novel-sp-0); padding-bottom: var(--novel-sp-2);
  border-bottom: 1px solid var(--novel-border-faint);
}
.novel-group-head strong { font-size: var(--novel-fs-base); font-weight: 600; }
/* 命中行：发丝分隔线列表（真实搜索动辄十几条命中，靠分隔线扫读）。
   结构口径：行 = 容器 + **主按钮**（标题/副行）+ 兄弟动作钮。
   不要用 div[role=button] 里套 button——只绑 onClick 会让键盘 Enter/Space 什么都不发生，
   且读屏念成「按钮 内含 按钮」。守卫见 ui-system.test.tsx。
   布局：主钮 flex:1 挤压、动作钮天然同行尾；丢掉 flex 会让钮掉到标题下方堆叠。 */
.novel-row {
  display: flex; align-items: center; gap: var(--novel-sp-4);
  border-bottom: 1px solid var(--novel-border-faint); padding: 0;
  transition: background var(--novel-dur) var(--novel-ease);
}
.novel-row:last-child { border-bottom: none; }
.novel-row:hover { background: var(--novel-hover); }
.novel-row-main {
  flex: 1 1 auto; min-width: 0; text-align: left; cursor: pointer;
  background: none; border: none; color: inherit; font: inherit;
  padding: var(--novel-sp-4) var(--novel-sp-3); border-radius: var(--novel-r-sm);
}
.novel-row-main:hover .novel-hit-title, .novel-row-main:focus-visible .novel-hit-title { color: var(--novel-brand-strong); }
/* 无 url 的命中：既不能读也不能加架——竖排两行、不给可点态（hover 不改字色） */
.novel-row-dead { flex-direction: column; align-items: flex-start; gap: 0; padding: var(--novel-sp-4) var(--novel-sp-3); cursor: default; }
.novel-row-dead:hover { background: none; }
.novel-row-dead:hover .novel-hit-title { color: inherit; }
.novel-fail-list { margin-top: var(--novel-sp-2); line-height: 1.6; }
.novel-group .novel-list { gap: 0; }
.novel-hit-title { display: block; font-size: var(--novel-fs-base); }
.novel-row:hover .novel-hit-title { color: var(--novel-brand-strong); }
.novel-hit-sub { display: block; font-size: var(--novel-fs-sm); color: var(--novel-text-3); margin-top: var(--novel-sp-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-row .novel-btn:hover { border-color: var(--novel-brand); color: var(--novel-brand-strong); background: transparent; }
.novel-fail { border-top: 1px solid var(--novel-border-faint); padding: var(--novel-sp-4) 0 var(--novel-sp-1); font-size: var(--novel-fs-sm); color: var(--novel-text-3); }
.novel-fail summary { cursor: pointer; }
.novel-fail summary:hover { color: var(--novel-text-2); }
/* 按源那一档（页尾折叠）借 .novel-fail 的折叠形状，字色跟着落到三级灰——而这条轴的存在理由正是
   「源好坏各自可见」，源名与命中标题灰上加灰等于把可见性读没了。这一条只把**这一档**的字色请回正字：
   尺寸不归它（归 .novel-hit-title 与 .novel-group-head strong），只管颜色。
   选择器把轴标记与折叠类并写，为的是这一条稳赢 .novel-fail、不靠声明次序；就地改 .novel-fail 会连带
   重画失败源折叠与两处疑似折叠——那三条的灰是「这一家不行／这一条可疑」的语气，不在本条覆盖里。 */
[data-novel-per-source].novel-fail { color: var(--novel-text); }
/* 按书那一行（一行一本）。形状取舍的实测理由住在 BookRow 的注释头上（为什么不借 .novel-fail 的折叠），
   这里只写几何。两条轴各用一套：按源轴一块好几行、组间距留 sp-6 那一档，按书轴一行一本、
   邻近本身就是分组线，收到 sp-2——再宽就读成「一句书名一条横线」的散装清单。 */
[data-novel-books].novel-groups { gap: var(--novel-sp-2); }
/* container-type 让下面那条尾巴退档按**这一行自身宽度**判定（与 .novel-list-head 同一理由：
   宿主面板可拖窄，视口断点量不准）。 */
.novel-book-row {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--novel-sp-4);
  border-bottom: 1px solid var(--novel-border-faint); container-type: inline-size;
}
.novel-book-row:last-child { border-bottom: none; }
.novel-book-row > .novel-btn { flex: 0 0 auto; }
/* 主钮复用 .novel-row-main（焦点环与键盘可达都归它认领），这里只把行内排版换成 flex：并写两个类
   是为稳赢那条的 padding 与 flex/min-width，不靠声明次序。两条都是这一行不折行的关键——
   flex-basis 让回 0：.novel-row-main 那条的 1 1 auto 拿内容宽当基准，长作者串一撑就把兄弟动作钮
   挤到第二行；基准 0 才是「先给动作钮留位，剩下归我」。
   nowrap 让内层不折行：多行容器里放不下的是**换行**而不是**收缩**，写了省略号也永远轮不到它。 */
.novel-row-main.novel-book-main {
  display: flex; flex-wrap: nowrap; align-items: baseline; gap: var(--novel-sp-1) var(--novel-sp-4);
  flex: 1 1 0; min-width: 0; padding: var(--novel-sp-3) var(--novel-sp-3) var(--novel-sp-3) var(--novel-sp-0);
}
/* 书名与作者各按自己那一段省略（本仓密集列表的统一口径：截断归 CSS，全串归 title）。
   读数各占一段、互不牵连：家数与尾巴不许被作者的省略号吃掉。 */
.novel-book-main strong, .novel-book-author {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-book-main strong { font-size: var(--novel-fs-base); font-weight: 600; }
.novel-book-main:hover { background: var(--novel-hover); }
.novel-book-main:hover strong { color: var(--novel-brand-strong); }
.novel-book-sources, .novel-book-tail { flex: 0 0 auto; }
/* 尾巴靠 margin-left:auto 顶到行尾：读数与动作钮各占一头，右边缘才成一条直线 */
.novel-book-tail {
  margin-left: auto; display: inline-flex; align-items: baseline; gap: var(--novel-sp-2);
  font-size: var(--novel-fs-sm); color: var(--novel-text-3); white-space: nowrap;
}
.novel-book-main:hover .novel-book-tail { color: var(--novel-text-2); }
/* 箭头只管方向（aria-hidden 在组件上），字归 .novel-book-tail-label：两者都是 aria-expanded 的
   可见读数（为什么名字不另抄一份，见 BookRow 注释头上）。 */
.novel-book-chev { display: inline-block; font-size: var(--novel-fs-xs); transition: transform var(--novel-dur) var(--novel-ease); }
.novel-book-main[aria-expanded='true'] .novel-book-chev { transform: rotate(90deg); }
/* 展开区整幅铺开：它是这一行的第二块，不跟动作钮抢同一行宽度 */
.novel-book-row > .novel-list { flex: 0 0 100%; gap: 0; border-top: 1px solid var(--novel-border-faint); padding-bottom: var(--novel-sp-2); }
.novel-book-row > .novel-list .novel-row { border-bottom: 1px solid var(--novel-border-faint); }
.novel-book-row > .novel-list .novel-row:last-child { border-bottom: none; }
/* 窄面板退档：动作钮那一档宽度是从主钮里扣的，扣到尾巴放不下字就只留箭头——
   「展开 N 条」那笔账行头的「N 家源」旁边少说一次不要紧，箭头在就是还有话可展开 */
@container (max-width: 340px) { .novel-book-tail-label { display: none; } }
/* 进度段：推进走 transform: scaleX 而非 width —— width 每次改都触发布局（书架几十张卡
   + 搜索条 + 运行卡同时在途时逐帧重排），scaleX 只走合成。transform-origin 必须在左，
   否则从中心缩放。行内只写 --novel-pct（唯一动态量）。 */
.novel-progress {
  display: block; height: 6px; border-radius: 3px; background: var(--novel-skeleton); overflow: hidden;
}
.novel-progress > i {
  display: block; height: 100%; transform-origin: left; transform: scaleX(var(--novel-pct, 0));
  background: var(--novel-brand); transition: transform var(--novel-dur) var(--novel-ease);
}
.novel-empty { text-align: center; padding: var(--novel-sp-7) var(--novel-sp-5); color: var(--novel-text-2); font-size: var(--novel-fs-base); }
.novel-empty-title { font-size: var(--novel-fs-lg); margin-bottom: var(--novel-sp-2); }
.novel-empty-hint { display: block; margin-top: var(--novel-sp-2); color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
.novel-empty .novel-btn { margin-top: var(--novel-sp-3); }
.novel-list { display: flex; flex-direction: column; gap: var(--novel-sp-2); }
.novel-chips { display: flex; flex-wrap: wrap; gap: var(--novel-sp-2); }
.novel-group { display: flex; flex-direction: column; gap: var(--novel-sp-1); }
/* ── 简约版：通用内容列（书架/搜索用；设置区块不挂此类，布局不受影响）──
   上限按**场景**给，不是一个 900px 通吃：900px 是「文档阅读宽度」的度量，套在缩略图
   画廊上就成了两边各空两百多 px（实测 1400px 屏空 226px、1800px 空 426px，而网格明明
   还能长出更多列）。画廊 fill、文字列表留可读行长上限。 */
.novel-wrap { max-width: var(--novel-wrap-max, 900px); margin: 0 auto; padding: 0 var(--novel-sp-6); width: 100%; }
[data-novel-view="shelf"] .novel-wrap { --novel-wrap-max: 1600px; }
[data-novel-view="search"] .novel-wrap { --novel-wrap-max: 1100px; }
/* 级别 chip（阅读偏好面板用；设置区 chips 继续走 .novel-btn sm，互不影响） */
.novel-chip {
  background: transparent; border: 1px solid var(--novel-border-strong); color: var(--novel-text-2);
  border-radius: var(--novel-r-sm); font-size: var(--novel-fs-sm); padding: var(--novel-sp-1) var(--novel-sp-4);
  cursor: pointer; font-family: inherit;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease),
    border-color var(--novel-dur) var(--novel-ease);
}
.novel-chip:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-chip.on { color: var(--novel-brand-strong); border-color: var(--novel-brand); background: var(--novel-brand-tint); }
.novel-paper-swatch { width: 24px; height: 18px; padding: 0; border-radius: var(--novel-r-xs); }
.novel-paper-swatch.on { outline: 2px solid var(--novel-brand); outline-offset: 1px; }
`
