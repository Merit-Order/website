# Contributing to Merit Order

Thanks for helping. This page covers setup, the checks CI runs, what a pull request needs, and the sign-off.

Read [README.md](README.md) and [docs/00-how-it-all-works.md](docs/00-how-it-all-works.md) first, then the doc for
the area you're changing. [docs/09-decisions.md](docs/09-decisions.md) explains past choices; if your change
reverses one, say so in the pull request.

## Setup

You need Python 3.12 or newer with [uv](https://docs.astral.sh/uv/), and Node.js 26 for the console (`ui/`).

```bash
git clone https://github.com/Merit-Order/meritorder && cd meritorder
uv sync                      # the gateway and its dev dependencies, from uv.lock
cd ui && npm ci              # the console's dependencies, from package-lock.json (install scripts are off)
```

No provider keys are needed for development: the tests mock every provider.

## Tests and coverage

```bash
uv run pytest -q                                      # everything; in-memory state and storage
uv run pytest -q --cov --cov-fail-under=95            # what CI runs: it fails below 95% coverage
```

Tests that need Redis, Postgres or ClickHouse skip unless you point them at throwaway instances (they are wiped
before each test). CI always runs them:

```bash
MERITORDER_TEST_REDIS_URL=redis://localhost:6379/15 \
MERITORDER_TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5432/motest \
uv run pytest -q --cov
```

New code needs tests. Mock external services (the existing tests use `httpx.MockTransport`); a test must never
call a real LLM provider or cloud API.

## Console checks

```bash
cd ui
npx tsc --noEmit && npx tsc --noEmit -p e2e   # types, for the app and the browser tests
npm run build                                 # builds into src/meritorder/ui_dist, served at /ui/
npx playwright install chromium
E2E_DATABASE_URL=postgresql://postgres:pw@localhost:5432/e2etest npm run e2e   # browser tests, need Postgres
```

Keep the Playwright tests in `ui/e2e/` in step with console changes.

## Docs

The docs are Markdown in `docs/`. Update the doc for your area so it describes the code as it now is. The HTML
pages in `docs/html/` are generated; maintainers rebuild them, so leave them out of your pull request. To preview:

```bash
uv run --with markdown python scripts/build_docs_html.py
```

## Pull requests

- One topic per pull request. Say what changed and why, and what you couldn't test (for example, anything that
  needs a live cloud account).
- All CI checks must pass: Python tests with coverage, `pip-audit`, the console build and `npm audit`, the Helm
  chart render, the Docker Compose smoke test, and the console browser tests.
- A new dependency needs a written reason in the pull request (see [SECURITY.md](SECURITY.md)).
- Match the code around you: type hints, docstrings that say why, and lines up to about 150 characters.
- Leave `CHANGELOG.md` to the maintainers; suggest an entry in the pull request instead.
- Report security problems privately, as [SECURITY.md](SECURITY.md) describes, not in a pull request or issue.

## Sign-off (DCO)

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/):
by adding the line, you certify that you wrote the change or have the right to submit it under the project's
license. Sign off with `-s`:

```bash
git commit -s -m "Explain what changed"
```

This adds `Signed-off-by: Your Name <you@example.com>` to the message, using your git `user.name` and
`user.email`. To sign off commits you've already made on a branch: `git rebase --signoff origin/main`.

The project may later ask contributors to sign a Contributor License Agreement (CLA) as well.

## License

Merit Order is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). By
contributing, you agree that your contributions are licensed under the same terms.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
