/**
 * 摸鱼统计读数的唯一换算处（③编数据口径 b/c/d）：tok 折算、缓存命中、吞吐、错误码。
 *
 * 为什么全是**估算**而不是真读数：伪装会话没有真 token 记账，界面上的 ~N tok / 缓存命中 /
 * tok/s 都是从「真阅读数据」（字数、段序、揭示耗时）折算的自洽读数——带 `~` 前缀的读数就是
 * 明说「这是估算」（宿主 UsagePill 的 `~` 同一语义）。数值随真实阅读量走，不随墙钟走：
 * 摸鱼台上任何读数都不许泄露「现在几点」。
 */

/** tok 折算率：中文字数 × ~0.65（中文语境下 1 字 ≈ 0.65 token 的常用估算口径）。 */
export const MOYU_TOK_PER_CHAR = 0.65

/** 章字数 → 输入侧 tok 估算（宿主 UsagePill 的 `{count} tok` 形态，估算带 ~）。 */
export function tokOf(chars: number): number {
  return Math.max(0, Math.round(chars * MOYU_TOK_PER_CHAR))
}

/** 缓存命中率：按章序从 45% 小步爬到 75%（伪装「越读越命中」的提示词缓存曲线）。 */
export function cacheHitPercentOf(chapterIndex: number, chapterCount: number): number {
  const span = Math.max(1, chapterCount - 1)
  const progress = Math.min(1, Math.max(0, chapterIndex / span))
  return Math.round(45 + progress * 30)
}

/**
 * 吞吐（tok/s）＝本章 tok ÷ 本章揭示真实耗时。耗时不足 1 秒按 1 秒算（分母不置零），
 * 吞吐按宿主 `formatTokensPerSecond` 的取整口径（≥10 取整、<10 一位小数）。
 */
export function tokensPerSecondOf(tok: number, revealSeconds: number): number {
  const seconds = Math.max(1, revealSeconds)
  const tps = tok / seconds
  return tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10
}

/** 错误码芯片的五档（宿主 turnErrorRow 第三列 `<code>` 的量纲）。 */
export type MoyuErrorCode = 'NETWORK' | 'PARSE' | 'AUTH' | 'QUOTA' | 'INTERNAL'

/**
 * 真实错误原因 → 错误码芯片：按 API 错误自带的 `code` 字符串判档，判不出一律 INTERNAL——
 * 宁可报「内部」也不猜网络。`NetworkError` 是本仓客户端造的网络错（`client/api.ts`）。
 */
export function errorCodeOf(code: string | undefined): MoyuErrorCode {
  if (code === undefined) return 'INTERNAL'
  if (code === 'NetworkError' || /network|fetch|timeout/i.test(code)) return 'NETWORK'
  if (/parse|rule|unsupported|syntax/i.test(code)) return 'PARSE'
  if (/auth|login|credential|unauthorized|forbidden|401|403/i.test(code)) return 'AUTH'
  if (/quota|rate|limit|billing|429/i.test(code)) return 'QUOTA'
  return 'INTERNAL'
}
