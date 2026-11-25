/**
 * Moyu overlay styles: a faithful replica of the host chat transcript look,
 * widened into a two-column layout — the transcript flow plus a floating
 * action cluster on the left, an IDE-style file sidebar on the right. Every
 * color rides the host semantic aliases (plus the plugin brand token for the
 * active-file accent and the streaming sweep), so light/dark themes follow
 * for free and no color literal lives here (theme-token gate). Typography
 * shares the host content-font axes, so a user-chosen chat font size carries
 * over. z order borrows the plugin modal token so the overlay sits above
 * every reader control layer.
 */
export const MOYU_CSS = `
/* Positioning ladder: the reader root is position:relative and grows to the
   full chapter-flow height, so an absolute inset:0 overlay would size to that
   whole flow and blank the page. The CSS layer keeps position:sticky
   (top:0, 100vh) as the no-JS fallback: it anchors to whichever ancestor
   scrolls once the flow box enters the scrollport. But sticky cannot rescue
   the opening view: the overlay's flow position sits after the entire
   chapter flow (tens of thousands of px down), so at typical reading
   positions it renders far below the viewport and the user sees nothing.
   MoyuStage therefore measures the nearest scrolling ancestor's viewport
   rect and upgrades the root to position:fixed with inline left/top/width/
   height — covering exactly the on-screen slice at any outer scroll, without
   touching the outer scroll (reader position and progress stay intact).
   The row layout splits that slice into the main transcript column and the
   file sidebar; the fabs cluster is absolutely positioned inside the main
   column, so it floats at the visible bottom-right of the transcript area,
   clear of the sidebar. flex:none keeps a definite-height flow variant from
   ever squeezing the fallback box through flex-shrink. */
.novel-moyu-root {
  position: sticky;
  top: 0;
  height: 100vh;
  flex: none;
  z-index: var(--novel-z-modal);
  display: flex;
  flex-direction: row;
  background: var(--dsw-alias-bg-base);
}

/* Main column: transcript scroller plus the floating action cluster. The
   relative anchor exists so the fabs float over the transcript area only. */
.novel-moyu-main {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* Right file sidebar: a mini file explorer over the same host aliases.
   Tinted one step off the base background, hairline divider to the main
   area, its own scroll port with contained overscroll so wheel momentum
   never chains to the reader underneath. position:relative makes it the
   offsetParent for the active-file centering math in MoyuStage (plain
   scrollTop assignment — never scrollIntoView, which would scroll every
   ancestor and pollute the reader position). */
.novel-moyu-side {
  position: relative;
  flex: none;
  width: 232px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}

.novel-moyu-side-head {
  flex: none;
  padding: 10px 16px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

/* Root folder row: the book title as the directory the files live in. */
.novel-moyu-side-folder {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 12px 4px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.novel-moyu-side-twisty {
  flex: none;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary);
}

.novel-moyu-side-folder-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* File rows: full-width quiet buttons, one line each, ellipsized. flex:none
   is load-bearing: the side is a definite-height column flex, so rows left
   shrinkable would be crushed to their padding height (6px) by the chapter
   count instead of overflowing into the scroll port. The active chapter
   rides the plugin brand (IDE active-file look): tinted row, brand-colored
   label, inset left bar. data-done marks chapters this session has reached
   — the "modified" dot pinned to the right edge. */
.novel-moyu-side-file {
  display: block;
  flex: none;
  width: 100%;
  box-sizing: border-box;
  border: 0;
  background: none;
  padding: 3px 28px 3px 30px;
  font-family: inherit;
  font-size: 12px;
  line-height: 20px;
  text-align: left;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  position: relative;
}

.novel-moyu-side-file--static {
  color: var(--dsw-alias-label-caption);
  cursor: default;
}

button.novel-moyu-side-file:hover {
  background: var(--dsw-specific-sidebar-nav-item-hover);
}

.novel-moyu-side-file[aria-current='true'] {
  color: var(--novel-brand);
  background: var(--dsw-specific-sidebar-nav-item-active);
  box-shadow: inset 2px 0 0 var(--novel-brand);
}

.novel-moyu-side-file[data-done]::after {
  content: '●';
  position: absolute;
  right: 10px;
  top: 0;
  bottom: 0;
  margin: auto 0;
  width: 8px;
  height: 8px;
  font-size: 8px;
  line-height: 8px;
  color: var(--novel-brand);
}

.novel-moyu-side-file:focus-visible {
  outline: 2px solid var(--novel-ring);
  outline-offset: -2px;
}

/* Scroll port mirrors the host conversation scroller: full-bleed, the message
   column centers inside it. Anchor suppression keeps programmatic tail
   pinning from being fought by the browser's own scroll anchoring.
   overscroll-behavior:contain stops wheel/touch momentum from chaining to
   the outer reader scroll once the tail is reached, so the reading position
   underneath stays exactly where the user left it. */
.novel-moyu-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
  padding: 16px calc(var(--dsh-composer-side-clearance, 16px) + 16px);
}

/* The host publishes this width axis on its conversation root; the overlay
   does not live inside that tree, so it re-declares the equivalent clamp
   formula locally. */
.novel-moyu-col {
  --dsh-chat-content-width: clamp(680px, 64%, 920px);
  max-width: var(--dsh-chat-content-width);
  width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  row-gap: var(--dsh-chat-flow-gap, 4px);
}

/* One chapter = one assistant turn: a collapsed reasoning row above a tool
   row above a body, closed by a done row and a paging row. */
.novel-moyu-turn {
  display: flex;
  flex-direction: column;
  row-gap: 12px;
}

/* Collapsed reasoning row: one line tall, tertiary tier text. */
.novel-moyu-think {
  display: flex;
  align-items: center;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
}

.novel-moyu-think-icon {
  flex: none;
  width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-inline-end: 6px;
}

.novel-moyu-think-icon svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
}

.novel-moyu-think-title {
  flex: none;
  font-weight: 400;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}

.novel-moyu-think-sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 8px;
  border-radius: 1px;
  background: var(--dsw-alias-label-caption);
}

.novel-moyu-think-summary {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}

/* Streaming shimmer fade: the same mask formula the host row uses. */
.novel-moyu-think-summary[data-streaming] {
  mask-image: linear-gradient(to right, black calc(100% - 48px), transparent);
}

/* Tool row: the "read chapters/..." line, same quiet tier as the reasoning
   row above it; the path ellipsizes instead of wrapping. */
.novel-moyu-tool {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.novel-moyu-tool-glyph {
  flex: none;
}

.novel-moyu-tool-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Done row: the chapter-complete receipt under the body. */
.novel-moyu-done {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* Assistant body: primary label text on the host content font axis;
   paragraph spacing rides the host assistant block gap. */
.novel-moyu-body {
  display: flex;
  flex-direction: column;
  gap: var(--dsh-assistant-block-gap, 16px);
}

.novel-moyu-p {
  margin: 0;
  /* Rhythm rule: one main line (host content size, label-primary, no mark)
     then three small lines — like a run log's dense tool rows between
     output blocks. Both tiers ride the host font axes so user font-size
     choices carry over. */
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
  overflow-wrap: break-word;
}

.novel-moyu-p--small {
  font-size: calc(var(--dsh-content-font-size, 14px) - 2px);
  line-height: calc(20px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-secondary);
}

.novel-moyu-p--small .novel-moyu-mark {
  margin-inline-end: 4px;
  color: var(--dsw-alias-label-tertiary);
}

/* Live sweep: a light band glides left-to-right across the paragraph that
   is still typing. The oversized gradient is positioned so the band sits at
   the left edge at 100% and at the right edge at 0%, so animating
   background-position from 100% to 0 sweeps the band across the text; the
   band itself is a solid brand stop clipped between plain primary stops.
   Paint works by clipping the same background to the glyphs, so the text
   stays readable at every moment. The transparent color is the reason the
   whole rule lives inside @supports: without background-clip:text support
   the clipped paint would fail and the paragraph would render invisible —
   unsupported browsers simply keep the plain readable text. Reduced-motion
   users get the static text. */
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .novel-moyu-p.novel-moyu-live {
    color: transparent;
    background-image: linear-gradient(100deg,
      var(--dsw-alias-label-primary) 0%,
      var(--dsw-alias-label-primary) 44%,
      var(--novel-brand) 50%,
      var(--dsw-alias-label-primary) 56%,
      var(--dsw-alias-label-primary) 100%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    animation: novel-moyu-sweep 1.6s linear infinite;
  }
}

@keyframes novel-moyu-sweep {
  from { background-position: 100% 0; }
  to { background-position: 0 0; }
}

/* Terminal running row: secondary-tier type with a stroked spinner ring. */
.novel-moyu-running {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  color: var(--dsw-alias-label-tertiary);
}

.novel-moyu-spin {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  opacity: 0.9;
  animation: novel-moyu-rotate 0.8s linear infinite;
}

@keyframes novel-moyu-rotate {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .novel-moyu-spin { animation-duration: 1.6s; }
  .novel-moyu-p.novel-moyu-live { animation: none; }
}

.novel-moyu-err {
  color: var(--novel-err);
}

/* Manual paging row under a finished chapter; the pills reuse the floating
   action recipe, disabled at the book's boundaries. */
.novel-moyu-nav {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

/* Floating action cluster, bottom-right of the main column: the host
   back-to-bottom pill recipe. */
.novel-moyu-fabs {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  gap: 8px;
}

.novel-moyu-fab {
  border: 0;
  border-radius: 100px;
  padding: 4px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-button-floating-fill);
  box-shadow: var(--novel-shadow-pop);
}

.novel-moyu-fab:hover {
  background: var(--dsw-alias-button-floating-hover);
}

.novel-moyu-fab:focus-visible {
  outline: 2px solid var(--novel-ring);
  outline-offset: 2px;
}

.novel-moyu-fab:disabled {
  opacity: 0.45;
  cursor: default;
}

.novel-moyu-fab:disabled:hover {
  background: var(--dsw-alias-button-floating-fill);
}
`
