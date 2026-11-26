import type { ReactNode } from 'react'
import { plural, useCopy } from '../copy/index.js'
import { WarningList } from './bits.js'
import type { LocalImportWarning } from './types.js'

/**
 * 导入说明面板（EPUB 有损导入的持久交代）：复用注释面板的浮层几何
 * （`.novel-notes`：右上、视口封顶、正文区内滚），与它同属阅读器浮层家族（互斥、Esc 可关）。
 *
 * 内容只有一件事——**服务端持久化的 warnings**：code（程序判据）+ 资源（哪份文档 / 哪张图）+
 * message（人读的交代）。面板**不发请求**：告警在进入阅读器时按书取一次（`GET local/warnings`
 * 刻意不随每次取章重复携带），这里是重看入口而不是第二次读盘。它**不碰主阅读进度**：
 * 没有一处 apiSend，与脚注面板同一条纪律。
 */
export function ImportNotesPanel({ warnings, onClose, darkController = false }: {
  warnings: LocalImportWarning[]
  onClose: () => void
  darkController?: boolean
}): ReactNode {
  const t = useCopy()
  return (
    <div className={darkController ? 'novel-notes-slot novel-dark' : 'novel-notes-slot'}>
      <div className="novel-notes" role="dialog" aria-label={t('reader.importNotes')}>
        <div className="novel-toolbar novel-notes-head">
          <span className="novel-notes-title">
            {plural(t, warnings.length, 'reader.importNotesTitle.one', 'reader.importNotesTitle.other')}
          </span>
          <button type="button" className="novel-btn sm" onClick={onClose}>{t('common.close')}</button>
        </div>
        <div className="novel-notes-body">
          <WarningList warnings={warnings} />
        </div>
      </div>
    </div>
  )
}
