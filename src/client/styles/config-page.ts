/** 插件页「运行参数」块（`NOVEL_CSS` 的第 10 块）：宿主只给壳，七个字段的行几何与窄档
 *  退化归这里。 */
export const CONFIG_PAGE_CSS = `
/* ── 插件页「运行参数」（config-page）：宿主只给壳，七个字段每一行的几何归这里 ─────────
   这一层的形状就是这一页的可读性本身，所以钉在样式层而不是视图行内：
     · 数字框限宽并右锚在 200px 轨里——全幅框让 1 和 52428800 占一样的地方，
       而后者是这一页最初的病（裸字节数读不出来）。
     · 单位是框内的后缀而不是框下另起一行：label → 值 → 单位 三点一线，眼睛不必跳。
     · 右内边距给单位留位；输入框一律文本型（数字形态归宿主字段模型、值域归 schema），
       所以没有 spinner 要关。 */
.novel-cfg { container-type: inline-size; display: flex; flex-direction: column; gap: var(--novel-sp-4); }
.novel-cfg-title h3 { margin: 0; font-size: var(--novel-fs-lg); font-weight: 600; }
.novel-cfg-title p { margin: var(--novel-sp-1) 0 0; font-size: var(--novel-fs-sm); color: var(--novel-text-3); }
/* 分区卡片自适应成列：宽档两列、窄档一列，不给它写死列数（宿主插件页的可用宽度是变量）。
   align-items: start 是必需的——「网络」区只有一行，默认的 stretch 会把它拉成和「存储上限」
   同高，卡片下半截就成了一片没有内容的底。 */
.novel-cfg-groups { display: grid; align-items: start; gap: var(--novel-sp-4); grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
.novel-cfg-group {
  display: flex; flex-direction: column; gap: var(--novel-sp-5);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  background: var(--novel-layer-2); padding: var(--novel-sp-5);
}
.novel-cfg-group > h4 {
  margin: 0; font-size: var(--novel-fs-md); font-weight: 600; color: var(--novel-text-2);
}
.novel-cfg-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 200px;
  gap: var(--novel-sp-1) var(--novel-sp-5); align-items: start;
}
.novel-cfg-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-2); }
.novel-cfg-head label { font-size: var(--novel-fs-base); font-weight: 600; }
.novel-cfg-tag {
  font-size: var(--novel-fs-xs); color: var(--novel-brand-strong); background: var(--novel-brand-tint);
  border-radius: var(--novel-r-xs); padding: 0 var(--novel-sp-2);
}
/* 「恢复默认」是这行的旁路动作，压成下划线文字钮：给它边框就会和保存条抢注意力。 */
.novel-cfg-reset {
  font: inherit; font-size: var(--novel-fs-xs); color: var(--novel-text-3); background: none;
  border: none; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.novel-cfg-reset:hover { color: var(--novel-text); }
.novel-cfg-reset:focus-visible { outline: 2px solid var(--novel-ring); outline-offset: 2px; }
.novel-cfg-meaning { margin: 0; font-size: var(--novel-fs-sm); line-height: 1.6; color: var(--novel-text-3); }
.novel-cfg-side { display: flex; flex-direction: column; align-items: stretch; gap: var(--novel-sp-2); }
.novel-cfg-box { position: relative; display: block; }
/* 排在 .novel-input 之后才赢：同为单类选择器，靠顺序决胜。右内边距给单位留位。 */
.novel-cfg-input { width: 100%; padding-right: 46px; }
.novel-cfg-input[aria-invalid='true'] { border-color: var(--novel-err); }
.novel-cfg-unit {
  position: absolute; right: var(--novel-sp-4); top: 50%; transform: translateY(-50%);
  font-size: var(--novel-fs-xs); color: var(--novel-text-3); pointer-events: none;
}
.novel-cfg-read { font-size: var(--novel-fs-sm); color: var(--novel-brand-strong); }
/* 预设档加高到 24px 才点得准（真机量到 21px 时浏览器几何门直接红了）；
   inline-flex 是为了加高之后字仍垂直居中，而不是浮在框顶。 */
.novel-cfg-preset {
  display: inline-flex; align-items: center; min-height: var(--novel-sp-6);
  padding: var(--novel-sp-0) var(--novel-sp-3); font-size: var(--novel-fs-xs);
}
.novel-cfg-err { margin: 0; font-size: var(--novel-fs-sm); color: var(--novel-err); }
.novel-cfg-foot { margin: 0; font-size: var(--novel-fs-sm); line-height: 1.6; color: var(--novel-text-3); }
.novel-cfg-foot code { font-family: ui-monospace, Consolas, monospace; font-size: var(--novel-fs-xs); }
/* 窄档（卡片自身不足 560px）：左侧「说什么」与右侧「填什么」折成两段，
   而不是把 200px 轨压成一条缝——数字框一旦被压窄，单位后缀会盖住末位数字。 */
@container (max-width: 560px) {
  .novel-cfg-row { grid-template-columns: minmax(0, 1fr); }
}
`
