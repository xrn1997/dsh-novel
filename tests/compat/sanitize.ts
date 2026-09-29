/**
 * compat 采集的**自动脱敏**（入库门禁）。刀数、键名单与被否决的旧判据住 `compat/README.md`「脱敏规程」——
 * 那里是家，这里不重抄一份（原先注释、README、`services.md` 门控表各写各的数，同一件事长出三份抄本）。
 * 2026-09-28 修：原判据要求键后紧跟冒号或等号，于是真页面最常见的 **JSON 带引号键**
 * （`"token":"…"`）与 `Authorization: Bearer …` 头形态**整条不触发**——门禁对机器可读形态是瞎的。
 * **已知代价**：无引号那条会连普通句子一起脱——宁可多脱不可漏脱；自动脱敏**是兜底不是证明**，
 * 入库前仍要人工过目（README 同条）。
 */
const KEY = String.raw`(?:cookie|token|password|passwd|secret|authorization|api[_-]?key)`

/** 第一条：`password` input 的 value（表单快照里最直接的明文口令） */
const PASSWORD_INPUT_RE = /(<input\b[^>]*\btype\s*=\s*["']?password["']?[^>]*?\bvalue\s*=\s*["'])[^"']*(["'])/gi

/** 第二条：带引号值形态（键两侧引号可有可无） */
const QUOTED_VALUE_RE = new RegExp(String.raw`(["']?${KEY}["']?\s*[:=]\s*["'])[^"']{8,}(["'])`, 'gi')

/** 第三条：无引号值形态（HTTP 头 / env 行，`bearer ` 前缀整段吃掉） */
const BARE_VALUE_RE = new RegExp(String.raw`(["']?${KEY}["']?\s*[:=]\s*(?:bearer\s+)?)[A-Za-z0-9._~+/=-]{16,}`, 'gi')

export function sanitize(html: string): string {
  return html
    .replace(PASSWORD_INPUT_RE, '$1[REDACTED]$2')
    .replace(QUOTED_VALUE_RE, '$1[REDACTED]$2')
    .replace(BARE_VALUE_RE, '$1[REDACTED]')
}
