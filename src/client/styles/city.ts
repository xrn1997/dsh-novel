/** 书城块（`NOVEL_CSS` 的第 9 块）：分类浏览的左栏源列表 + 右区书单网格与窄档容器查询。 */
export const CITY_CSS = `
/* ── 书城（分类浏览）：左栏一条源列表（选中的源就地展开自己的分类）+ 右区 4 列书单 ──
   三条几何口径（界面稿实测，别凭手感改）：
   ① 只让书单自己滚（.novel-city-gridwrap），标题行 / 顺序说明 / 错误条 / 尾行读数钉在滚动区外——放进
      滚动区就随书单滚走，读进度得先滚到底。那条前提是本层要把高度收到视图根上（.novel-main 已定高，
      链上有确定高度可分），否则内层滚动容器高度由内容决定、等于没滚。
   ② 4 列必须写 minmax(0, 1fr)：1fr 的 auto 最小值会被 nowrap 的书名 / 元信息行撑开，卡片被推出
      面板（3 列与 4 列都实测溢出过）。
   ③ 左栏是**一个**滚动容器，条目一律 flex:none（可滚动 flex 列里的条目在滚动发生前会先被压扁——
      目录抽屉踩过同一个坑）。源与分类同处一栏，靠缩进与一条竖线分层，不靠第二个标题：一栏两节
      各自滚的旧形状里，滚轮落在哪一节由鼠标位置决定，而两句标题加两个筛选框的装饰件实测占掉栏高
      16%（矮面板 27%）。
   窄面板退档（< 900px）那条几何走容器查询，规则与它的理由都写在下面那个 @container 块头上。
   判据是**面板宽度**而不是视口宽度：宿主中央面板可拖窄（侧栏与常驻会话列同时在场时视口远比面板
   宽），视口断点会把 4 列硬塞进一条 400px 的面板。故本视图根自带容器查询锚（与 .novel-table /
   .novel-list-head 同一条裁决：视口断点在分栏布局下量不准）。 */
[data-novel-view="city"] { height: 100%; container-type: inline-size; }
.novel-city { position: relative; flex: 1 1 auto; min-height: 0; display: flex; gap: var(--novel-sp-5); }
/* 一条源列表：整栏自己滚（唯一的滚动容器），选中源下面挂它自己的分类 */
.novel-city-rail {
  width: 216px; flex: none; min-height: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0);
  overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
}
/* 复用 .novel-input 的底 / 描边 / 焦点环，这里只钉本处的几何（两处筛选都是一行矮件） */
.novel-city-filter { flex: none; height: 28px; padding: 0 var(--novel-sp-3); margin-bottom: var(--novel-sp-3); font-size: var(--novel-fs-sm); }
/* 源行与分类行同款可点行：源行右侧一枚「N 类」是本源自己声明的入口数，没有跨源计数可摆 */
.novel-city-source, .novel-city-kind {
  flex: none; display: flex; align-items: center; gap: var(--novel-sp-3); width: 100%; text-align: left;
  padding: var(--novel-sp-1) var(--novel-sp-4); border: none; border-radius: var(--novel-r-sm);
  background: none; color: var(--novel-text-2); font: inherit; font-size: var(--novel-fs-md); cursor: pointer;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease);
}
/* 源行另有一枚 2px 左条说「展开的就是这一行」：整栏只剩一列可点行之后，铺底色不足以把选中源与它
   下面那串分类分开。左条不额外占位——内边距让出那 2px，两行的文字左缘仍按各自档位对齐。 */
.novel-city-source {
  border-left: 2px solid transparent; border-radius: 0 var(--novel-r-sm) var(--novel-r-sm) 0;
  padding-left: calc(var(--novel-sp-4) - 2px);
}
.novel-city-source:hover, .novel-city-kind:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-city-source.on, .novel-city-kind.on { background: var(--novel-brand-tint); color: var(--novel-brand-strong); font-weight: 600; }
.novel-city-source.on { border-left-color: var(--novel-brand); }
.novel-city-source-name { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-city-source-n { flex: none; font-size: var(--novel-fs-xs); color: var(--novel-text-3); font-weight: 400; }
.novel-city-source.on .novel-city-source-n { color: var(--novel-brand-strong); }
.novel-city-source-broken { flex: none; font-size: var(--novel-fs-xs); color: var(--novel-err); }
/* 展开节点：分类只长在选中的源下面。左边距 + 一条竖线就是「这些属于上面那一行」的全部说法，
   源行文字左缘 12px、分类文字左缘 25px——缩进本身是层级，不是装饰。 */
.novel-city-kids {
  flex: none; display: flex; flex-direction: column; gap: var(--novel-sp-0);
  margin: var(--novel-sp-1) 0 var(--novel-sp-2) var(--novel-sp-4);
  padding-left: var(--novel-sp-2); border-left: 1px solid var(--novel-border);
}
.novel-city-kids .novel-city-kind { padding-left: var(--novel-sp-2); }
.novel-city-kfilter { margin-bottom: var(--novel-sp-2); }
.novel-city-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--novel-sp-3); }
.novel-city-head { flex: none; display: flex; align-items: center; gap: var(--novel-sp-4); margin: 0; }
.novel-city-head h2 { margin: 0; font-size: var(--novel-fs-xl); font-weight: 650; }
.novel-city-sub { font-size: var(--novel-fs-xs); color: var(--novel-text-3); }
/* 顺序是**静态说明不是控件**：左栏清单不做任何排序（服务端按该源声明的原样顺序给），
   摆一个下拉出来就是假控件 */
.novel-city-note { flex: none; font-size: var(--novel-fs-xs); color: var(--novel-text-3); }
.novel-city-gridwrap { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.novel-city-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--novel-sp-3); }
.novel-city-card {
  display: flex; gap: var(--novel-sp-4); padding: var(--novel-sp-4); text-align: left;
  background: var(--novel-layer-2); border: 1px solid var(--novel-border-faint);
  border-radius: var(--novel-r-md); color: inherit; font: inherit; cursor: pointer;
  transition: border-color var(--novel-dur) var(--novel-ease), background var(--novel-dur) var(--novel-ease);
}
.novel-city-card:hover { border-color: var(--novel-border); background: var(--novel-layer-3); }
/* 在途骨架卡：盒子借 .novel-city-card、底色与线条借 .novel-sk（骨架语言只此一处，不另造一套），
   本类只抹掉「可点」的假象——它不是一条能点的书，悬停变色就是假控件 */
.novel-city-sk { cursor: default; pointer-events: none; }
/* 封面位：无 coverUrl 时是首字降级块（底色走 .novel-cover-t* 那四档，hex 仍不出 token 层）——
   故本类不带 background，免得按源序压掉后定义的档位色 */
.novel-city-cover {
  flex: none; width: 44px; height: 58px; border-radius: var(--novel-r-xs);
  display: grid; place-items: center; overflow: hidden;
  font-family: "Noto Serif SC", "STSong", "SimSun", serif; font-size: var(--novel-fs-base); font-weight: 600;
}
img.novel-city-cover { display: block; object-fit: cover; background: var(--novel-skeleton); }
.novel-city-card-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0); }
.novel-city-card-title { display: flex; align-items: center; gap: var(--novel-sp-2); }
.novel-city-name {
  min-width: 0; font-size: var(--novel-fs-md); font-weight: 650;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-city-card:hover .novel-city-name { color: var(--novel-brand-strong); }
.novel-city-card-meta, .novel-city-card-last {
  font-size: var(--novel-fs-xs); color: var(--novel-text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-city-card-intro {
  font-size: var(--novel-fs-sm); color: var(--novel-text-2); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
}
/* 未响应那条是本设计的**刻意例外**（与搜索面同哲学：源坏了要如实摊开，不藏在折叠里）——今天只有
   书籍详情浮层的跨源那一列用它：摘要行给源名与错误码，展开才补完整 message。同一列那行「疑似无关」
   的折叠共用这个容器（摘要给得出是谁家、多少条，展开才是内容），但它不是故障——容器本来的红线条
   红底默认也罩着它，故由下面带标记的那一条只把这一族回正成中性线条与中性底；只属于真失败的红
   原样留在未响应那一条上（与按源轴 [data-novel-per-source] 同法：只碰颜色、只用 token、不就地改折叠类）。 */
.novel-city-fail {
  flex: none; border: 1px solid var(--novel-err-line); border-radius: var(--novel-r-sm);
  background: var(--novel-err-weak); padding: var(--novel-sp-2) var(--novel-sp-4);
  font-size: var(--novel-fs-xs); color: var(--novel-text-2);
}
[data-novel-city-suspect].novel-city-fail { border-color: var(--novel-border-faint); background: var(--novel-layer-2); }
.novel-city-fail > summary { display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-2) var(--novel-sp-4); cursor: pointer; }
.novel-city-fail b { font-weight: 600; color: var(--novel-err); }
.novel-city-fail-who { color: var(--novel-text-2); }
.novel-city-fail-more { margin-left: auto; color: var(--novel-text-3); }
.novel-city-fail-msgs { display: flex; flex-direction: column; gap: var(--novel-sp-1); margin-top: var(--novel-sp-2); }
/* 尾行 = 轮次读数 + 「加载更多」按钮（服务端不问就不打下一页，故这颗钮是真控件；读数本身仍只是读数）。
   渲染与否由**有没有轮次**判（没有一轮即整行不出），不是由这行文字空不空判——轮次读数的四条分支
   恒有一句可说，「一条还没回」也有它自己的说法 */
.novel-city-foot {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: var(--novel-sp-3);
  border-top: 1px solid var(--novel-border-faint); padding-top: var(--novel-sp-3);
  font-size: var(--novel-fs-xs); color: var(--novel-text-3);
}
/* 书籍详情浮层：覆盖右区、书单留在原位（它是覆盖层——不卸载书单、不动它的滚动位置）；遮罩与本体
   同住浮层单表。**不复用 .novel-drawer**：那一族锚的是阅读区 0 宽 sticky 槽（见 reader.ts），几何与
   这里「贴右缘通高的覆盖面板」是两件事，硬套会把两处一起改坏。 */
.novel-city-scrim { position: absolute; inset: 0; z-index: var(--novel-z-panel); background: var(--novel-mask); }
.novel-city-drawer {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: var(--novel-z-panel);
  width: min(372px, calc(100% - var(--novel-sp-6))); overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: var(--novel-sp-4); padding: var(--novel-sp-5);
  background: var(--novel-layer-2); border-left: 1px solid var(--novel-border); box-shadow: var(--novel-shadow-pop);
}
.novel-city-drawer-head { flex: none; display: flex; align-items: center; gap: var(--novel-sp-3); }
.novel-city-drawer-title { flex: 1 1 auto; min-width: 0; font-size: var(--novel-fs-lg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-city-bookhead { flex: none; display: flex; flex-direction: column; gap: var(--novel-sp-2); }
.novel-city-bookhead-meta { font-size: var(--novel-fs-sm); color: var(--novel-text-2); }
.novel-city-tags { display: flex; flex-wrap: wrap; gap: var(--novel-sp-2); }
.novel-city-tag {
  font-size: var(--novel-fs-xs); color: var(--novel-text-3); padding: 1px var(--novel-sp-3);
  border: 1px solid var(--novel-border-faint); border-radius: 999px;
}
/* 跨源那一次的进度行：读数 + 「停止」并排（那颗钮说的就是这一行正在跑的那一轮，不搬到浮层底部） */
.novel-city-progress { flex: none; display: flex; align-items: center; gap: var(--novel-sp-4); font-size: var(--novel-fs-xs); }
.novel-city-srclist { display: flex; flex-direction: column; gap: var(--novel-sp-3); }
.novel-city-srcrow {
  display: flex; align-items: center; gap: var(--novel-sp-3); padding: var(--novel-sp-4);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); background: var(--novel-layer-3);
}
.novel-city-srcrow-who { flex: 1 1 auto; min-width: 0; font-size: var(--novel-fs-base); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 这一行里该退让的是「最新」那句（省略号收口），不是两颗钮：钮被挤出浮层就是点不到。
   本源那一行今天根本不带这句——头部那颗 tag 已经把整句说过了（同一层浮层说两遍就是抄本），
   跨源各行带的是各家的最新，放不下就由它自己收省略号。 */
.novel-city-srcrow-last {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--novel-fs-xs); color: var(--novel-text-3);
}
/* 两颗钮不参与收缩：它们一旦被压窄，钮里的字会折成两行（CJK 的 min-content 只有一个字宽） */
.novel-city-srcrow-add { flex: none; }
.novel-city-srcrow-go { flex: none; }
/* 窄面板退档（< 900px）：左栏通栏、限高、限宽，书单回 2 列。**列表形状不变**——旧版在这里把两节
   各折成一条可横滚的 chip 带，那是「两节叠在一栏里」才需要的补丁；一栏一条列表之后没有对象了。
   限宽 340px 是防另一件事：通栏的 13px 短标签行会把右端的「N 类」推到两百多 px 之外，一行读成两半。 */
@container (max-width: 899px) {
  .novel-city { flex-direction: column; }
  .novel-city-rail { width: auto; max-width: 340px; max-height: 38%; }
  .novel-city-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`
