const normalizeWhitespace = str => str ? str
    .replace(/[\t\n\f\r ]+/g, ' ')
    .replace(/^[\t\n\f\r ]+/, '')
    .replace(/[\t\n\f\r ]+$/, '') : ''
const getElementText = el => normalizeWhitespace(el?.textContent)

/** Длина читаемого текста секции (без разметки/картинок) — вес для прогресса Foliate. */
const countSectionText = el => normalizeWhitespace(el?.textContent).length

const NS = {
    XLINK: 'http://www.w3.org/1999/xlink',
    EPUB: 'http://www.idpf.org/2007/ops',
}

const MIME = {
    XML: 'application/xml',
    XHTML: 'application/xhtml+xml',
}

const STYLE = {
    'strong': ['strong', 'self'],
    'emphasis': ['em', 'self'],
    'style': ['span', 'self'],
    'a': 'anchor',
    'strikethrough': ['s', 'self'],
    'sub': ['sub', 'self'],
    'sup': ['sup', 'self'],
    'code': ['code', 'self'],
    'image': 'image',
}

const TABLE = {
    'tr': ['tr', {
        'th': ['th', STYLE, ['colspan', 'rowspan', 'align', 'valign']],
        'td': ['td', STYLE, ['colspan', 'rowspan', 'align', 'valign']],
    }, ['align']],
}

const POEM = {
    'epigraph': ['blockquote'],
    'subtitle': ['h2', STYLE],
    'text-author': ['p', STYLE],
    'date': ['p', STYLE],
    'stanza': 'stanza',
}

const SECTION = {
    'title': ['header', {
        'p': ['h1', STYLE],
        'empty-line': ['br'],
    }],
    'epigraph': ['blockquote', 'self'],
    'image': 'image',
    'annotation': ['aside'],
    'section': ['section', 'self'],
    'p': ['p', STYLE],
    'poem': ['blockquote', POEM],
    'subtitle': ['h2', STYLE],
    'cite': ['blockquote', 'self'],
    'empty-line': ['br'],
    'table': ['table', TABLE],
    'text-author': ['p', STYLE],
}
POEM['epigraph'].push(SECTION)

const BODY = {
    'image': 'image',
    'title': ['section', {
        'p': ['h1', STYLE],
        'empty-line': ['br'],
    }],
    'epigraph': ['section', SECTION],
    'section': ['section', SECTION],
}

class FB2Converter {
    constructor(fb2) {
        this.fb2 = fb2
        this.doc = document.implementation.createDocument(NS.XHTML, 'html')
        // use this instead of `getElementById` to allow images like
        // `<image l:href="#img1.jpg" id="img1.jpg" />`
        this.bins = new Map(Array.from(this.fb2.getElementsByTagName('binary'),
            el => [el.id, el]))
    }
    getImageSrc(el) {
        const href = el.getAttributeNS(NS.XLINK, 'href')
        if (!href) return 'data:,'
        const [, id] = href.split('#')
        if (!id) return href
        const bin = this.bins.get(id)
        return bin
            ? `data:${bin.getAttribute('content-type')};base64,${bin.textContent}`
            : href
    }
    image(node) {
        const el = this.doc.createElement('img')
        el.alt = node.getAttribute('alt')
        el.title = node.getAttribute('title')
        el.setAttribute('src', this.getImageSrc(node))
        return el
    }
    anchor(node) {
        const el = this.convert(node, { 'a': ['a', STYLE] })
        el.setAttribute('href', node.getAttributeNS(NS.XLINK, 'href'))
        if (node.getAttribute('type') === 'note')
            el.setAttributeNS(NS.EPUB, 'epub:type', 'noteref')
        return el
    }
    stanza(node) {
        const el = this.convert(node, {
            'stanza': ['p', {
                'title': ['header', {
                    'p': ['strong', STYLE],
                    'empty-line': ['br'],
                }],
                'subtitle': ['p', STYLE],
            }],
        })
        for (const child of node.children) if (child.nodeName === 'v') {
            el.append(this.doc.createTextNode(child.textContent))
            el.append(this.doc.createElement('br'))
        }
        return el
    }
    convert(node, def) {
        // not an element; return text content
        if (node.nodeType === 3) return this.doc.createTextNode(node.textContent)
        if (node.nodeType === 4) return this.doc.createCDATASection(node.textContent)
        if (node.nodeType === 8) return this.doc.createComment(node.textContent)

        const d = def?.[node.nodeName]
        if (!d) return null
        if (typeof d === 'string') return this[d](node)

        const [name, opts, attrs] = d
        const el = this.doc.createElement(name)

        // copy the ID, and set class name from original element name
        if (node.id) el.id = node.id
        el.classList.add(node.nodeName)

        // copy attributes
        if (Array.isArray(attrs)) for (const attr of attrs) {
            const value = node.getAttribute(attr)
            if (value) el.setAttribute(attr, value)
        }

        // process child elements recursively
        const childDef = opts === 'self' ? def : opts
        let child = node.firstChild
        while (child) {
            const childEl = this.convert(child, childDef)
            if (childEl) el.append(childEl)
            child = child.nextSibling
        }
        return el
    }
}

const parseXML = async blob => {
    const buffer = await blob.arrayBuffer()
    const str = new TextDecoder('utf-8').decode(buffer)
    const parser = new DOMParser()
    const doc = parser.parseFromString(str, MIME.XML)
    const encoding = doc.xmlEncoding
        // `Document.xmlEncoding` is deprecated, and already removed in Firefox
        // so parse the XML declaration manually
        || str.match(/^<\?xml\s+version\s*=\s*["']1.\d+"\s+encoding\s*=\s*["']([A-Za-z0-9._-]*)["']/)?.[1]
    if (encoding && encoding.toLowerCase() !== 'utf-8') {
        const str = new TextDecoder(encoding).decode(buffer)
        return parser.parseFromString(str, MIME.XML)
    }
    return doc
}

const style = URL.createObjectURL(new Blob([`
@namespace epub "http://www.idpf.org/2007/ops";
body > img, section > img {
    display: block;
    margin: auto;
}
.title h1 {
    text-align: center;
}
body > section > .title,
body:not(.notesBodyType) > .title,
body:not(.notesBodyType) > .epigraph {
    margin: 1.5em 0 1em;
}
body.notesBodyType > .title,
body.notesBodyType > section .title {
    margin: 1em 0;
}
body.notesBodyType > section .title h1 {
    text-align: start;
}
p {
    text-indent: 1em;
    margin: 0;
}
:not(p) + p, p:first-child {
    text-indent: 0;
}
.poem p {
    text-indent: 0;
    margin: 1em 0;
}
.text-author, .date {
    text-align: end;
}
.text-author:before {
    content: "—";
}
table {
    border-collapse: collapse;
}
td, th {
    padding: .25em;
}
a[epub|type~="noteref"] {
    font-size: .75em;
    vertical-align: super;
}
`], { type: 'text/css' }))

const escapeXmlAttr = s => String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')

const template = html => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
    <head><link href="${style}" rel="stylesheet" type="text/css"/></head>
    <body>${html}</body>
</html>`

/** Второй body в FB2 (примечания): outerHTML вставлял вложенный body в шаблон — невалидный XHTML, ломались id и стили. */
const templateBodySection = bodyEl => {
    const cls = bodyEl.className?.trim?.()
    const clsAttr = cls ? ` class="${escapeXmlAttr(cls)}"` : ''
    return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
    <head><link href="${style}" rel="stylesheet" type="text/css"/></head>
    <body${clsAttr}>${bodyEl.innerHTML}</body>
</html>`
}

// name of custom ID attribute for TOC items
const dataID = 'data-foliate-id'

export const makeFB2 = async blob => {
    const book = {}
    const doc = await parseXML(blob)
    const converter = new FB2Converter(doc)

    const $ = x => doc.querySelector(x)
    const $$ = x => [...doc.querySelectorAll(x)]
    const getPerson = el => {
        const nick = getElementText(el.querySelector('nickname'))
        if (nick) return nick
        const first = getElementText(el.querySelector('first-name'))
        const middle = getElementText(el.querySelector('middle-name'))
        const last = getElementText(el.querySelector('last-name'))
        const name = [first, middle, last].filter(x => x).join(' ')
        const sortAs = last
            ? [last, [first, middle].filter(x => x).join(' ')].join(', ')
            : null
        return { name, sortAs }
    }
    const getDate = el => el?.getAttribute('value') ?? getElementText(el)
    const annotation = $('title-info annotation')
    book.metadata = {
        title: getElementText($('title-info book-title')),
        identifier: getElementText($('document-info id')),
        language: getElementText($('title-info lang')),
        author: $$('title-info author').map(getPerson),
        translator: $$('title-info translator').map(getPerson),
        contributor: $$('document-info author').map(getPerson)
            // techincially the program probably shouldn't get the `bkp` role
            // but it has been so used by calibre, so ¯\_(ツ)_/¯
            .concat($$('document-info program-used').map(getElementText))
            .map(x => Object.assign(typeof x === 'string' ? { name: x } : x,
                { role: 'bkp' })),
        publisher: getElementText($('publish-info publisher')),
        published: getDate($('title-info date')),
        modified: getDate($('document-info date')),
        description: annotation ? converter.convert(annotation,
            { annotation: ['div', SECTION] }).innerHTML : null,
        subject: $$('title-info genre').map(getElementText),
    }
    if ($('coverpage image')) {
        const src = converter.getImageSrc($('coverpage image'))
        book.getCover = () => fetch(src).then(res => res.blob())
    } else book.getCover = () => null

    // get convert each body
    const bodyData = Array.from(doc.querySelectorAll('body'), body => {
        const converted = converter.convert(body, { body: ['body', BODY] })
        return [Array.from(converted.children, el => {
            // get list of IDs in the section
            const ids = [el, ...el.querySelectorAll('[id]')].map(el => el.id)
            return { el, ids }
        }), converted]
    })

    /**
     * Paper-book flow: the fiction body used to be stitched into ONE Foliate
     * document so the next chapter could start on the same page. On large books
     * that made the paginator lay out the whole book up front — a 3.3 MB novel
     * took ~43 s before the first page appeared.
     *
     * Now the body is split into buckets of whole top-level blocks, and the
     * paginator lays out one bucket at a time, so reading starts in seconds.
     * Buckets are byte-bounded so a single huge chapter still splits, and they
     * never break a chapter unless the chapter itself exceeds the limit.
     */
    const STITCH_MAX_BYTES = 220 * 1024
    const blockBytes = (el) => {
        try { return (el.outerHTML || '').length } catch { return 0 }
    }
    const stitchFictionEls = (parts) => {
        const els = parts.map(({ el }) => el).filter(Boolean)
        if (!els.length) return []
        const total = els.reduce((sum, el) => sum + blockBytes(el), 0)
        if (total <= STITCH_MAX_BYTES) {
            if (els.length === 1) return [els[0]]
            const single = els[0].ownerDocument.createElement('div')
            single.classList.add('fb2-body')
            for (const el of els) single.appendChild(el)
            return [single]
        }
        const buckets = []
        let current = null
        for (const el of els) {
            const size = blockBytes(el)
            const fits = current && current.bytes + size <= STITCH_MAX_BYTES
            /* A chapter that alone exceeds the limit still goes into its own
               bucket; it simply cannot be split here. */
            if (!fits) {
                current = { bytes: 0, els: [], wrap: null }
                buckets.push(current)
            }
            if (!current.wrap) {
                current.wrap = el.ownerDocument.createElement('div')
                current.wrap.classList.add('fb2-body')
            }
            current.wrap.appendChild(el)
            current.bytes += size
        }
        return buckets.map(b => b.wrap)
    }
    const collectChapterTitles = (root) => {
        const titles = []
        const visit = (el) => {
            if (!el?.children) return
            for (const child of el.children) {
                if (child.classList?.contains('title')) {
                    const index = titles.length
                    child.setAttribute(dataID, index)
                    titles.push({ title: getElementText(child), index })
                    continue
                }
                if (child.localName === 'section') visit(child)
            }
        }
        visit(root)
        return titles
    }

    const urls = []
    const fictionEls = stitchFictionEls(bodyData[0]?.[0] ?? [])
    const fictionBuckets = fictionEls.map(el => ({
        ids: [el, ...el.querySelectorAll('[id]')].map(node => node.id),
        titles: collectChapterTitles(el),
        el,
    }))
    const sectionData = [
        ...fictionBuckets,
        ...bodyData.slice(1).map(([sections, body]) => {
            const ids = sections.map(s => s.ids).flat()
            body.classList.add('notesBodyType')
            return { ids, el: body, linear: 'no' }
        }),
    ]
        .map(({ ids, titles, el, linear }) => {
            const str = el.localName === 'body' ? templateBodySection(el) : template(el.outerHTML)
            const blob = new Blob([str], { type: MIME.XHTML })
            const url = URL.createObjectURL(blob)
            urls.push(url)
            const title = normalizeWhitespace(
                el.querySelector('.title, .subtitle, p')?.textContent
                ?? (el.classList.contains('title') ? el.textContent : ''))
            // Прогресс по объёму текста, не по байтам XHTML (иначе титул/оглавление FB2
            // съедают ползунок — см. foliate-js SectionProgress.size).
            const textLen = countSectionText(el)
            const imageOnly = el.classList.contains('image')
                && !el.querySelector('section, p, blockquote, table, header')
            const linearNo = linear === 'no' || imageOnly || textLen === 0
            const size = linearNo ? 0 : Math.max(1, textLen)
            return {
                ids, title, titles, load: () => url,
                createDocument: () => new DOMParser().parseFromString(str, MIME.XHTML),
                size,
                linear: linearNo ? 'no' : linear,
            }
        })

    const idMap = new Map()
    book.sections = sectionData.map((section, index) => {
        const { ids, load, createDocument, size, linear } = section
        for (const id of ids) if (id) idMap.set(id, index)
        return { id: index, load, createDocument, size, linear }
    })

    book.toc = sectionData.flatMap(({ title, titles }, index) => {
        const href = index.toString()
        if (titles?.length) {
            return titles.map(({ title: label, index: tid }) => ({
                label,
                href: `${href}#${tid}`,
                subitems: null,
            }))
        }
        return title ? [{ label: title, href, subitems: null }] : []
    }).filter(item => item.label)

    book.resolveHref = href => {
        let h = typeof href === 'string' ? href.trim() : ''
        if (h.startsWith('blob:')) {
            try {
                const u = new URL(h)
                if (u.hash) h = u.hash
            } catch { /* keep h */ }
        }
        const hashPos = h.indexOf('#')
        const before = hashPos === -1 ? h : h.slice(0, hashPos)
        const id = hashPos === -1 ? '' : h.slice(hashPos + 1)
        /* TOC: "0", "1#2" — не путать с blob:http…#note (Number("blob:…") === NaN). */
        if (before && !before.startsWith('blob:') && !Number.isNaN(Number(before))) {
            if (id === '') return { index: Number(before), anchor: () => 0 }
            return { index: Number(before), anchor: doc => doc.querySelector(`[${dataID}="${id}"]`) }
        }
        const ix = idMap.get(id)
        if (ix === undefined) return null
        return { index: ix, anchor: doc => doc.getElementById(id) }
    }
    book.splitTOCHref = href => href?.split('#')?.map(x => Number(x)) ?? []
    book.getTOCFragment = (doc, id) => doc.querySelector(`[${dataID}="${id}"]`)

    book.destroy = () => {
        for (const url of urls) URL.revokeObjectURL(url)
    }
    book.isFB2 = true
    return book
}
