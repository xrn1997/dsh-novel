import type { Translate } from '../copy/index.js'
import { describeError } from '../api.js'
import { TtsPlayerError } from './listen-session.js'

/**
 * 播放层错误码 → 当前语言的人话：码与文案之间的唯一一道翻译口，裸码绝不上屏。
 *
 * 住址在这里而不是 `TtsBar.tsx`：起播（阅读器 pill、选区、迷你条）与**换源**（两处设置面共读的
 * `TtsSettingsRows`）都可能抛同一批码，谁报都得先过这一道；放在任何一条表面上，另一条就得抄一份
 * 或者把码原样吐给用户。`TtsPlayerError` 的 `message` 按契约只放码本身，所以这里只认 `code`；
 * 别的错误原样交给 `describeError`（服务端理由本来就是人话）。
 */
export function ttsErrorMessage(t: Translate, error: unknown): string {
  if (error instanceof TtsPlayerError) {
    switch (error.code) {
      case 'TTS_CHAPTERS_EMPTY': return t('tts.error.chaptersEmpty')
      case 'TTS_NO_VOICES': return t('tts.error.noVoices')
      case 'TTS_NOT_ON_SHELF': return t('tts.error.notOnShelf')
      case 'TTS_CHAPTER_LOAD': return t('tts.error.chapterLoad')
    }
  }
  return describeError(error, t)
}
