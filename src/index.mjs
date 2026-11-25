import { parseHTML } from 'linkedom'

/**
 * @typedef {'error' | 'warn'} Severity
 * @typedef {{ title: string | null, description: string | null, canonical: string | null,
 *   robots: string | null, h1Count: number, og: Record<string, string>,
 *   twitter: Record<string, string> }} PageMeta
 * @typedef {{ rule: string, severity: Severity, message: string }} Issue
 * @typedef {{ route: string, html: string }} PageInput
 * @typedef {{ route: string, meta: PageMeta, issues: Issue[] }} PageReport
 * @typedef {{ pages: PageReport[], errorCount: number, warnCount: number, ok: boolean }} Report
 * @typedef {{ id: string, severity: Severity, check: (meta: PageMeta) => string | null }} Rule
 */

/**
 * Pull every meta signal out of a rendered page.
 * @param {string} html
 * @returns {PageMeta}
 */
export function extractMeta(html) {
  const { document } = parseHTML(html)

  const attr = (selector, name) =>
    document.querySelector(selector)?.getAttribute(name)?.trim() || null

  const collect = (prefix) => {
    const out = {}
    const nodes = document.querySelectorAll(
      `meta[property^="${prefix}"], meta[name^="${prefix}"]`,
    )
    for (const el of nodes) {
      const key = el.getAttribute('property') ?? el.getAttribute('name')
      const value = el.getAttribute('content')?.trim()
      if (key && value) out[key] = value
    }
    return out
  }

  return {
    title: document.querySelector('title')?.textContent?.trim() || null,
    description: attr('meta[name="description"]', 'content'),
    canonical: attr('link[rel="canonical"]', 'href'),
    robots: attr('meta[name="robots"]', 'content'),
    h1Count: document.querySelectorAll('h1').length,
    og: collect('og:'),
    twitter: collect('twitter:'),
  }
}

const isAbsolute = (url) => /^https?:\/\//i.test(url)

/**
 * The default standard. A rule returns a message when it is violated, null when it passes.
 * Pass your own array to auditPage / auditPages to change it.
 * @type {Rule[]}
 */
export const RULES = [
  {
    id: 'title',
    severity: 'error',
    check: (m) =>
      !m.title
        ? 'missing <title>'
        : m.title.length > 60
          ? `title is ${m.title.length} chars (max 60)`
          : m.title.length < 10
            ? `title is only ${m.title.length} chars`
            : null,
  },
  {
    id: 'description',
    severity: 'error',
    check: (m) =>
      !m.description
        ? 'missing meta description'
        : m.description.length > 160
          ? `description is ${m.description.length} chars (max 160)`
          : m.description.length < 50
            ? `description is only ${m.description.length} chars`
            : null,
  },
  {
    id: 'canonical',
    severity: 'error',
    check: (m) =>
      !m.canonical
        ? 'missing <link rel="canonical">'
        : !isAbsolute(m.canonical)
          ? `canonical must be absolute (got "${m.canonical}")`
          : null,
  },
  {
    id: 'og:title',
    severity: 'error',
    check: (m) => (m.og['og:title'] ? null : 'missing og:title'),
  },
  {
    id: 'og:description',
    severity: 'error',
    check: (m) => (m.og['og:description'] ? null : 'missing og:description'),
  },
  {
    id: 'og:image',
    severity: 'error',
    check: (m) => {
      const image = m.og['og:image']
      if (!image) return 'missing og:image'
      if (!isAbsolute(image)) return `og:image must be absolute (got "${image}")`
      return null
    },
  },
  {
    id: 'og:type',
    severity: 'warn',
    check: (m) => (m.og['og:type'] ? null : 'missing og:type'),
  },
  {
    id: 'twitter:card',
    severity: 'warn',
    check: (m) => (m.twitter['twitter:card'] ? null : 'missing twitter:card'),
  },
  {
    id: 'h1',
    severity: 'warn',
    check: (m) =>
      m.h1Count === 1 ? null : m.h1Count === 0 ? 'no <h1>' : `${m.h1Count} <h1> elements`,
  },
  {
    id: 'noindex',
    severity: 'warn',
    check: (m) => (m.robots?.includes('noindex') ? 'page is noindex' : null),
  },
]

/**
 * @param {PageInput} page
 * @param {Rule[]} [rules]
 * @returns {PageReport}
 */
export function auditPage({ route, html }, rules = RULES) {
  const meta = extractMeta(html)
  const issues = []
  for (const rule of rules) {
    const message = rule.check(meta)
    if (message) issues.push({ rule: rule.id, severity: rule.severity, message })
  }
  return { route, meta, issues }
}

/**
 * No I/O: rendered HTML in, a report out.
 * @param {PageInput[]} inputs
 * @param {Rule[]} [rules]
 * @returns {Report}
 */
export function auditPages(inputs, rules = RULES) {
  const pages = inputs
    .map((input) => auditPage(input, rules))
    .sort((a, b) => a.route.localeCompare(b.route))
  const all = pages.flatMap((page) => page.issues)
  const errorCount = all.filter((issue) => issue.severity === 'error').length
  const warnCount = all.filter((issue) => issue.severity === 'warn').length
  return { pages, errorCount, warnCount, ok: errorCount === 0 }
}

/**
 * The one network step, kept apart from the pure core: confirm that each distinct
 * og:image resolves.
 * @param {Report} report
 * @param {typeof fetch} [fetcher]
 * @returns {Promise<Issue[]>}
 */
export async function checkImages(report, fetcher = fetch) {
  const urls = new Set(report.pages.map((page) => page.meta.og['og:image']).filter(Boolean))

  const results = await Promise.all(
    [...urls].map(async (url) => {
      try {
        let res = await fetcher(url, { method: 'HEAD' })
        if (res.status === 405) res = await fetcher(url, { method: 'GET' })
        return res.ok ? null : { url, status: res.status }
      } catch {
        return { url, status: 0 }
      }
    }),
  )

  return results.filter(Boolean).map((result) => ({
    rule: 'og:image',
    severity: 'error',
    message: `og:image unreachable (${result.status || 'network error'}): ${result.url}`,
  }))
}
