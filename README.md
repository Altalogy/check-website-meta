# check-website-meta

Find pages with missing or broken meta, Open Graph and Twitter tags, and fail CI before
they ship. Lighthouse checks `title`, `description` and `canonical` but skips `og:` and
`twitter:` tags; this covers both.

```text
/about/
  ✗ canonical: canonical must be absolute (got "/about")
  ⚠ twitter:card: missing twitter:card

/pricing/
  ✗ og:image: missing og:image

12 pages · 2 errors · 1 warnings
```

## Use

```bash
pnpm add -D github:Altalogy/check-website-meta
```

```bash
pnpm check-meta --dir dist                    # built HTML on disk
pnpm check-meta --url http://localhost:3000   # a running server, through its sitemap.xml
```

- `--check-images` also requests each `og:image` and fails when one does not resolve.
- `--json` prints the full report.
- Exit codes: `0` clean · `1` errors · `2` wrong arguments or no pages.

With `--url`, only pages in the sitemap are checked, and each is fetched from the server
you pass, not the production host the sitemap names. Needs Node 20.12 or newer.

## Rules

| Rule | Severity | Passes when |
| --- | --- | --- |
| `title` | error | Present, 10–60 characters |
| `description` | error | Present, 50–160 characters |
| `canonical` | error | Present and absolute |
| `og:title` | error | Present |
| `og:description` | error | Present |
| `og:image` | error | Present and absolute; resolves, with `--check-images` |
| `og:type` | warn | Present |
| `twitter:card` | warn | Present |
| `h1` | warn | Exactly one on the page |
| `noindex` | warn | The page is not `noindex` |

Warnings never fail the run.

## In CI

```yaml
- run: pnpm build
- run: pnpm start &
- run: npx wait-on http://localhost:3000
- run: pnpm check-meta --url http://localhost:3000 --check-images
```

## As a module

Optional. The core takes rendered HTML and returns a report, so you can pass your own rules:

```js
import { RULES, auditPages } from '@altalogy/check-website-meta'

const rules = RULES.filter((rule) => rule.id !== 'og:type')
const report = auditPages([{ route: '/', html }], rules)
// { pages: [{ route, meta, issues }], errorCount, warnCount, ok }
```

MIT
