/** 书架块（`NOVEL_CSS` 的第 7 块）：书架头部/筛选、卡片网格，以及来源 chip 与多选态。 */
export const SHELF_CSS = `
/* ── 书架 ── */
.novel-shelf-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-3) var(--novel-sp-5);
  padding: var(--novel-sp-6) 0 var(--novel-sp-4);
}
.novel-shelf-title { font-size: var(--novel-fs-xl); font-weight: 600; margin: 0; letter-spacing: .02em; white-space: nowrap; }
.novel-shelf-count { color: var(--novel-text-3); font-size: var(--novel-fs-md); margin-left: var(--novel-sp-3); font-weight: 400; }
/* 书架 tab 顶栏（三行）：行1 内容标题「书架 · N 本」；行2 搜索框独占一行且整簇居中；
   行3 书架筛选簇（pills + 簇尾排序灰字）。
   为什么不做「工具组与标题同行」：Chrome 把同行 flex item 的假设主尺寸算成 min-content 量级
   （探针实测四件东西 706px 被算成 651px），搜索框与导入钮在标题旁折行堆叠——显式三行后不存在
   这条折行路径。书架顶栏禁止 margin-left:auto（灰字曾被钉到列最右端＝悬浮碎片，已删）。
   （本文件注释里别写反引号：NOVEL_CSS 是模板字符串，反引号会当场截断它。） */
/* 行2：搜索框单独一行（聚合搜索 = 找新书入口，与书架筛选不是同一语义组）。
   form = 搜索框 + 「搜索」提交钮（与搜索页同款 type=submit + primary；可见按钮才是显式入口）。
   基准 460px、可收缩、不写死宽（守卫钉 flex 0 1 Npx + 无固定 width）。整簇居中（用户拍板）。 */
.novel-shelf-search { flex: 1 1 100%; display: flex; align-items: center; justify-content: center; gap: var(--novel-sp-3); }
.novel-shelf-search form { display: flex; align-items: center; gap: var(--novel-sp-2); flex: 0 1 460px; min-width: 0; }
.novel-shelf-search .novel-searchbox { flex: 1 1 auto; min-width: 0; }
.novel-shelf-search form .novel-btn { flex: none; }
.novel-shelf-search-note { color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
/* 搜索框：放大镜图标 + 无边框输入装进层底圆角容器，focus 描边走强调色；
   宽度弹性（1 1 180px）而非死宽——宿主会话列可拖窄，死宽会把标题压成一字一行。
   底色必须读存在的 token：这里曾引用不存在的 --novel-layer，background 整条落 unset
   （空心框）。 */
.novel-searchbox {
  display: flex; align-items: center; gap: var(--novel-sp-3); background: var(--novel-layer-2);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  padding: var(--novel-sp-2) var(--novel-sp-4); flex: 1 1 180px; min-width: 0;
  transition: border-color var(--novel-dur) var(--novel-ease);
}
.novel-searchbox:focus-within { border-color: var(--novel-brand); }
.novel-searchbox > svg { flex: none; color: var(--novel-text-3); }
.novel-searchbox input {
  flex: 1; min-width: 0; width: 100%; background: none; border: none; outline: none;
  color: inherit; font: inherit; font-size: var(--novel-fs-base); padding: 0;
}
.novel-searchbox input::placeholder { color: var(--novel-text-3); }
.novel-seg {
  display: flex; gap: var(--novel-sp-0); background: var(--novel-layer-2);
  border: 1px solid var(--novel-border-faint); border-radius: var(--novel-r-md); padding: var(--novel-sp-0);
}
.novel-seg button {
  background: none; border: none; color: var(--novel-text-2); font-size: var(--novel-fs-md);
  padding: var(--novel-sp-1) var(--novel-sp-4); border-radius: var(--novel-r-sm);
  cursor: pointer; font-family: inherit; white-space: nowrap;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease);
}
.novel-seg button:hover { color: var(--novel-text); }
.novel-seg button.on {
  color: var(--novel-text); background: var(--novel-active); font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .12);
}
/* 行3：书架筛选簇——pills 是书架自己的筛选项（全部/在读/未读/本地），不与搜索同簇；
   排序灰字跟在簇尾（margin-left:auto 已删，见上方病史）。hairline 在簇行下沿：
   控制区与网格的分隔语义不变。有书才渲染（空架/加载中没有可筛的东西）。 */
.novel-shelf-filter {
  flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center;
  gap: var(--novel-sp-3) var(--novel-sp-5);
  padding: var(--novel-sp-4) 0 var(--novel-sp-5);
  border-bottom: 1px solid var(--novel-border-faint);
}
.novel-shelf-sort { color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
.novel-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
  gap: var(--novel-sp-6) var(--novel-sp-5); padding-top: var(--novel-sp-5);
}
/* 空书架兜底：EmptyState 分支不渲染整网格，导入引导卡以单卡网格居中补位——
   工具栏导入钮已移除，导入入口不能随之消失（真零本时它恰恰是最刚需的操作）。 */
.novel-grid.solo { max-width: 200px; margin: 0 auto; }
/* 卡片 = 一格（.novel-cell）里的「打开钮 + 删除钮」两个兄弟按钮：
   打开钮是原生 <button>（Enter/Space 免费可用、焦点环自然），删除钮浮在封面右上；
   旧结构是 div[role=button] 套 button——键盘按不动、读屏念「按钮含按钮」。 */
.novel-cell { position: relative; display: flex; flex-direction: column; }
.novel-card {
  display: flex; flex-direction: column; cursor: pointer; text-align: left;
  font: inherit; color: inherit; border: 1px solid transparent; border-radius: var(--novel-r-sm);
  background: none; padding: var(--novel-sp-2) var(--novel-sp-2) var(--novel-sp-3);
  transition: background var(--novel-dur) var(--novel-ease), transform var(--novel-dur) var(--novel-ease),
    box-shadow var(--novel-dur) var(--novel-ease);
}
.novel-card:hover { background: var(--novel-hover); transform: translateY(-2px); box-shadow: var(--novel-shadow-2); }
.novel-card:focus-visible { transform: translateY(-2px); box-shadow: var(--novel-shadow-2); }
/* 网格末位常驻引导卡 =「导入本地书籍」：搜索入口已由行2搜索框显式承担（「搜一本书」
   引导卡退役），导入职责单一归这张卡；点击触发隐藏 file input。空架兜底见 .novel-grid.solo。 */
.novel-card-ghost .novel-ghost-cover {
  aspect-ratio: 2 / 3; display: grid; place-items: center; margin-bottom: var(--novel-sp-3);
  border: 1px dashed var(--novel-border-strong); border-radius: var(--novel-r-xs);
  color: var(--novel-text-3); font-size: var(--novel-fs-lg);
  transition: border-color var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease),
    background var(--novel-dur) var(--novel-ease);
}
.novel-card-ghost:hover .novel-ghost-cover, .novel-card-ghost:focus-visible .novel-ghost-cover {
  border-color: var(--novel-brand); color: var(--novel-brand-strong); background: var(--novel-brand-soft);
}
/* 加载骨架：按网格占位，避免「文字→整屏网格」的一跳布局位移（shimmer 可关，见 overlays.ts 的 prefers-reduced-motion 段） */
.novel-sk { background: var(--novel-skeleton); border-radius: var(--novel-r-xs); position: relative; overflow: hidden; }
.novel-sk::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .06), transparent);
  transform: translateX(-100%); animation: novel-shimmer 1.4s var(--novel-ease) infinite;
}
.novel-sk-cover { aspect-ratio: 2 / 3; width: 100%; margin-bottom: var(--novel-sp-3); }
.novel-sk-line { height: 10px; }
.novel-sk-line.sm { height: 8px; width: 60%; margin-top: var(--novel-sp-2); }
@keyframes novel-shimmer { to { transform: translateX(100%); } }
.novel-cover {
  aspect-ratio: 2 / 3; width: 100%; object-fit: cover; display: block; margin-bottom: var(--novel-sp-3);
  border-radius: var(--novel-r-xs); border: 1px solid var(--novel-border); background: var(--novel-skeleton);
  box-shadow: var(--novel-shadow-1);
}
/* 首字色块＝真实封面的降级，不是灰色占位符：token 底色 + 顶部渐变高光 + 底部压暗 +
   衬线大字。浅色宿主下白底页面里一块「有质感的深色封面」正是书架的视觉锚点。 */
.novel-cover-fallback {
  position: relative; overflow: hidden;
  aspect-ratio: 2 / 3; display: grid; place-items: center; margin-bottom: var(--novel-sp-3);
  border-radius: var(--novel-r-xs); border: 1px solid var(--novel-border); background: var(--novel-layer-3);
  font-family: "Noto Serif SC", "STSong", "SimSun", serif; font-size: 30px; font-weight: 600;
  letter-spacing: .06em; text-shadow: 0 1px 3px rgba(0, 0, 0, .35);
  box-shadow: var(--novel-shadow-1);
}
.novel-cover-fallback::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(120% 55% at 30% 0%, rgba(255, 255, 255, .16), transparent 60%),
    linear-gradient(180deg, transparent 62%, rgba(0, 0, 0, .22));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .10);
}
.novel-cover-fallback.sm {
  font-size: var(--novel-fs-base); letter-spacing: .2em; font-family: inherit; font-weight: 500;
  color: var(--novel-text-2); background: var(--novel-layer-3); text-shadow: none;
}
.novel-cover-fallback.sm::after { background: none; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06); }
/* 四档色块底：token 底色 + 顶部提亮 155° 渐变（纯色块在浅色主题下像补丁，渐变才是封面感） */
.novel-cover-t1 { background: linear-gradient(155deg, color-mix(in srgb, var(--novel-cover-1) 74%, var(--novel-on-solid) 13%), var(--novel-cover-1)); color: var(--novel-on-solid); }
.novel-cover-t2 { background: linear-gradient(155deg, color-mix(in srgb, var(--novel-cover-2) 74%, var(--novel-on-solid) 13%), var(--novel-cover-2)); color: var(--novel-on-solid); }
.novel-cover-t3 { background: linear-gradient(155deg, color-mix(in srgb, var(--novel-cover-3) 74%, var(--novel-on-solid) 13%), var(--novel-cover-3)); color: var(--novel-on-solid); }
.novel-cover-t4 { background: linear-gradient(155deg, color-mix(in srgb, var(--novel-cover-4) 74%, var(--novel-on-solid) 13%), var(--novel-cover-4)); color: var(--novel-on-solid); }
.novel-card-title {
  display: block; font-size: var(--novel-fs-md); font-weight: 600; line-height: 1.35; padding: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-card:hover .novel-card-title, .novel-card:focus-visible .novel-card-title { color: var(--novel-brand-strong); }
.novel-card-meta {
  display: block; font-size: var(--novel-fs-xs); color: var(--novel-text-3);
  margin: var(--novel-sp-0) 0 var(--novel-sp-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-card .novel-progress { height: 2px; border-radius: 1px; margin-top: var(--novel-sp-0); }
/* 删除钮：hover/焦点显形（鼠标端不吃布局），触屏端无 hover 能力 → 常驻可见
   （旧实现只有 :hover/:focus 两条路，触屏设备上这个操作根本不存在）。 */
.novel-card-x {
  position: absolute; top: var(--novel-sp-2); right: var(--novel-sp-2); z-index: 1;
  width: 24px; height: 24px; padding: 0; line-height: 1; border-radius: var(--novel-r-xs);
  opacity: 0; border: none;
  background: color-mix(in srgb, var(--novel-bg) 60%, transparent); color: var(--novel-text);
  transition: opacity var(--novel-dur) var(--novel-ease), background var(--novel-dur) var(--novel-ease);
}
.novel-cell:hover .novel-card-x, .novel-card-x:focus { opacity: 1; }
.novel-card-x:hover { background: var(--novel-err); color: var(--novel-on-solid); }
.novel-local-tag {
  position: absolute; top: var(--novel-sp-2); left: var(--novel-sp-2); z-index: 1;
  font-size: var(--novel-fs-xs); color: var(--novel-text-2);
  background: color-mix(in srgb, var(--novel-bg) 60%, transparent);
  border-radius: var(--novel-r-xs); padding: var(--novel-sp-0) var(--novel-sp-2);
}
/* ── 来源 chip + 多选态（2026 书架两条新需求）────────────────────────────
   来源 chip 钉在封面**左下**：右上归删除 ✕、左上归本地角标，四个角各司其职。
   色点按 sourceId 派生四档——复用无封面降级那四档 token（hex 仍不出本层），
   于是「同源同色、异源异色」在整架书上一眼可辨。源名超长省略（全名走 title 提示）。 */
.novel-cover-box { position: relative; display: block; margin-bottom: var(--novel-sp-3); }
.novel-cover-box > .novel-cover, .novel-cover-box > .novel-cover-fallback { margin-bottom: 0; }
.novel-src-tag {
  position: absolute; left: var(--novel-sp-2); bottom: var(--novel-sp-2); z-index: 1;
  display: inline-flex; align-items: center; gap: var(--novel-sp-2);
  max-width: calc(100% - var(--novel-sp-4));
  font-size: var(--novel-fs-xs); color: var(--novel-text);
  background: color-mix(in srgb, var(--novel-bg) 68%, transparent);
  border-radius: var(--novel-r-xs); padding: var(--novel-sp-0) var(--novel-sp-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-src-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.novel-src-t1 .novel-src-dot { background: var(--novel-cover-1); }
.novel-src-t2 .novel-src-dot { background: var(--novel-cover-2); }
.novel-src-t3 .novel-src-dot { background: var(--novel-cover-3); }
.novel-src-t4 .novel-src-dot { background: var(--novel-cover-4); }
/* 源已被删（服务端 join 不到）：灰字 + 灰点，不冒充一个还活着的来源 */
.novel-src-tag.gone { color: var(--novel-text-3); }
.novel-src-tag.gone .novel-src-dot { background: var(--novel-text-3); opacity: .55; }
/* 多选态：勾选标记占左上（本地角标让位），选中卡片描边走强调色 */
.novel-check {
  position: absolute; top: var(--novel-sp-2); left: var(--novel-sp-2); z-index: 1;
  width: 18px; height: 18px; border-radius: var(--novel-r-xs);
  display: grid; place-items: center; line-height: 1; font-size: var(--novel-fs-xs);
  background: color-mix(in srgb, var(--novel-bg) 62%, transparent);
  border: 1px solid var(--novel-border-strong); color: var(--novel-on-solid);
}
.novel-cell.on .novel-check { background: var(--novel-brand); border-color: var(--novel-brand); }
.novel-cell.on .novel-card { border-color: var(--novel-brand); }
`
