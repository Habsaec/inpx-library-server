const CHAPTER = /^(?:глава|chapter|часть|пролог|эпилог|введение)\b.{0,120}$/i
const CHUNK = 40000

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function decodeText(buffer) {
    const bytes = new Uint8Array(buffer)
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return new TextDecoder('utf-8').decode(bytes.subarray(3))
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
        return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
        return new TextDecoder('utf-16be').decode(bytes.subarray(2))
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return new TextDecoder('windows-1251').decode(bytes)
    }
}

function chunkBody(body) {
    if (body.length <= CHUNK) return [body]
    const paras = body.split(/\n{2,}/)
    const out = []
    let cur = ''
    for (const para of paras) {
        const piece = para.length > CHUNK ? para.slice(0, CHUNK) : para
        if (cur && cur.length + piece.length + 2 > CHUNK) {
            out.push(cur)
            cur = piece
        } else cur = cur ? `${cur}\n\n${piece}` : piece
        if (para.length > CHUNK) {
            for (let i = CHUNK; i < para.length; i += CHUNK) {
                if (cur) out.push(cur)
                cur = para.slice(i, i + CHUNK)
            }
        }
    }
    if (cur) out.push(cur)
    return out
}

function splitText(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    const chapters = []
    let title = ''
    let buf = []
    const flush = () => {
        const body = buf.join('\n').trim()
        if (body || title) chapters.push({ title, body })
        buf = []
    }
    for (const line of lines) {
        const trimmed = line.trim()
        if (line.includes('\f') || CHAPTER.test(trimmed)) {
            flush()
            title = trimmed.replace(/\f/g, '')
            buf = title ? [title] : []
            continue
        }
        buf.push(line)
    }
    flush()
    const sections = []
    for (const chapter of chapters) {
        const parts = chunkBody(chapter.body || chapter.title || '')
        parts.forEach((body, i) => {
            sections.push({
                title: i === 0 ? chapter.title : '',
                body,
            })
        })
    }
    return sections.filter(section => section.body)
}

function sectionHtml(body) {
    const paras = body.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
    const html = (paras.length ? paras : [body]).map(part =>
        `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('')
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`
}

export const makeTXT = async file => {
    const text = decodeText(await file.arrayBuffer()).replace(/^\uFEFF/, '')
    const name = String(file.name || 'text').replace(/\.[^.]+$/, '') || 'text'
    const parts = splitText(text)
    const sections = parts.length ? parts : [{ title: '', body: '' }]
    const urls = []
    const book = {
        metadata: { title: name, language: /[а-яё]/i.test(text) ? 'ru' : 'en' },
    }
    book.sections = sections.map((section, index) => {
        const url = URL.createObjectURL(new Blob([sectionHtml(section.body || ' ')], { type: 'text/html' }))
        urls.push(url)
        return {
            id: index,
            load: () => url,
            size: Math.max(1, section.body.length),
            linear: 'yes',
        }
    })
    book.toc = sections.flatMap((section, index) =>
        section.title ? [{ label: section.title, href: String(index), subitems: null }] : [])
    book.resolveHref = href => {
        const index = Number(String(href ?? '').split('#')[0])
        if (!Number.isFinite(index)) return null
        return { index, anchor: () => 0 }
    }
    book.splitTOCHref = href => String(href ?? '').split('#').map(part => Number(part))
    book.getTOCFragment = () => null
    book.destroy = () => {
        for (const url of urls) URL.revokeObjectURL(url)
    }
    return book
}
