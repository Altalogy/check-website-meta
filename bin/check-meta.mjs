#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { auditPages, checkImages } from '../src/index.mjs'

const USAGE = `check-meta — find pages with missing or broken meta and social tags

  check-meta --dir <built-dir>     read built HTML from disk (Astro, static exports)
  check-meta --url <base-url>      crawl a running server through its sitemap.xml

Options:
  --check-images   also request each distinct og:image and fail when one does not resolve
  --json           print the full report as JSON
  --help           show this

Exit codes: 0 no errors · 1 at least one error · 2 wrong arguments or nothing to check`

const fail = (message) => {
  console.error(`check-meta: ${message}`)
  process.exit(2)
}

let values
try {
  ;({ values } = parseArgs({
    options: {
      dir: { type: 'string' },
      url: { type: 'string' },
      'check-images': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }))
} catch (err) {
  fail(err.message)
}

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (Boolean(values.dir) === Boolean(values.url)) fail('pass either --dir <built-dir> or --url <base-url>')

/** Built HTML on disk → routes. */
async function fromDir(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name))

  return Promise.all(
    files.map(async (file) => ({
      route:
        '/' +
        relative(dir, file).split(sep).join('/').replace(/index\.html$/, '').replace(/\.html$/, ''),
      html: await readFile(file, 'utf8'),
    })),
  )
}

const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].trim())

async function text(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return res.text()
}

/** Running server → routes, found through its own sitemap. */
async function fromUrl(base) {
  const found = locs(await text(new URL('/sitemap.xml', base)))
  if (found.length === 0) throw new Error(`no <loc> entries in ${base}/sitemap.xml`)

  // A sitemap index lists other .xml files, not pages. Follow them one level down.
  const routes = found.filter((loc) => !loc.endsWith('.xml'))
  for (const loc of found.filter((loc) => loc.endsWith('.xml'))) {
    routes.push(...locs(await text(new URL(new URL(loc).pathname, base))))
  }

  return Promise.all(
    routes.map(async (loc) => {
      const url = new URL(loc)
      // The sitemap names the production host; fetch the same path from the server given.
      return { route: url.pathname, html: await text(new URL(url.pathname + url.search, base)) }
    }),
  )
}

let pages
try {
  pages = values.dir ? await fromDir(values.dir) : await fromUrl(values.url)
} catch (err) {
  fail(err.message)
}
if (pages.length === 0) fail('no pages found')

const report = auditPages(pages)
const imageIssues = values['check-images'] ? await checkImages(report) : []
const errorCount = report.errorCount + imageIssues.length

if (values.json) {
  console.log(JSON.stringify({ ...report, imageIssues, errorCount, ok: errorCount === 0 }, null, 2))
} else {
  for (const page of report.pages) {
    if (page.issues.length === 0) continue
    console.log(`\n${page.route}`)
    for (const issue of page.issues) {
      console.log(`  ${issue.severity === 'error' ? '✗' : '⚠'} ${issue.rule}: ${issue.message}`)
    }
  }
  if (imageIssues.length) {
    console.log('\nimages')
    for (const issue of imageIssues) console.log(`  ✗ ${issue.message}`)
  }
  console.log(`\n${pages.length} pages · ${errorCount} errors · ${report.warnCount} warnings`)
}

process.exit(errorCount > 0 ? 1 : 0)
