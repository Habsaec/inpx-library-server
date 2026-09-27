const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import {
    AnnotationLayer,
    GlobalWorkerOptions,
    PDFDataRangeTransport,
    TextLayer,
    getDocument,
} from './vendor/pdfjs/pdf.mjs'

GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')

const fetchText = async url => await (await fetch(url)).text()
const textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))
const annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))

const render = async (page, doc, zoom) => {
    const dpr = globalThis.devicePixelRatio || 1
    const scale = zoom * dpr
    doc.documentElement.style.transform = `scale(${1 / dpr})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const viewport = page.getViewport({ scale })

    // canvas must live in PDFDocument.ownerDocument (fonts are loaded there)
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport }).promise
    doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))

    const container = doc.querySelector('.textLayer')
    try {
        const textLayer = new TextLayer({
            textContentSource: await page.streamTextContent(),
            container,
            viewport,
        })
        await textLayer.render()
        for (const hidden of document.querySelectorAll('.hiddenCanvasElement')) {
            Object.assign(hidden.style, {
                position: 'absolute',
                top: '0',
                left: '0',
                width: '0',
                height: '0',
                display: 'none',
            })
        }
        const endOfContent = document.createElement('div')
        endOfContent.className = 'endOfContent'
        container.append(endOfContent)
        container.onpointerdown = () => container.classList.add('selecting')
        container.onpointerup = () => container.classList.remove('selecting')
    } catch (err) {
        console.warn(err)
    }

    try {
        const div = doc.querySelector('.annotationLayer')
        const linkService = {
            goToDestination: () => {},
            getDestinationHash: dest => JSON.stringify(dest),
            addLinkAttributes: (link, url) => { link.href = url },
        }
        await new AnnotationLayer({ page, viewport, div, linkService })
            .render({ annotations: await page.getAnnotations() })
    } catch (err) {
        console.warn(err)
    }
}

const renderPage = async (page, getImageBlob) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
        return new Promise(resolve => canvas.toBlob(resolve))
    }
    const src = URL.createObjectURL(new Blob([`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
<style>
html, body { margin: 0; padding: 0; }
:root {
  --user-unit: 1;
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
}
${textLayerBuilderCSS}
${annotationLayerBuilderCSS}
</style>
</head>
<body>
<div id="canvas"></div>
<div class="textLayer"></div>
<div class="annotationLayer"></div>
</body>
</html>`], { type: 'text/html' }))
    return { src, onZoom: ({ doc, scale }) => render(page, doc, scale) }
}

const makeTOCItem = item => ({
    label: item.title,
    href: JSON.stringify(item.dest),
    subitems: item.items?.length ? item.items.map(makeTOCItem) : null,
})

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function textLines(items) {
    const rows = []
    for (const item of items) {
        const str = item.str
        if (!str) continue
        const x = item.transform[4]
        const y = item.transform[5]
        const fontSize = Math.max(1, Math.hypot(item.transform[2], item.transform[3]) || item.height || 12)
        let row = rows.find(entry => Math.abs(entry.y - y) < fontSize * 0.45)
        if (!row) {
            row = { y, fontSize, x, parts: [] }
            rows.push(row)
        }
        row.fontSize = Math.max(row.fontSize, fontSize)
        row.parts.push({ x, str, fontSize, width: item.width || str.length * fontSize * 0.5 })
    }
    rows.sort((a, b) => b.y - a.y)
    return rows.map(row => {
        row.parts.sort((a, b) => a.x - b.x)
        let text = ''
        let right = null
        for (const part of row.parts) {
            if (right != null && part.x - right > part.fontSize * 0.18
                && text && !text.endsWith(' ') && !part.str.startsWith(' ')) text += ' '
            text += part.str
            right = part.x + part.width
        }
        return {
            y: row.y,
            x: row.parts[0]?.x ?? 0,
            fontSize: row.fontSize,
            text: text.replace(/\s+/g, ' ').trim(),
        }
    }).filter(line => line.text)
}

function joinHyphen(prev, next) {
    if (/-$/.test(prev) && /^[a-zа-яё]/i.test(next)) return prev.slice(0, -1) + next
    return `${prev} ${next}`
}

function linesToParas(lines) {
    const paras = []
    let buf = ''
    let prev = null
    for (const line of lines) {
        const gap = prev ? prev.y - line.y : 0
        const newPara = prev && (gap > prev.fontSize * 1.4 || line.x > prev.x + prev.fontSize * 1.6)
        if (newPara && buf) {
            paras.push(buf)
            buf = line.text
        } else buf = buf ? joinHyphen(buf, line.text) : line.text
        prev = line
    }
    if (buf) paras.push(buf)
    return paras
}

async function pageImageHtml(page) {
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(1.6, 900 / Math.max(1, base.width))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    const src = canvas.toDataURL('image/jpeg', 0.86)
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><img src="${src}" alt=""></body></html>`
}

function pageTextHtml(paras) {
    const html = paras.map(part => `<p>${escapeHtml(part)}</p>`).join('')
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      img { display: block; width: 100%; height: auto; }
    </style></head><body>${html}</body></html>`
}

async function loadReflowPage(page) {
    const content = await page.getTextContent()
    const paras = linesToParas(textLines(content.items || []))
    const text = paras.join(' ').trim()
    if (text.length < 40) return { html: await pageImageHtml(page), size: 800 }
    return { html: pageTextHtml(paras), size: Math.max(1, text.length) }
}

function pageBook(pdf) {
    const book = { rendition: { layout: 'pre-paginated', spread: 'none' }, pdfMode: 'page' }
    const cache = new Map()
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) return cached
            const url = await renderPage(await pdf.getPage(i + 1))
            cache.set(i, url)
            return url
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        const asIndex = Number(href)
        if (Number.isInteger(asIndex) && asIndex >= 0) return { index: asIndex }
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        const asIndex = Number(href)
        if (Number.isInteger(asIndex) && asIndex >= 0) return [asIndex, null]
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return [index, null]
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.destroy = () => pdf.destroy()
    return book
}

function reflowBook(pdf) {
    const book = { rendition: { layout: 'reflowable' }, pdfMode: 'reflow' }
    const cache = new Map()
    const urls = []
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) return cached
            const { html, size } = await loadReflowPage(await pdf.getPage(i + 1))
            const src = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
            urls.push(src)
            const value = src
            book.sections[i].size = size
            cache.set(i, value)
            return value
        },
        size: 1200,
        linear: 'yes',
    }))
    book.resolveHref = async href => {
        const asIndex = Number(href)
        if (Number.isInteger(asIndex) && asIndex >= 0) return { index: asIndex }
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        const asIndex = Number(href)
        if (Number.isInteger(asIndex) && asIndex >= 0) return [asIndex, null]
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return [index, null]
    }
    book.getTOCFragment = doc => doc.documentElement
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.destroy = () => {
        for (const url of urls) URL.revokeObjectURL(url)
        pdf.destroy()
    }
    return book
}

async function attachMeta(book, pdf) {
    const { metadata, info } = await pdf.getMetadata() ?? {}
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }
    book.toc = (await pdf.getOutline())?.map(makeTOCItem)
    return book
}

export const makePDF = async (file, options = {}) => {
    const transport = new PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await getDocument({
        range: transport,
        cMapUrl: pdfjsPath('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        wasmUrl: pdfjsPath('wasm/'),
        isEvalSupported: false,
    }).promise
    const book = options.pdfReflow ? reflowBook(pdf) : pageBook(pdf)
    return attachMeta(book, pdf)
}
