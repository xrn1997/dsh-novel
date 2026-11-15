import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { ROUTES, paramOps } from '../../shared/wire.js'
import type { TtsEnginePublic, TtsEngineRemoveReceipt, TtsSourcesView } from '../../shared/wire.js'
import { apiGet, apiSend, describeError } from '../api.js'
import { plural, useCopy } from '../copy/index.js'
import { Dialog } from '../views/dialog.js'
import { EngineEditDialog } from './EngineEditDialog.js'
import { useEngineImportExport } from './EngineImportExport.js'
import { descOf, labelOf, rowsOf, statusLabelOf } from './engine-rows.js'
import type { ListState } from './engine-rows.js'

/**
 * 配置卡听书组的「引擎管理」区：源清单（内置 / 浏览器 / 订阅 / cordis）与订阅引擎的编辑、
 * 删除；导入与导出住 `EngineImportExport`，编辑抽屉住 `EngineEditDialog`，本文件只做取数、
 * 状态编排与列表呈现。
 *
 * 四条口径：
 * ① **列表按源清单为骨架、订阅投影按 id 补细节**：`sources()` 是「此刻有什么源」的权威，
 *   `ttsEngines` 只是 http 源的订阅数据投影。插件自有源（builtin / browser / cordis）不
 *   挂编辑/删除——即便注册表里有一条同 id 的脏记录，内置身份优先，那行是死重量，不在这里
 *   变成可写入口。
 * ② **凭据只写不读**：投影永远读不回 cookies / headers / loginInfo，列表和导出都只显示
 *   布尔状态位；编辑表单的凭据位一空 = 保留盘上登录态（PUT 的 auth 缺席语义），填写才覆盖。
 * ③ **失败不折叠**：清单读失败（含注册表坏掉的 503）显示错误与重试，绝不渲染成 0 源的空
 *   列表；导入回执按条留痕，坏条只剪自己（失败半径 = 该条）。**刷新失败不清掉已经就绪的
 *   清单**：错误以横幅和旧清单共存，比整块换成错误更接近事实——「上一次读到的」仍可读。
 * ④ **只读部署**：本页所属的部署只读时，订阅写口（编辑 / 删除 / 导入）一律禁用；清单与导出
 *   是读面，照常可用。订阅是插件数据，写它仍属这台部署的写口，不在这里开口子。
 *
 * cordis 源只在宿主服务在场**且就绪**时进清单；不在时这里合成一条灰显行，文案按健康读数分叉
 * （未安装 / 未就绪＋服务方给的原因码），让「装插件才出现」与「装了还没配好」各有一格可见的说法，
 * 而不是整行消失。
 */

/** 通知行的存活时长：回执挂在列表上方，一条「已删除」不该陪到下一次操作。 */
const NOTICE_TTL_MS = 6000

export function EngineManager({ writable }: { writable: boolean }): ReactNode {
  const t = useCopy()
  // 就绪读数与最近一次失败分开存：刷新失败只加横幅，不清清单（见文件头口径③）。
  const [state, setState] = useState<ListState | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<TtsEnginePublic | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{
    id: string; name: string; opener: HTMLElement | null
  } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // 重读是背景动作：已就绪的清单原样留着，不闪回加载态；失败只换错误，不清旧读数。
    setFailure(null)
    void Promise.all([
      apiGet<TtsSourcesView>(ROUTES.ttsSources.path),
      apiGet<TtsEnginePublic[]>(ROUTES.ttsEngines.path),
    ]).then(
      ([sourceList, engineList]) => {
        if (!alive) return
        setState({ rows: rowsOf(sourceList.sources, engineList, sourceList.hostSpeech), engines: engineList })
      },
      (error: unknown) => {
        if (!alive) return
        setFailure(describeError(error, t))
      },
    )
    return () => { alive = false }
  }, [reloadToken, t])

  // 通知自带寿命：没有下一次操作时也不许常驻。
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => { setNotice(null) }, NOTICE_TTL_MS)
    return () => { clearTimeout(timer) }
  }, [notice])

  const refresh = (): void => { setReloadToken((value) => value + 1) }

  /** 用户主动重试读面：旧通知已经没有意义，先撤掉再重读。 */
  const retry = (): void => {
    setNotice(null)
    refresh()
  }

  const confirmDelete = (): void => {
    if (pendingDelete === null || deleting) return
    const target = pendingDelete
    setDeleting(true)
    setDeleteError(null)
    void apiSend<TtsEngineRemoveReceipt>(paramOps.ttsEngineDelete.at(target.id)).then(
      (result) => {
        setDeleting(false)
        setPendingDelete(null)
        if (result.removed) setNotice(t('tts.engines.delete.done', { name: target.name }))
        else setActionError(t('tts.engines.delete.missing'))
        refresh()
      },
      (error: unknown) => {
        setDeleting(false)
        setDeleteError(describeError(error, t))
      },
    )
  }

  const saved = (engine: TtsEnginePublic): void => {
    setEditing(null)
    setActionError(null)
    setNotice(t('tts.engines.edit.done', { name: engine.name }))
    refresh()
  }

  const rows = state?.rows ?? []
  // 头行的「N 源」只数此刻可用的行：灰显的合成行（宿主服务缺席 / 清单漏报的订阅）不是源。
  const availableCount = rows.filter((row) => row.available).length
  const importExport = useEngineImportExport({
    engines: state?.engines ?? null,
    // 成功导入即换了一份清单：旧通知说的是上一份清单里的事，撤掉再重读。
    onChanged: () => { setNotice(null); refresh() },
    disabled: !writable,
  })

  const loadFailure = failure === null ? null : (
    <div>
      <p className="novel-err novel-note-sm" role="alert">
        {t('tts.engines.loadFailed', { detail: failure })}
      </p>
      <button type="button" className="novel-btn sm" onClick={retry}>
        {t('tts.engines.retry')}
      </button>
    </div>
  )

  return (
    <section className="novel-tts-engines" aria-label={t('tts.engines.title')}>
      <div className="novel-tts-engines-head">
        <strong>{t('tts.engines.title')}</strong>
        {state === null ? null : (
          <span className="novel-tts-engines-count">
            {plural(t, availableCount, 'tts.engines.count.one', 'tts.engines.count.other')}
          </span>
        )}
        <span className="novel-grow" />
        {importExport.controls}
      </div>

      {state !== null ? null : failure === null
        ? <p className="novel-tts-note" role="status">{t('common.loading')}</p>
        : loadFailure}

      {state === null ? null : (
        <>
          {/* 刷新失败：旧清单还在，错误以横幅共存（口径③）。 */}
          {loadFailure}
          <div className="novel-tts-engines-list">
            {rows.map((row) => {
              const engine = row.engine
              return (
                <div
                  key={row.id}
                  className={row.available ? 'novel-tts-engine' : 'novel-tts-engine dim'}
                  data-novel-tts-engine={row.id}
                  data-novel-tts-engine-kind={row.kind}
                  data-state={row.available ? 'available' : 'unavailable'}
                >
                  <div className="novel-tts-engine-info">
                    <div className="novel-tts-engine-name">{labelOf(t, row)}</div>
                    <div className="novel-tts-engine-desc">{descOf(t, row)}</div>
                  </div>
                  <span className={row.available ? 'novel-tts-engine-badge ok' : 'novel-tts-engine-badge'}>
                    {statusLabelOf(t, row)}
                  </span>
                  {engine === undefined ? null : (
                    <span className="novel-tts-engine-acts">
                      <button type="button" className="novel-btn sm" disabled={!writable}
                        onClick={() => {
                          setActionError(null)
                          setNotice(null)
                          setEditing(engine)
                        }}>
                        {t('tts.engines.edit')}
                      </button>
                      <button type="button" className="novel-btn sm danger" disabled={!writable}
                        onClick={(event) => {
                          setDeleteError(null)
                          setPendingDelete({
                            id: row.id, name: labelOf(t, row), opener: event.currentTarget,
                          })
                        }}>
                        {t('tts.engines.delete')}
                      </button>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {importExport.panels}

      {actionError === null ? null : <p className="novel-err novel-note-sm" role="alert">{actionError}</p>}
      {notice === null ? null : <p className="novel-tts-note" role="status">{notice}</p>}

      {editing === null ? null : (
        <EngineEditDialog engine={editing} onClose={() => { setEditing(null) }} onSaved={saved} />
      )}

      {pendingDelete === null ? null : (
        <Dialog
          title={t('tts.engines.delete.title', { name: pendingDelete.name })}
          opener={pendingDelete.opener}
          onClose={() => { if (!deleting) setPendingDelete(null) }}
          actions={<>
            <button type="button" className="novel-btn sm" disabled={deleting}
              onClick={() => { setPendingDelete(null) }}>
              {t('common.cancel')}
            </button>
            <button type="button" className="novel-btn sm danger solid" disabled={deleting}
              onClick={confirmDelete}>
              {deleting ? t('tts.engines.delete.deleting') : t('tts.engines.delete.confirm')}
            </button>
          </>}
        >
          <div className="novel-modal-body">{t('tts.engines.delete.body')}</div>
          {deleteError === null ? null : (
            <div className="novel-err novel-note-sm" role="alert">
              {t('tts.engines.delete.failed', { detail: deleteError })}
            </div>
          )}
        </Dialog>
      )}
    </section>
  )
}