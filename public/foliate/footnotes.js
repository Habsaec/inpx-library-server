const getTypes = el => new Set(el?.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type')?.split(' '))
const getRoles = el => new Set(el?.getAttribute?.('role')?.split(' '))

const isSuper = el => {
    if (el.matches('sup')) return true
    const { verticalAlign } = getComputedStyle(el)
    return verticalAlign === 'super'
        || verticalAlign === 'top'
        || verticalAlign === 'text-top'
        || /^\d/.test(verticalAlign)
}

const refTypes = ['biblioref', 'glossref', 'noteref']
const refRoles = ['doc-biblioref', 'doc-glossref', 'doc-noteref']
const isFootnoteReference = a => {
    const types = getTypes(a)
    const roles = getRoles(a)
    return {
        yes: refRoles.some(r => roles.has(r)) || refTypes.some(t => types.has(t)),
        maybe: () => !types.has('backlink') && !roles.has('doc-backlink')
            && (isSuper(a) || a.children.length === 1 && isSuper(a.children[0])
            || isSuper(a.parentElement)),
    }
}

const getReferencedType = el => {
    const types = getTypes(el)
    const roles = getRoles(el)
    return roles.has('doc-biblioentry') || types.has('biblioentry') ? 'biblioentry'
        : roles.has('definition') || types.has('glossdef') ? 'definition'
        : roles.has('doc-endnote') || types.has('endnote') || types.has('rearnote') ? 'endnote'
        : roles.has('doc-footnote') || types.has('footnote') ? 'footnote'
        : roles.has('note') || types.has('note') ? 'note' : null
}

const fragmentFromHref = href => {
    const i = href.lastIndexOf('#')
    return i >= 0 ? href.slice(i + 1) : ''
}

/** Фрагмент для сносок: учитывает полный `blob:…#id` (браузерный resolved href). */
export const footnoteTargetFragmentFromHref = href => {
    if (!href || typeof href !== 'string') return ''
    const t = href.trim()
    if (t.startsWith('blob:')) {
        try {
            const hash = new URL(t).hash
            return hash ? decodeURIComponent(hash.slice(1)) : ''
        } catch {
            return ''
        }
    }
    const raw = fragmentFromHref(t)
    if (!raw) return ''
    try {
        return decodeURIComponent(raw)
    } catch {
        return raw
    }
}

const NS_EPUB = 'http://www.idpf.org/2007/ops'

/** Ссылка явно помечена как сноска (EPUB, FB2 после конвертации в XHTML). */
export const footnoteLinkElementIsMarked = a => {
    if (!a?.getAttributeNS) return false
    const t = a.getAttributeNS(NS_EPUB, 'type')
    if (t && /\bnoteref\b/i.test(t)) return true
    const role = a.getAttribute?.('role')
    if (role && /\bdoc-noteref\b|\bdoc-endnote\b/i.test(role)) return true
    return false
}

/**
 * Типичные id целей сносок: FB2 (n_1, note_1), Calibre/Word/Scrivener и др.
 * Не ловим произвольные #chapter2 — только «сноскоподобные» шаблоны.
 */
export const fragmentLooksLikeFootnoteId = frag => {
    if (!frag || typeof frag !== 'string') return false
    const f = frag.trim()
    if (!f) return false
    return /^(?:n[-._]?\d+|notes?[-._]?\d+|nota[-._]?\d+|fn[-._]?\d+|ftn\d*[-._]?\d+|footnotes?[-._]?\d+|foot[-._]?\d+|endnotes?[-._]?\d+|end[-._]?\d+|en[-._]?\d+|_edn[-._]?\d+|edn[-._]?\d+|rearnotes?[-._]?\d+|bu[-._]?\d+|bodynote[-._]?\d+|com\.apple\.ibooks\.footnotes\.(?:note|anchor)(?:[-._]\d+|\d+))$/i.test(f)
}

/** Пробовать клон из другой секции: по id или по семантике ссылки + resolveHref. */
export const shouldTrySpineFootnoteClone = (a, href) => {
    const frag = footnoteTargetFragmentFromHref(href || '')
    if (!frag) return false
    return fragmentLooksLikeFootnoteId(frag) || footnoteLinkElementIsMarked(a)
}

/** Ссылки без epub:noteref, но с типичным id сноски (в т.ч. n_20, fn1). */
const hrefSuggestsFootnote = (book, href) => {
    if (!href || book?.isExternal?.(href)) return false
    const frag = footnoteTargetFragmentFromHref(href)
    if (!frag) return false
    return fragmentLooksLikeFootnoteId(frag)
}

const isInline = 'a, span, sup, sub, em, strong, i, b, small, big'
const extractFootnote = (doc, anchor) => {
    let el = anchor(doc)
    const target = el
    while (el.matches(isInline)) {
        const parent = el.parentElement
        if (!parent) break
        el = parent
    }
    if (el === doc.body) {
        const sibling = target.nextElementSibling
        if (sibling && !sibling.matches(isInline)) return sibling
        throw new Error('Failed to extract footnote')
    }
    return el
}

export class FootnoteHandler extends EventTarget {
    detectFootnotes = true
    #showFragment(book, { index, anchor }, href) {
        const view = document.createElement('foliate-view')
        const targetIndex = index
        return new Promise((resolve, reject) => {
            view.addEventListener('load', e => {
                if (e.detail?.index !== targetIndex) return
                try {
                    const { doc } = e.detail
                    const el = anchor(doc)
                    const type = getReferencedType(el)
                    const hidden = el?.matches?.('aside') && type === 'footnote'
                    if (el) {
                        let range
                        if (el.startContainer) {
                            range = el
                        } else if (el.matches('li, aside')) {
                            range = doc.createRange()
                            range.selectNodeContents(el)
                        } else if (el.closest('li')) {
                            range = doc.createRange()
                            range.selectNodeContents(el.closest('li'))
                        } else {
                            range = doc.createRange()
                            range.selectNode(el)
                        }
                        const frag = range.extractContents()
                        doc.body.replaceChildren()
                        doc.body.appendChild(frag)
                    }
                    const detail = { view, href, type, hidden, target: el }
                    this.dispatchEvent(new CustomEvent('render', { detail }))
                    resolve()
                } catch (e) {
                    reject(e)
                }
            })
            view.open(book)
                .then(() => this.dispatchEvent(new CustomEvent('before-render', { detail: { view } })))
                .then(() => view.goTo(index))
                .catch(reject)
        })
    }
    handle(book, e) {
        const { a, href, follow } = e.detail
        const { yes, maybe } = isFootnoteReference(a)
        const direct = yes || follow || (this.detectFootnotes && hrefSuggestsFootnote(book, href))

        const showDirect = (target) => {
            if (!target) return undefined
            e.preventDefault()
            return this.#showFragment(book, target, href)
        }
        const showMaybe = (resolved) => {
            if (!resolved) return undefined
            e.preventDefault()
            const { index, anchor } = resolved
            const target = { index, anchor: doc => extractFootnote(doc, anchor) }
            return this.#showFragment(book, target, href)
        }

        if (direct) {
            const r = book.resolveHref(href)
            if (r && typeof r.then === 'function')
                return Promise.resolve(r).then(t => showDirect(t))
            return showDirect(r)
        }
        if (this.detectFootnotes && maybe()) {
            const r = book.resolveHref(href)
            if (r && typeof r.then === 'function')
                return Promise.resolve(r).then(t => showMaybe(t))
            return showMaybe(r)
        }
    }
}
