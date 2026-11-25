import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RULES, auditPage, auditPages, checkImages, extractMeta } from '../src/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(here, '../bin/check-meta.mjs')
const SITE = path.join(here, 'fixtures/site')

const page = (head, body = '<h1>One</h1>') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const GOOD = page(`
  <title>Acme — tools for small teams</title>
  <meta name="description" content="Acme builds calm, reliable tools that help small teams plan their week.">
  <link rel="canonical" href="https://acme.example/">
  <meta property="og:title" content="Acme">
  <meta property="og:description" content="Calm tools.">
  <meta property="og:image" content="https://acme.example/og.png">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">`)

const ids = (report) => report.issues.map((issue) => issue.rule)

test('extractMeta reads title, description, canonical, og and twitter tags', () => {
  const meta = extractMeta(GOOD)
  assert.equal(meta.title, 'Acme — tools for small teams')
  assert.equal(meta.canonical, 'https://acme.example/')
  assert.equal(meta.og['og:image'], 'https://acme.example/og.png')
  assert.equal(meta.twitter['twitter:card'], 'summary_large_image')
  assert.equal(meta.h1Count, 1)
})

test('a complete page has no issues', () => {
  assert.deepEqual(auditPage({ route: '/', html: GOOD }).issues, [])
})

test('an empty head fails every error rule', () => {
  const report = auditPage({ route: '/', html: page('', '') })
  const errors = report.issues.filter((issue) => issue.severity === 'error').map((i) => i.rule)
  assert.deepEqual(errors, ['title', 'description', 'canonical', 'og:title', 'og:description', 'og:image'])
})

test('length limits and relative URLs are reported', () => {
  const html = page(`
    <title>${'x'.repeat(61)}</title>
    <meta name="description" content="Too short">
    <link rel="canonical" href="/about">
    <meta property="og:image" content="/og.png">`)
  const messages = auditPage({ route: '/', html }).issues.map((issue) => issue.message)
  assert.ok(messages.includes('title is 61 chars (max 60)'))
  assert.ok(messages.includes('description is only 9 chars'))
  assert.ok(messages.includes('canonical must be absolute (got "/about")'))
  assert.ok(messages.includes('og:image must be absolute (got "/og.png")'))
})

test('noindex and a wrong h1 count are warnings, not errors', () => {
  const html = GOOD.replace('<title>', '<meta name="robots" content="noindex, follow"><title>').replace(
    '<h1>One</h1>',
    '<h1>One</h1><h1>Two</h1>',
  )
  const report = auditPages([{ route: '/', html }])
  assert.deepEqual(ids(report.pages[0]), ['h1', 'noindex'])
  assert.equal(report.errorCount, 0)
  assert.equal(report.warnCount, 2)
  assert.equal(report.ok, true)
})

test('auditPages sorts by route and takes custom rules', () => {
  const rules = RULES.filter((rule) => rule.id === 'title')
  const report = auditPages(
    [
      { route: '/b', html: page('') },
      { route: '/a', html: GOOD },
    ],
    rules,
  )
  assert.deepEqual(report.pages.map((p) => p.route), ['/a', '/b'])
  assert.equal(report.errorCount, 1)
})

test('checkImages reports an unreachable image once, and retries a 405 with GET', async () => {
  const calls = []
  const fetcher = async (url, { method }) => {
    calls.push(`${method} ${url}`)
    if (url.endsWith('missing.png')) return { ok: false, status: 404 }
    if (url.endsWith('nohead.png') && method === 'HEAD') return { ok: false, status: 405 }
    return { ok: true, status: 200 }
  }
  const withImage = (image) => GOOD.replace('https://acme.example/og.png', image)
  const report = auditPages([
    { route: '/a', html: withImage('https://x.example/missing.png') },
    { route: '/b', html: withImage('https://x.example/missing.png') },
    { route: '/c', html: withImage('https://x.example/nohead.png') },
  ])

  const issues = await checkImages(report, fetcher)
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /unreachable \(404\): https:\/\/x\.example\/missing\.png/)
  assert.ok(calls.includes('GET https://x.example/nohead.png'))
  assert.equal(calls.filter((call) => call.includes('missing.png')).length, 1)
})

test('--dir: routes come from file paths, exit 1 on errors', () => {
  const run = spawnSync('node', [BIN, '--dir', SITE, '--json'], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  const report = JSON.parse(run.stdout)
  assert.deepEqual(report.pages.map((p) => p.route), ['/', '/about/', '/broken/'])
  assert.deepEqual(report.pages[0].issues, [])
  assert.equal(report.ok, false)
})

test('wrong arguments exit 2', () => {
  assert.equal(spawnSync('node', [BIN]).status, 2)
  assert.equal(spawnSync('node', [BIN, '--dir', 'a', '--url', 'b']).status, 2)
  assert.equal(spawnSync('node', [BIN, '--dir', path.join(here, 'nope')]).status, 2)
})

test('--url: follows a sitemap index and fetches each path from the given server', async () => {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    const xml = (body) => res.setHeader('content-type', 'application/xml').end(body)
    if (req.url === '/sitemap.xml') {
      return xml('<sitemapindex><sitemap><loc>https://acme.example/sitemap-0.xml</loc></sitemap></sitemapindex>')
    }
    if (req.url === '/sitemap-0.xml') {
      return xml('<urlset><url><loc>https://acme.example/</loc></url><url><loc>https://acme.example/pricing</loc></url></urlset>')
    }
    if (req.url === '/' || req.url === '/pricing') return res.end(GOOD)
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve) => server.listen(0, resolve))
  const base = `http://localhost:${server.address().port}`

  const { status, stdout } = await new Promise((resolve) => {
    const child = spawn('node', [BIN, '--url', base])
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('close', (code) => resolve({ status: code, stdout: out }))
  })
  server.close()

  assert.equal(status, 0)
  assert.match(stdout, /2 pages · 0 errors · 0 warnings/)
  assert.deepEqual(hits.slice(0, 2), ['/sitemap.xml', '/sitemap-0.xml'])
  assert.deepEqual(hits.slice(2).sort(), ['/', '/pricing'])
})
