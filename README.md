# Merit Order website

The website for [Merit Order](https://github.com/Merit-Order/meritorder), a self-hosted LLM gateway, served at
**https://meritorder.dev**. The static console demo at **https://dev.meritorder.dev** is built separately.

Astro, with Starlight for the docs. No analytics, no trackers, no cookies; fonts (Geist and Geist Mono, SIL OFL 1.1)
are served from the site itself.

## The docs and numbers come from the main repo

The main repo stays the source. `snapshot/` holds a copy of what the site is built from, so a build needs no access to
it: `snapshot/meritorder/` (the docs, README, roadmap, changelog, contributing and security pages, the price list and
configuration) and `snapshot/routing-sim.json` (the routing simulator's results). `npm run refresh` rewrites both from a
checkout of the main repo; CI does the same before building on main whenever it can read the main repo.

- `scripts/refresh.mjs` copies the files and runs the main repo's routing simulator (`scripts/routing_sim.py`, no model
  calls, no spend, about two minutes) twice: the standard 2,000-task population, and 2,000 coding-only tasks (Claude
  Code 75%, a small agent such as Codex 15%, chat with code 10%) that the site scales to 10 developers, 8 tasks a day,
  21 working days (1,680 tasks a month). **Every savings and comparison number on the site comes from that file**
  (`src/lib/sim.js`, `src/lib/numbers.js`); the calculator on the Savings page scales the same results to a team's
  task count and price per failed attempt. The other mechanisms' worked examples (caching, sticky sessions, compression,
  batch, GPUs, budgets) are list-price arithmetic on the price list, and say so.
- `scripts/sync-docs.mjs` runs before every build and turns `snapshot/meritorder/` (or `MERITORDER_REPO`, a path or a
  git URL, with `MERITORDER_REF` for a branch or tag) into pages, in the reading order of `docs/README.md`. Links
  between those files are rewritten to site routes; links to anything else go to GitHub (`Merit-Order/meritorder`). An
  anchor that names no heading, where exactly one heading starts with it, is relinked with a warning: fix the source.
  Mermaid diagrams are rendered once, at build time, to inline SVG (Playwright's Chromium), coloured with CSS variables.
  `config/` is exported to `public/data/pricing.json`.
- `scripts/csp.mjs` runs after the build and gives each page a meta Content-Security-Policy with the hashes of its inline
  scripts (see `deploy/aws/README.md`).

## Work on it

Needs Node 22.23.4 or later (`.nvmrc`).

```bash
npm ci
npx playwright install chromium        # renders the diagrams
npm run dev                             # from snapshot/
MERITORDER_REPO=../meritorder npm run refresh   # needs uv; then commit snapshot/
npm run build                           # sync + build into dist/, with the Pagefind search index
npm run preview                         # serve dist/ at http://localhost:4321
npm run check:links                     # internal links and anchors; add -- --external for the rest
npm run shots                           # every page, light and dark, 1440px and 375px, into shots/
```

Pages outside the docs are in `src/pages/` (`index`, `how-it-works`, `savings`, `compare`, `demo`). The design tokens
(direction B, "Clean technical") are in `src/styles/tokens.css`; Starlight is themed to match in
`src/styles/starlight.css`. The Compare page reads its table, notes and date from the feature sheet at build time.

## Deploying

https://meritorder.dev is served from S3 and CloudFront in Merit Order's AWS account (stack `meritorder-website`,
`deploy/aws/website.yaml`; [deploy/aws/README.md](deploy/aws/README.md) has the details, the role's trust and costs).

`.github/workflows/deploy.yml` builds and checks links on every pull request (from the committed snapshot, no deploy),
and on main (push, every day at 06:17 UTC, by hand, and on a `repository_dispatch` of type `docs-updated` from the main
repo) also refreshes from the main repo when it can read it, then uploads to S3 through GitHub's OIDC and invalidates
CloudFront. The main repo triggers it with:

```bash
gh api repos/Merit-Order/website/dispatches -f event_type=docs-updated
```

That call needs a token with write access to this repo's contents (a fine-grained token with Contents: read and
write on `Merit-Order/website`), in the main repo's workflow.

Refreshing needs to read the main repo. Once `Merit-Order/meritorder` is public it just works. While it is private,
add a read-only token as the `MERITORDER_REPO_TOKEN` secret (a fine-grained token with Contents: read on the main repo);
without it, main builds use the committed snapshot and say so. Delete the secret once the repo is public.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions need a signed [Contributor License Agreement](CLA.md).

## License

AGPL-3.0-only, like Merit Order. Geist and Geist Mono are under the SIL Open Font License 1.1.
