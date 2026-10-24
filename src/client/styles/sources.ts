/** 书源待办收件箱块（`NOVEL_CSS` 的第 4 块）：调度台 IA 的任务卡网格与列表头读数带。 */
export const SOURCES_CSS = `
/* ── 书源待办收件箱（2026 调度台 IA，用户拍板：反常置顶、任务卡横排）──
   宽屏口径：auto-fit 卡片网格——横跨整列的长条在 1600px 内容列下中间空、动作钮孤悬列尾
   （悬浮碎片病，实测用户反馈）；窄屏/会话列拖窄自动堆叠。
   读数职责从状态 chips 移交此处：坏源/未验证的数量与处置动作同框，chips/.novel-chip-dot 退役。 */
.novel-inbox { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); background: var(--novel-layer-2); }
.novel-inbox-head { display: flex; align-items: center; gap: var(--novel-sp-3);
  padding: var(--novel-sp-3) var(--novel-sp-4); border-bottom: 1px solid var(--novel-border-faint); }
.novel-inbox-head strong { font-size: var(--novel-fs-base); }
.novel-inbox-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 340px));
  gap: var(--novel-sp-3); padding: var(--novel-sp-3) var(--novel-sp-4) var(--novel-sp-4); }
.novel-todo-card { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); background: var(--novel-layer-3);
  padding: var(--novel-sp-3) var(--novel-sp-4); display: flex; flex-direction: column; gap: var(--novel-sp-2); align-items: flex-start; }
.novel-todo-card.err { box-shadow: inset 3px 0 0 var(--novel-err); }
.novel-todo-card.warn { box-shadow: inset 3px 0 0 var(--novel-warn); }
/* 卡内首行：状态名 + 忽略钮（右锚）。卡标题不印计数——读数唯一住址是列表头状态带 */
.novel-todo-head { display: flex; align-items: center; gap: var(--novel-sp-3); width: 100%; }
.novel-todo-label { font-weight: 600; font-size: var(--novel-fs-md); white-space: nowrap; }
.novel-todo-label.err { color: var(--novel-err); }
.novel-todo-label.warn { color: var(--novel-warn); }
.novel-todo-names { color: var(--novel-text-3); font-size: var(--novel-fs-sm); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
/* 源列表头（标题 + 状态带 + 过滤工具 + 编辑切换 + 导入入口）与列表体。
   container-type: inline-size 让下面的状态带退化按**这条头行自身宽度**判定（宿主会话列可拖窄，
   视口断点量不准——与 .novel-table 收地址列同一套理由）。 */
.novel-list-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-3) var(--novel-sp-4);
  padding: var(--novel-sp-3) var(--novel-sp-4); border-bottom: 1px solid var(--novel-border-faint);
  container-type: inline-size; }
.novel-list-head strong { font-size: var(--novel-fs-base); }
/* 状态带（2026-09）：全库读数的唯一住址（待办卡可忽略，读数不能跟着提示一起消失）。
   点号是分隔符不是内容，故走 ::before——加一条数就多一个点，视图里不抄分隔符。
   非 0 的 未验证/坏源 才吃 warn/err 色（0 是"没事"，不该红）；.slim 是窄列可牺牲的部分 */
.novel-src-stats { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: var(--novel-sp-2);
  color: var(--novel-text-2); font-size: var(--novel-fs-sm); }
.novel-src-stats > span { white-space: nowrap; }
.novel-src-stats > span:not(:first-child)::before { content: '·'; margin-right: var(--novel-sp-2); color: var(--novel-text-3); }
.novel-src-stats .warn { color: var(--novel-warn); }
.novel-src-stats .err { color: var(--novel-err); }
/* 窄列退化：留「共 N 个源 · 已启用 M」，掉 已停用/未验证/坏源（丢了能从下拉再筛回来，宽列
   也在同一屏）；再窄由 flex-wrap 自然折行（不裁字）。断点 1000px 由渲染台实测（2026-09-19：
   五项自然宽 326px、退化后 140px，退化买回约 170px 单线余量；宿主内容列常态 ~1600 全五项
   同线）。 */
@container (max-width: 1000px) {
  .novel-src-stats .slim { display: none; }
}
.novel-list-body { display: flex; flex-direction: column; gap: var(--novel-sp-3); padding: var(--novel-sp-3) var(--novel-sp-4) var(--novel-sp-4); }
/* 行内「⋯」溢出菜单：低频动作收纳（登录态/试跑/删除）——行内只留当下要用的；
   锚点是 .novel-actions（position:relative），菜单浮在该格下方。
   .up = 向下放不下时朝上开（判据与理由在 SettingsSourceList 的 toggleMenu）：
   长列表滚到滚动口底，末行菜单向下展开会越出容器可见底——菜单本身没错，是它伸到了外面。 */
.novel-menu { position: absolute; right: 0; top: calc(100% - 6px); z-index: var(--novel-z-panel); min-width: 168px;
  background: var(--novel-layer-3); border: 1px solid var(--novel-border-strong); border-radius: var(--novel-r-md);
  box-shadow: var(--novel-shadow-2); overflow: hidden; }
.novel-menu.up { top: auto; bottom: calc(100% - 6px); }
.novel-menu button { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--novel-text-2);
  font: inherit; font-size: var(--novel-fs-md); padding: var(--novel-sp-2) var(--novel-sp-4); cursor: pointer; }
.novel-menu button:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-menu button.danger { color: var(--novel-err); }
.novel-selbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-3);
  background: var(--novel-brand-soft); border: 1px solid var(--novel-brand-line);
  border-radius: var(--novel-r-md); padding: var(--novel-sp-3) var(--novel-sp-4);
}
.novel-selbar > strong { color: var(--novel-brand-strong); }
.novel-group-filter { max-width: 200px; }
.novel-source-query { max-width: 200px; }
.novel-cell-end { display: flex; justify-content: flex-end; }
.novel-cell-right { text-align: right; }
.novel-cell-groups {
  display: flex; flex-wrap: wrap; gap: var(--novel-sp-2); align-items: center; min-width: 0; overflow: hidden;
}
.novel-grow { flex: 1 1 auto; min-width: 0; }
/* details 折叠块（导入区粘贴小道等）：自带底与描边（.novel-panel），内边距归子件（summary 要顶到边） */
.novel-panel.novel-collapsed { padding: 0; }
.novel-summary { cursor: pointer; padding: var(--novel-sp-2) var(--novel-sp-4); font-size: var(--novel-fs-md); user-select: none; }
.novel-auth-pane { display: flex; flex-wrap: wrap; gap: var(--novel-sp-3); align-items: center; }
.novel-auth-pane .novel-input { flex: 1 1 200px; max-width: 360px; }
`
