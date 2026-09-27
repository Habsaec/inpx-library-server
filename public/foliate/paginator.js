const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const normalizedSectionText = doc => {
    const root = doc?.body ?? doc?.documentElement
    return root ? String(root.textContent ?? '').replace(/[\t\n\f\r ]+/g, ' ').trim() : ''
}

const sectionTextNodes = doc => {
    const root = doc?.body ?? doc?.documentElement
    if (!root) return []
    const win = doc.defaultView ?? globalThis
    const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement?.tagName?.toLowerCase()
            return parent === 'script' || parent === 'style'
                ? win.NodeFilter.FILTER_REJECT
                : win.NodeFilter.FILTER_ACCEPT
        },
    })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node)
    return nodes
}

const textAnchorFromRange = (doc, range) => {
    if (!doc || !range) return null
    const root = doc.body ?? doc.documentElement
    const start = range.startContainer ? range : null
    if (!start?.startContainer || !root?.contains(range.startContainer)) return null
    const prefix = doc.createRange()
    prefix.selectNodeContents(root)
    try {
        prefix.setEnd(range.startContainer, range.startOffset)
    } catch {
        return null
    }
    const text = normalizedSectionText(doc)
    // Collapse whitespace like rangeFromTextOffset; strip only a leading
    // space so a caret after a word-gap is not shortened by .trim().
    const collapsed = prefix.toString().replace(/[\t\n\f\r ]+/g, ' ').replace(/^ /, '')
    const textOffset = Math.max(0, Math.min(text.length, collapsed.length))
    return {
        textOffset,
        textQuote: text.slice(textOffset, textOffset + 96),
    }
}

const rangeFromTextOffset = (doc, requestedOffset, quote = '') => {
    const nodes = sectionTextNodes(doc)
    if (!nodes.length) return null
    const chars = []
    const points = []
    let pendingSpace = null
    for (const node of nodes) {
        const value = node.nodeValue ?? ''
        for (let offset = 0; offset < value.length; offset += 1) {
            const char = value[offset]
            if (/[\t\n\f\r ]/.test(char)) {
                if (chars.length && pendingSpace == null) pendingSpace = { node, offset }
                continue
            }
            if (pendingSpace) {
                chars.push(' ')
                points.push(pendingSpace)
                pendingSpace = null
            }
            chars.push(char)
            points.push({ node, offset })
        }
    }
    const normalized = chars.join('')
    let textOffset = Math.max(0, Math.min(normalized.length, Math.round(Number(requestedOffset) || 0)))
    const normalizedQuote = String(quote ?? '').replace(/[\t\n\f\r ]+/g, ' ').trim()
    if (normalizedQuote && normalized.slice(textOffset, textOffset + normalizedQuote.length) !== normalizedQuote) {
        const from = Math.max(0, textOffset - 2000)
        const nearby = normalized.indexOf(normalizedQuote, from)
        if (nearby >= 0 && nearby <= textOffset + 2000) textOffset = nearby
    }
    const point = points[Math.min(textOffset, Math.max(0, points.length - 1))]
    if (!point || !doc.createRange) return null
    const range = doc.createRange()
    const len = point.node.nodeValue?.length ?? 0
    // One glyph, not a collapsed caret: collapsed ranges often have empty
    // client rects after CSS columns, and uncollapse() then returns a parent
    // element whose first rect is the start of the section.
    if (point.offset < len) {
        range.setStart(point.node, point.offset)
        range.setEnd(point.node, point.offset + 1)
    } else if (point.offset > 0) {
        range.setStart(point.node, point.offset - 1)
        range.setEnd(point.node, point.offset)
    } else {
        range.setStart(point.node, 0)
        range.collapse(true)
    }
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    if (!doc?.body) return
    // first get all visible nodes
        const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        // skip-links / a11y chrome must not become the visible-range start
        // (empty-start CFI → jump to chapter end; readest#4370)
        if (node.nodeType === 1 && node.hasAttribute?.('cfi-inert')) return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            if (left === 0 && right === 0) return FILTER_REJECT
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            if (left === 0 && right === 0) return FILTER_REJECT
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        sel.removeAllRanges()
        if (collapse === -1) range.collapse(true)
        else if (collapse === 1) range.collapse()
        sel.addRange(range)
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => {
        if (Number(globalThis.visualViewport?.scale) > 1.01) return
        this.expand()
    })
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #lastExpandedSize = NaN
    #layout = {}
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                this.docBackground = getBackground(doc)
                doc.body.style.background = 'none'
                const background = this.docBackground
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl, background })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                doc.fonts.ready.then(() => {
                    if (Number(globalThis.visualViewport?.scale) > 1.01) return
                    this.expand()
                })

                resolve()
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        if (!layout || !this.document) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ margin, gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${margin*1.5}px ${gap}px` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
            'touch-action': 'none',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, margin, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': vertical ? `${margin}px` : `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${margin / 2}px ${gap}px` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                'max-width': vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    expand() {
        if (Number(globalThis.visualViewport?.scale) > 1.01) return
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            if (this.#lastExpandedSize === expandedSize
                && this.#iframe.style[side] === `${expandedSize}px`) {
                return
            }
            this.#lastExpandedSize = expandedSize
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin, gap } = this.#layout
            const padding = this.#vertical ? `0 ${gap}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        if (this.document) this.#observer.unobserve(this.document.body)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin', 'margin-top', 'margin-bottom',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #textOffset = null
    #textQuote = ''
    #layoutHeld = false
    /** Share of the current section, 0–1. Updated on user page turns; re-applied after reflow. */
    #sectionFrac = null
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #restoreBusy = false
    #lastBoxInline = 0
    #lastBoxBlock = 0
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    #selectionPin = null
    #keptSelection = null
    #clampingSel = false
    #restoringSelScroll = false
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            /* Fixed margins (not minmax(_, 1fr)): expanding fr tracks left huge
               uneven empty bands on phone pages. Top/bottom can differ — phone
               reader keeps bottom at 0 (status strip lives outside the view). */
            --_margin-top: var(--_margin);
            --_margin-bottom: var(--_margin);
            grid-template-rows:
                var(--_margin-top)
                minmax(0, 1fr)
                var(--_margin-bottom);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header {
            display: grid;
            height: var(--_margin-top);
        }
        #footer {
            display: grid;
            height: var(--_margin-bottom);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container" part="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => {
            this.dispatchEvent(new Event('scroll'))
            if (this.scrolled || this.#restoringSelScroll || this.#selectionPin == null) return
            if (!this.#selectionActive()) return
            if (Math.abs(this.containerPosition - this.#selectionPin) < 0.5) return
            this.#restoringSelScroll = true
            this.containerPosition = this.#selectionPin
            this.#restoringSelScroll = false
        })
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number' || typeof this.#anchor === 'function')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled || this.#clampingSel) return
                this.#clampSelectionToPage(doc)
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                // Android WebView: selection handles sit slightly outside the
                // visible range, so extending from the first word used to
                // prev()/next() (readest#873). Pointer-driven auto-flip is off.
                if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#replaceBackground(this.#view.docBackground, this.columnCount)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    #boxMetrics() {
        const box = this.#container.getBoundingClientRect()
        return this.#vertical
            ? { inline: box.height, block: box.width }
            : { inline: box.width, block: box.height }
    }
    #pinched() {
        return Number(globalThis.visualViewport?.scale) > 1.01
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.render(true)
                break
            case 'gap':
            case 'margin':
            case 'margin-top':
            case 'margin-bottom':
            case 'max-block-size':
            case 'max-column-count':
                if ((name === 'margin-top' || name === 'margin-bottom') && !value) {
                    this.#top.style.removeProperty('--_' + name)
                } else {
                    this.#top.style.setProperty('--_' + name, value)
                }
                this.render(true)
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render(true)
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView() {
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => {
                // Images/fonts grow the column strip. Re-seeking the text pin
                // here flips pages back and forth while the user is reading.
            },
        })
        this.#container.append(this.#view.element)
        return this.#view
    }
    #replaceBackground(background, columnCount) {
        const doc = this.#view?.document
        if (!doc) return
        const htmlStyle = doc.defaultView.getComputedStyle(doc.documentElement)
        const themeBgColor = htmlStyle.getPropertyValue('--theme-bg-color')
        if (background && themeBgColor) {
            const parsedBackground = background.split(/\s(?=(?:url|rgb|hsl|#[0-9a-fA-F]{3,6}))/)
            parsedBackground[0] = themeBgColor
            background = parsedBackground.join(' ')
        }
        if (/cover.*fixed|fixed.*cover/.test(background)) {
            background = background.replace('cover', 'auto 100%').replace('fixed', '')
        }
        this.#background.innerHTML = ''
        this.#background.style.display = 'grid'
        this.#background.style.gridTemplateColumns = `repeat(${columnCount}, 1fr)`
        for (let i = 0; i < columnCount; i++) {
            const column = document.createElement('div')
            column.style.background = background
            column.style.width = '100%'
            column.style.height = '100%'
            this.#background.appendChild(column)
        }
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        const marginTop = parseFloat(style.getPropertyValue('--_margin-top'))
        const marginBottom = parseFloat(style.getPropertyValue('--_margin-bottom'))
        // Selection/range inset: use the larger edge so top-only phone margins still work.
        this.#margin = Math.max(
            Number.isFinite(margin) ? margin : 0,
            Number.isFinite(marginTop) ? marginTop : 0,
            Number.isFinite(marginBottom) ? marginBottom : 0,
        )

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = vertical ? (size / divisor - margin) : (size / divisor - gap)
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.columnCount = divisor
        this.#replaceBackground(background, this.columnCount)

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    #restoreAfterReflow() {
        // Chapter turns set #anchor to 0/1. Never re-apply the previous
        // chapter's page fraction onto the new section.
        if (typeof this.#anchor === 'number') {
            this.#scrollToAnchor(this.#anchor)
            return
        }
        if (this.#textOffset != null && !this.scrolled) {
            void this.restoreTextAnchor(this.#textOffset, this.#textQuote)
            return
        }
        if (this.#sectionFrac != null) {
            void this.restoreSectionFrac('anchor')
            return
        }
        this.#scrollToAnchor(this.#anchor)
    }
    render(force = false) {
        if (!this.#view) return
        // Pinch-zoom is a visual scale. Do not rebuild CSS columns.
        if (!force && this.#pinched()) return
        const { inline, block } = this.#boxMetrics()
        const unchanged = !force
            && this.#lastBoxInline > 8
            && Math.abs(inline - this.#lastBoxInline) <= 8
            && Math.abs(block - this.#lastBoxBlock) <= 8
        if (unchanged) return
        const prevInline = this.#lastBoxInline
        const prevBlock = this.#lastBoxBlock
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#lastBoxInline = inline
        this.#lastBoxBlock = block
        if (this.#layoutHeld) return
        const viewportChanged = prevInline > 8 && (
            Math.abs(inline - prevInline) > 8 || Math.abs(block - prevBlock) > 8
        )
        if (!viewportChanged) return
        this.#restoreAfterReflow()
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    #pageCount() {
        const n = this.pages
        return Number.isFinite(n) && n > 2 ? n - 2 : 0
    }
    #syncSectionFracFromPage() {
        if (this.scrolled) {
            const vs = this.viewSize
            if (vs > 0) this.#sectionFrac = this.start / vs
            return
        }
        const textPages = this.#pageCount()
        if (!textPages) return
        const page = Math.max(1, Number(this.page) || 1)
        this.#sectionFrac = (page - 1) / textPages
    }
    rememberSectionFrac() {
        if (this.page > 1 || this.#sectionFrac == null) this.#syncSectionFracFromPage()
    }
    async restoreSectionFrac(reason = 'anchor') {
        if (this.#sectionFrac == null) return false
        if (this.scrolled) {
            const vs = this.viewSize
            if (!(vs > 0)) return false
            await this.#scrollTo(this.#sectionFrac * vs, reason)
            return true
        }
        const size = this.size
        if (!(size > 8)) return false
        const textPages = this.#pageCount()
        if (!textPages) return false
        const newPage = Math.max(1, Math.min(
            textPages,
            Math.round(this.#sectionFrac * textPages) + 1,
        ))
        await this.#scrollToPage(newPage, reason)
        return true
    }
    #sectionTextLength() {
        return Math.max(1, normalizedSectionText(this.#view?.document).length)
    }
    get sectionTextLength() {
        return this.#sectionTextLength()
    }
    #textOffsetFromCurrentPage() {
        const { page, pages } = this
        if (this.scrolled || !(pages > 2)) return 0
        return Math.round(((Math.max(1, page) - 1) / Math.max(1, pages - 2)) * this.#sectionTextLength())
    }
    #pageFromTextOffset(offset) {
        const { pages } = this
        const textPages = Math.max(0, (Number.isFinite(pages) ? pages : 0) - 2)
        const frac = Math.min(1, Math.max(0, Number(offset) / this.#sectionTextLength()))
        return Math.round(frac * Math.max(0, textPages - 1)) + 1
    }
    /** Layout-independent pin: survive font/margin/orientation reflow. */
    pinTextAnchor(offset, quote = '') {
        const n = Number(offset)
        if (!Number.isInteger(n) || n < 0) return
        this.#textOffset = n
        this.#textQuote = String(quote || '')
        this.#anchor = doc => rangeFromTextOffset(doc, this.#textOffset, this.#textQuote)
    }
    clearTextAnchor() {
        this.#textOffset = null
        this.#textQuote = ''
    }
    async #landAtSectionEdge(atEnd) {
        if (this.scrolled) {
            const vs = this.viewSize
            if (!(vs > 0)) return
            await this.#scrollTo(atEnd ? vs : 0, 'navigation')
            return
        }
        const { pages } = this
        if (!Number.isFinite(pages) || pages < 3) return
        const target = atEnd ? pages - 2 : 1
        if (this.page !== target) await this.#scrollToPage(target, 'navigation')
    }
    #beginSectionTurn(atEnd) {
        this.clearTextAnchor()
        this.#layoutHeld = false
        this.#sectionFrac = null
        this.#anchor = atEnd ? 1 : 0
    }
    get pinnedTextOffset() {
        return this.#textOffset
    }
    get pinnedTextQuote() {
        return this.#textQuote
    }
    holdLayout() {
        this.#layoutHeld = true
    }
    releaseLayout() {
        this.#layoutHeld = false
    }
    #visibleTextOffset() {
        const info = textAnchorFromRange(this.#view?.document, this.#lastVisibleRange)
        if (info && Number.isInteger(info.textOffset) && info.textOffset > 0) return info.textOffset
        if (info && Number.isInteger(info.textOffset) && this.page <= 1) return info.textOffset
        return this.#textOffsetFromCurrentPage()
    }
    async restoreTextAnchor(offset, quote = '') {
        this.pinTextAnchor(offset, quote)
        if (this.#textOffset == null || this.#restoreBusy) return
        this.#restoreBusy = true
        try {
            if (this.scrolled) {
                return this.#scrollToAnchor(
                    doc => rangeFromTextOffset(doc, this.#textOffset, this.#textQuote),
                    'anchor',
                )
            }
            // Android WebView CSS columns: Range.getClientRects() is often viewport-
            // relative (x≈0) → page 1. Map through page count, then nudge using the
            // visible-range offset so a tall/short page after rotate keeps the same
            // sentence instead of the same percentage of pages.
            // reason 'anchor' must not commit mid-nudge as a user page-turn.
            const size = this.size
            if (!(size > 8)) return
            const lastContent = Math.max(1, this.pages - 2)
            let page = Math.min(lastContent, Math.max(1, this.#pageFromTextOffset(this.#textOffset)))
            await this.#scrollToPage(page, 'anchor')
            const target = this.#textOffset
            let landed = this.#visibleTextOffset()
            const dir = Number.isInteger(landed) && landed < target ? 1 : -1
            for (let i = 0; i < 16; i++) {
                if (!Number.isInteger(landed) || Math.abs(landed - target) <= 120) break
                const next = page + dir
                if (next < 1 || next > lastContent) break
                await this.#scrollToPage(next, 'anchor')
                const nextLanded = this.#visibleTextOffset()
                if (Number.isInteger(nextLanded) && Math.abs(nextLanded - target) > Math.abs(landed - target)) {
                    await this.#scrollToPage(page, 'anchor')
                    break
                }
                page = next
                landed = nextLanded
            }
        } finally {
            this.#restoreBusy = false
        }
    }
    // this is the current position of the container
    get containerPosition() {
        return this.#container[this.scrollProp]
    }

    // this is the new position of the containr
    set containerPosition(newVal) {
        this.#container[this.scrollProp] = newVal
    }

    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        this.containerPosition = Math.max(min, Math.min(max,
            this.containerPosition + delta))
    }

    snap(vx, vy) {
        if (!this.#scrollBounds) return
        const velocity = this.#vertical ? vy : vx
        const { pages, size } = this
        if (!(size > 0)) return

        const startPage = this.#touchState?.startPage != null ? this.#touchState.startPage : this.page
        const startOffset = size * (this.#rtl ? -startPage : startPage)
        const displacement = (this.containerPosition - startOffset) * (this.#rtl ? -1 : 1)
        const v = (isNaN(velocity) ? 0 : velocity) * (this.#rtl ? -1 : 1)

        let pageDelta = 0
        if (displacement > size * 0.18 || v > 0.15) {
            pageDelta = 1
        } else if (displacement < -size * 0.18 || v < -0.15) {
            pageDelta = -1
        }

        let page = startPage + pageDelta
        const minPage = 0
        const maxPage = Math.max(0, pages - 1)
        page = Math.max(minPage, Math.min(maxPage, page))

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (!dir) return
            this.#beginSectionTurn(dir < 0)
            return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            }).then(() => this.#landAtSectionEdge(dir < 0))
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, vy: 0,
            dx: 0, dy: 0,
            overscroll: 0,
            startPage: this.page,
            startPos: this.containerPosition,
            x0: touch?.screenX, y0: touch?.screenY,
            t0: e.timeStamp,
            selecting: this.#selectionActive(),
        }
    }
    #selectionActive() {
        const selection = this.#view?.document?.getSelection?.()
        return !!(selection && selection.rangeCount > 0 && !selection.isCollapsed)
    }
    #clampSelectionToPage(doc) {
        const sel = doc.getSelection?.()
        if (!sel?.rangeCount || sel.isCollapsed) {
            this.#selectionPin = null
            this.#keptSelection = null
            return
        }
        if (this.#selectionPin == null) this.#selectionPin = this.containerPosition
        const win = doc.defaultView
        const rect = this.#focusCaretRect(doc, sel)
        const outside = !!(rect && win && (
            rect.left > win.innerWidth + 16
            || rect.right < -16
            || rect.top > win.innerHeight + 28
            || rect.bottom < -28
        ))
        if (!outside) {
            try { this.#keptSelection = sel.getRangeAt(0).cloneRange() } catch { /* ignore */ }
            return
        }
        const kept = this.#keptSelection
        if (!kept) return
        this.#clampingSel = true
        try {
            const backward = selectionIsBackward(sel)
            sel.removeAllRanges()
            if (backward && typeof sel.extend === 'function') {
                sel.collapse(kept.endContainer, kept.endOffset)
                sel.extend(kept.startContainer, kept.startOffset)
            } else sel.addRange(kept)
        } catch { /* keep the browser range */ }
        finally { this.#clampingSel = false }
    }
    #focusCaretRect(doc, sel) {
        const node = sel.focusNode
        if (!node) return null
        const range = doc.createRange()
        try {
            if (node.nodeType === 3) {
                const len = node.length || 0
                const at = Math.max(0, Math.min(len, sel.focusOffset || 0))
                const next = Math.min(len, at + 1)
                if (next > at) {
                    range.setStart(node, at)
                    range.setEnd(node, next)
                } else {
                    range.setStart(node, Math.max(0, at - 1))
                    range.setEnd(node, at)
                }
            } else {
                range.setStart(node, sel.focusOffset || 0)
                range.collapse(true)
            }
        } catch { return null }
        const rect = range.getBoundingClientRect()
        if (!rect || (!rect.width && !rect.height && !rect.left && !rect.top)) return null
        return rect
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (!state || state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        if (this.#selectionActive()) state.selecting = true
        if (state.selecting) {
            const pin = state.startPos
            if (pin != null && this.containerPosition !== pin) this.containerPosition = pin
            this.#touchScrolled = false
            return
        }
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.dx += dx
        state.dy += dy

        // iframe scrolling=no: native overflow on #container does not receive
        // iframe touches on Android WebView. Drive scrollTop ourselves.
        if (this.scrolled && !this.#vertical) {
            const adx = Math.abs(dx), ady = Math.abs(dy)
            if (!this.#touchScrolled) {
                if (adx < 4 && ady < 4) return
                if (ady < adx) return
                this.#touchScrolled = true
            }
            e.preventDefault()
            state.x = x
            state.y = y
            state.t = e.timeStamp
            state.vx = dx / dt
            state.vy = dy / dt
            const atTop = this.start <= 1
            const atBottom = this.viewSize - this.end <= 2
            if (atTop && dy < 0) {
                state.overscroll = (state.overscroll || 0) + dy
            } else if (atBottom && dy > 0) {
                state.overscroll = (state.overscroll || 0) + dy
            } else {
                state.overscroll = 0
                const maxStart = Math.max(0, this.viewSize - this.size)
                this.containerPosition = Math.max(0, Math.min(maxStart, this.start + dy))
            }
            return
        }
        if (this.scrolled) return

        const held = Math.max(1, e.timeStamp - (state.t0 ?? state.t))
        const travel = Math.hypot((state.x0 ?? state.x) - x, (state.y0 ?? state.y) - y)
        if (!this.#touchScrolled && travel < 36) {
            state.x = x
            state.y = y
            state.t = e.timeStamp
            return
        }
        if (!this.#touchScrolled && travel / held < 0.55) {
            state.selecting = true
            if (this.#selectionPin == null) this.#selectionPin = state.startPos
            return
        }

        // Horizontal books: only follow a predominantly horizontal finger.
        // Vertical toolbar-toggle swipes used to drag + snap on lift-off
        // jitter (readest#5185).
        if (!this.#vertical && Math.abs(state.dy) > Math.abs(state.dx)) {
            state.x = x
            state.y = y
            state.t = e.timeStamp
            state.vx = dx / dt
            state.vy = dy / dt
            return
        }

        e.preventDefault()
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        this.scrollBy(this.#vertical ? 0 : dx, this.#vertical ? dy : 0)
    }
    /** Событие с doc (iframe): reader может вызвать preventDefault на коротком тапе — тогда не snap(). */
    #onTouchEnd(e) {
        const state = this.#touchState
        const overscroll = state?.overscroll || 0
        const touchScrolled = this.#touchScrolled
        const selecting = state?.selecting || this.#selectionActive()
        this.#touchScrolled = false
        if (selecting) {
            if (state?.startPos != null) this.containerPosition = state.startPos
            return
        }
        if (this.scrolled) {
            const thresh = 56
            if (overscroll > thresh && this.#adjacentIndex(1) != null) void this.next()
            else if (overscroll < -thresh && this.#adjacentIndex(-1) != null) void this.prev()
            return
        }
        if (e?.defaultPrevented) return
        // Whole gesture must be horizontal, not last-sample lift-off jitter.
        if (!this.#vertical && state && Math.abs(state.dy || 0) > Math.abs(state.dx || 0)) return
        if (!touchScrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const size = this.size
        if (!size) return
        const offset = this.#getRectMapper()(rect).left
        // Page 0 / last page are empty sentinels. A range at the start of a
        // column can have a slightly negative offset and land on a blank page.
        let page = Math.floor(offset / size) + (this.#rtl ? -1 : 1)
        const lastContent = Math.max(1, this.pages - 2)
        if (page < 1) page = 1
        else if (page > lastContent) page = lastContent
        return this.#scrollToPage(page, reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const { size } = this
        if (this.containerPosition === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            this.containerPosition, offset, 300, easeOutQuad,
            x => this.containerPosition = x,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            this.containerPosition = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    /** Exact paginator page index (bypasses CFI scrollToRect page snap). */
    async scrollToPageIndex(pageIndex, reason = 'navigation') {
        return this.#scrollToPage(pageIndex, reason)
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        const doc = this.#view?.document
        let resolved = anchor
        if (typeof resolved === 'function' && doc) {
            try { resolved = resolved(doc) } catch { /* keep previous */ }
        }

        // Upstream foliate-js: a numeric dest (0 = start, 1 = end) always wins.
        // Our text pin must not hijack chapter turns.
        const numericDest = typeof resolved === 'number' && Number.isFinite(resolved)
        if (numericDest) {
            this.clearTextAnchor()
            this.#anchor = resolved
            if (!this.scrolled && !(this.size > 8)) return
            if (this.scrolled) {
                await this.#scrollTo(resolved * this.viewSize, reason)
                return
            }
            const { pages } = this
            if (!Number.isFinite(pages) || pages < 3) return
            const textPages = pages - 2
            const newPage = Math.round(resolved * (textPages - 1))
            await this.#scrollToPage(newPage + 1, reason)
            return
        }

        this.#anchor = resolved
        if (doc && resolved && typeof resolved !== 'number') {
            const info = textAnchorFromRange(doc, resolved)
            if (info && Number.isInteger(info.textOffset)) {
                this.#textOffset = info.textOffset
                this.#textQuote = info.textQuote || ''
            }
        }

        const size = this.size
        if (!this.scrolled && !(size > 8)) return

        const rects = uncollapse(resolved)?.getClientRects?.()
        if (rects?.length) {
            const rect = Array.from(rects).find(r => r.width > 0 && r.height > 0) || rects[0]
            if (rect) {
                const mappedPage = Math.floor(this.#getRectMapper()(rect).left / size) + (this.#rtl ? -1 : 1)
                const pinFrac = this.#textOffset != null
                    ? this.#textOffset / this.#sectionTextLength()
                    : 0
                if (!this.scrolled && mappedPage <= 1 && pinFrac > 0.02) {
                    await this.#scrollToPage(this.#pageFromTextOffset(this.#textOffset), reason)
                    return
                }
                await this.#scrollToRect(rect, reason)
                return
            }
        }

        if (this.#textOffset != null && !this.scrolled) {
            await this.#scrollToPage(this.#pageFromTextOffset(this.#textOffset), reason)
        }
    }
    #getVisibleRange() {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        const range = this.#getVisibleRange()
        if (!range) return
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason === 'page' || reason === 'snap' || reason === 'scroll' || reason === 'navigation') {
            this.#syncSectionFracFromPage()
        }
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor') {
            const info = textAnchorFromRange(this.#view?.document, range)
            const fromRange = info && Number.isInteger(info.textOffset) ? info.textOffset : null
            const fromPage = this.#textOffsetFromCurrentPage()
            // Visible-range geometry is often x=0 in Android column layout, which
            // reports offset 0 while the user is mid-chapter. Prefer page mapping.
            if (fromRange != null && (fromRange > 0 || this.page <= 1)) {
                this.#textOffset = fromRange
                this.#textQuote = info.textQuote || ''
            } else if (fromPage > 0 || this.page <= 1) {
                this.#textOffset = fromPage
            }
            if (this.#textOffset != null) {
                this.#anchor = d => rangeFromTextOffset(d, this.#textOffset, this.#textQuote)
            } else {
                this.#anchor = range
            }
        } else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        if (src) {
            this.clearTextAnchor()
            this.#sectionFrac = null
            if (typeof anchor === 'number') this.#anchor = anchor
            else if (anchor == null) this.#anchor = 0
            else this.#anchor = anchor
        }
        this.#index = index
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        let dest = typeof anchor === 'function' ? anchor(this.#view.document) : anchor
        await this.scrollToAnchor(dest ?? 0, select)
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select }) {
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return !this.atStart
        }
        if (this.atStart) return
        const page = this.page - 1
        // Skip empty sentinel page 0 when a previous section exists (FB2 one-section-per-chapter).
        if (page <= 0 && this.#adjacentIndex(-1) != null) return Promise.resolve(true)
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return !this.atEnd
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        // Skip empty trailing sentinel when the next section exists; otherwise chapter
        // boundaries (each FB2 chapter = section) show a blank page between chapters.
        if (page >= pages - 1 && this.#adjacentIndex(1) != null) return Promise.resolve(true)
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        const prev = dir === -1
        const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
        if (shouldGo) {
            this.#beginSectionTurn(prev)
            await this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: prev ? () => 1 : () => 0,
            })
            await this.#landAtSectionEdge(prev)
        }
        if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        this.#locked = false
    }
    async prev(distance) {
        return await this.#turnPage(-1, distance)
    }
    async next(distance) {
        return await this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    setStyles(styles) {
        this.#styles = styles
        const $$styles = this.#styleMap.get(this.#view?.document)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles

        // NOTE: needs `requestAnimationFrame` in Chromium
        requestAnimationFrame(() => {
            const doc = this.#view?.document
            if (doc) this.#view.docBackground = getBackground(doc)
            this.#replaceBackground(this.#view.docBackground, this.columnCount)
        })

        // needed because the resize observer doesn't work in Firefox
        this.#view?.document?.fonts?.ready?.then(() => {
            if (Number(globalThis.visualViewport?.scale) > 1.01) return
            this.#view?.expand()
        })
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#view.destroy()
        this.#view = null
        this.sections[this.#index]?.unload?.()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
