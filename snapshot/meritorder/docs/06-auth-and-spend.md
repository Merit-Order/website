# 06 — Auth & spend

This doc covers who can call the gateway (keys, sign-in, teams and roles) and how spend is limited
(budgets, caps, safeguards) and recorded (the ledger).

**What's been checked.** Token verification runs in CI with a real signing key: expired, forged,
wrong audience or issuer, algorithm confusion, and tokens shaped like Google's. Budgets, limits and
safeguards are tested in CI against both in-memory storage and real Redis and Postgres. Sign-in,
group mapping and SCIM have **not** been run against a real Entra tenant, and Google sign-in and
Google Groups have not been run against a real Workspace domain. Those calls are written from the
providers' docs and tested against mocks.

## Getting a key into pi and Claude Code

Harnesses can't do interactive SSO, so people log in once with the CLI and get a short-lived
**virtual key** tied to their identity. The harness sends it like any API key.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant CLI as meritorder CLI
    participant E as Entra ID or Google (OIDC)
    participant G as Gateway
    participant P as Postgres

    U->>CLI: meritorder login
    CLI->>E: Device-code flow
    E-->>U: "Go to microsoft.com/devicelogin (or google.com/device), enter code"
    U->>E: Signs in (MFA, conditional access)
    E-->>CLI: ID token (user, groups or verified email)
    CLI->>G: POST /auth/exchange
    G->>G: Verify JWT signature, issuer, audience (Google: domain, verified email)
    opt Google Groups on
        G->>E: Which groups is this person in? (Cloud Identity API)
    end
    G->>P: Map groups or email → team and role
    G->>P: Create virtual key (expires in 30 days)
    G-->>CLI: Virtual key
    CLI->>CLI: Save to ~/.config/meritorder/api_key (mode 600)
    U->>CLI: meritorder setup pi / setup claude-code
```

```bash
meritorder login --gateway https://llm.example.com    # or: meritorder use-key <key from an admin>
meritorder setup pi            # adds a "meritorder" provider to ~/.pi/agent/models.json
meritorder setup claude-code   # points Claude Code at the gateway, starting sessions on auto
meritorder setup claude-code --config-dir ~/.claude-meritorder   # …in a separate Claude Code profile
```

The key is saved to `~/.config/meritorder/api_key` (under `$XDG_CONFIG_HOME` when that's set), with
mode 600, next to `credentials.json`, which also records the gateway URL. Both harness configs read
the key file at request time (`!cat ...` for pi, `apiKeyHelper` for Claude Code), so logging in again
rotates the key without touching them. pi is configured to send its session ID as `x-session-id` and
to add cache breakpoints, which Merit Order uses for sticky routing and caching. `setup pi` keeps the
previous `models.json` as `models.json.bak`.

`setup claude-code` writes to Claude Code's settings file: `$CLAUDE_CONFIG_DIR/settings.json` when that's
set, else `~/.claude/settings.json`, or the folder given with `--config-dir` (then start Claude Code
with `CLAUDE_CONFIG_DIR=<folder> claude`). It sets:

| Setting | Value |
|---|---|
| `env.ANTHROPIC_BASE_URL` | the gateway |
| `apiKeyHelper` | `cat ~/.config/meritorder/api_key` |
| `model` | `auto` (`--model <name>` for another model `/v1/models` lists for your key; `--model none` leaves Claude Code's choice) |
| `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` | the gateway's context window for that model (from `/v1/models`; for `auto`, the largest among the models `auto` can pick for your key), so Claude Code doesn't assume 200,000 for a name it doesn't know |
| `env.ANTHROPIC_CUSTOM_MODEL_OPTION`, `…_NAME` | `auto`, "auto (Merit Order)": adds it to the `/model` picker |
| `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS` | `1`: Claude Code labels side requests and compaction summaries only when asked; Merit Order caps their level (`routing.request_class_levels`) |

For a Claude model name (`claude-…`) the window and picker entries are left out (Claude Code knows those
models) and removed if an earlier setup added them. The previous file is kept as `settings.json.bak`.
With the Merit Order key, Claude Code's requests don't use a claude.ai login: subscription limits don't
apply, and spend is counted here like any other key's.

How the gateway knows who's calling: every request carries a key (`Authorization: Bearer` or
`x-api-key`). The gateway hashes it, looks it up (cached for a minute), and gets the user, team,
and role, which drive budgets, policy, and reports. Unknown, revoked, or expired keys get a 401.

| Client | Auth |
|---|---|
| People with harnesses | `meritorder login` → virtual key (above) |
| Services / apps | An Entra token directly as the bearer token, or a key from `meritorder keys create` |
| Local dev / quickstart | `MERITORDER_DEV_KEY` (static admin key from the environment) |

Sign-in switches on when `MERITORDER_OIDC_ISSUER` and `MERITORDER_OIDC_CLIENT_ID` are set. With Entra,
map group IDs to teams and roles in `auth.oidc` in the config; SCIM provisioning (below) disables
people when they leave. Google needs a little more: see [Signing in with Google](#signing-in-with-google),
and [Google Groups](#google-groups) to map Google groups the same way.

## People and teams

| What | Where it's managed |
|---|---|
| Who exists, and their group membership | Your identity provider (Entra or Google). People are created in Merit Order the first time they sign in with `meritorder login`, when they're issued a key, or when Entra provisions them through SCIM. |
| Teams, with budgets, limits, and model policy | Merit Order: Config → Teams. An IdP has no notion of "$5,000 a month, these models only". |
| Which team and role someone gets | Entra groups, or with Google, Google groups (read by the gateway) and verified email addresses and domains, mapped to teams and roles in Config → Access. Re-read at each sign-in; Google groups also while people use the gateway. |
| Exceptions | The People page: an admin can move someone or change their role (either pins team and role, so later sign-ins and SCIM don't override them), hand them back to the sign-in mappings (Follow sign-in), set a monthly limit, or disable them. |

The user record decides a person's team, and it can lower what a key acts as but never raise it: a key
acts as the lower of the role it was issued with and the role on its person's record (`ROLE_RANK`: user,
team lead, finance, admin). Moving, demoting or disabling someone takes effect within a minute on every
gateway, including keys they already have and static keys from the config file. Promoting someone applies to
keys issued after it: their next `meritorder login`, or a key an admin issues. So a `user` key a team lead
issued for someone who hasn't signed in yet stays a user key when that person turns out to be an admin. The
Keys page shows each key's role and, where the person's record outranks it, what the key acts as.

A team lead issues and revokes keys only for themselves, for new people, or for people on their own team with
the user role; keys for anyone else (another team, a lead, an admin) need an admin. Their keys expire within
`expires_days` (default 90, at most 3650); only an admin can issue a key that never expires. A disabled person
can't sign in: `POST /auth/exchange` answers 403 and issues no key.

| Role | Sees | Can change |
|---|---|---|
| user | Their own usage | Nothing (`meritorder login` gets them a new key) |
| team lead | Their team: reports, requests, ledger export | Keys on their team (they issue only `user` keys) |
| finance | Every team, aggregated: no per-request rows, exports or live request feed (`/v1/reports/requests` and `/v1/console/feed` answer 403) | Nothing |
| admin | Everything, except the content of other people's stored responses | Everything |

No role reads another person's stored responses ([below](#stored-responses-who-holds-them-and-who-can-read-them))
unless their team lists that role in `stored_responses.readers`.

**SCIM provisioning** (`/scim/v2`, enabled by `MERITORDER_SCIM_TOKEN`): Entra pushes people and
group changes as they happen. Group membership recomputes team and role with the same mappings as
sign-in (an admin's pin still wins), and anyone deactivated or removed in Entra is disabled at once:
their keys stop working within a minute (spend history is kept), and anything they kept in the Responses
API's stored mode is deleted. SCIM's `active` flag works both ways: if Entra later sends the person as active
again, they are enabled again, even if an admin disabled them on the People page. To keep someone out, disable
or remove them in Entra too.

**Entra group overage.** A person in more than 200 groups gets a token without the `groups` claim (Entra
puts a pointer to Microsoft Graph in `_claim_names` instead). The gateway doesn't call Graph, so their group
mappings don't apply: they get the email mappings and `default_team`, and the gateway logs a warning naming
them. Configure the app registration to send only groups assigned to the application ("Groups assigned to the
application" in Token configuration), or map them by email, or provision them with SCIM.
Setup: Entra → Enterprise applications → your app → Provisioning → Automatic; Tenant URL
`https://<gateway>/scim/v2`, Secret token = `MERITORDER_SCIM_TOKEN`.

## Signing in with Google

Google sign-in uses the same `meritorder login` (device code) and the same `/auth/exchange` as Entra.
Google's tokens and login flow differ in a few ways, and the gateway handles each:

| | Entra | Google |
|---|---|---|
| Who can get a token | Members of your tenant: the issuer is per tenant | Anyone with a Google account: one issuer for everyone. `hosted_domains` limits sign-in to your Workspace domains, checked against the token's `hd` claim. It's required: the gateway won't start with the Google issuer and no domains |
| Groups in the token | Yes (`groups`) | None. The gateway can read them from Google ([Google Groups](#google-groups)); verified addresses and whole domains map too (`team_from_emails`, `role_from_emails`), and exceptions go on the People page |
| Email | `preferred_username`; not verified, so never used for mapping | `email` with `email_verified`. A token whose address isn't verified is refused |
| Who the person is | `oid` | `sub` (Google says addresses can change and be reused; `sub` never is) |
| Device login | A public client with no secret | An OAuth client of type "TVs and Limited Input devices". Its secret goes with every poll; Google treats it as public for that client type, so the gateway hands it to `meritorder login` |
| Scopes | `openid profile email offline_access` | `openid email profile`, set automatically (Google refuses `offline_access`, and its device login allows only these) |
| Issuer in tokens | As discovered | `https://accounts.google.com` or `accounts.google.com`; both are accepted |

Setup:

1. In the Google Cloud console, open **Google Auth Platform** (APIs & Services → OAuth consent screen) and
   set the audience to **Internal**, so only accounts in your Workspace can sign in at all.
2. **Clients → Create client**, application type **TVs and Limited Input devices**. Copy the client
   ID and secret.
3. On the gateways (`.env`, or the Helm secret):

   ```bash
   MERITORDER_OIDC_ISSUER=https://accounts.google.com
   MERITORDER_OIDC_CLIENT_ID=123456789012-abc.apps.googleusercontent.com
   MERITORDER_OIDC_CLIENT_SECRET=GOCSPX-...
   MERITORDER_OIDC_HOSTED_DOMAINS=example.com          # comma-separated if you have several
   ```

   The shipped config reads all four. If your configuration was already saved from the console
   before these fields existed, fill in the client secret and domains on Config → Access. The
   secret must stay a reference (`${MERITORDER_OIDC_CLIENT_SECRET}`), since secrets aren't stored.

4. Map teams and roles in `auth.oidc` (or Config → Access):

   ```yaml
   auth:
     oidc:
       team_from_emails:
         "@example.com": platform            # everyone in the domain
         "@research.example.com": research
         "bob@example.com": data-science     # one person
       role_from_emails:
         "carol@example.com": admin
         "dana@example.com": finance
       key_ttl_days: 7                       # see "Leavers" below
   ```

   A key with `@` in the middle is one address; `@example.com` or `example.com` is a whole domain.
   Team: the entry for the exact address, else a mapped group ([Google Groups](#google-groups)), else
   the address's domain, else `default_team`. Role: the highest any of them gives; everyone else is a
   user. Matching ignores case. These lists apply only to an `email` the token marks verified, which
   Google's are and Entra's aren't: with Entra, map groups.

5. People run `meritorder login`. It prints `https://www.google.com/device` and a code; they sign in
   with their Workspace account, and the gateway issues a key as with Entra.

Refusals: an account outside `hosted_domains` (a personal Gmail account, say) gets 403 "sign-in is
limited to accounts in example.com", and an unverified address gets 403 "this account's email address
isn't verified". Both checks also apply to a Google ID token sent directly as a bearer token. A Google
service account's ID token has no `hd`, so services use a key from `meritorder keys create`. If the issuer is
written another way (`https://accounts.google.com:443`, say) the start-up check doesn't see Google, so the gateway
also refuses every token Google's issuer signed while `hosted_domains` is empty.

**Leavers.** Google Workspace doesn't provision custom apps over SCIM, so a suspended account isn't
disabled here at once. It can't sign in again, and its keys stop when they expire (`key_ttl_days`,
30 by default; 7 is a reasonable choice with Google). To cut someone off now, disable them on the
People page. With Google Groups on, taking someone out of their groups also takes away the team and
role those groups gave, at the next refresh, while their keys still work.

### Google Groups

Google's ID tokens never include groups, so the gateway can read them itself from Google's Cloud
Identity Groups API (v1, as documented in November 2026) and map them as it maps Entra groups:
`team_from_groups` and `role_from_groups`, keyed by the group's address.

```yaml
auth:
  oidc:
    issuer: https://accounts.google.com
    # client_id, public_client_secret, hosted_domains as above
    google_groups:
      enabled: true          # the shipped config: MERITORDER_GOOGLE_GROUPS=true
      credentials_env: MERITORDER_GOOGLE_GROUPS_CREDENTIALS   # the service account's JSON key (or credentials_file)
    team_from_groups:        # the first group in this list someone is in sets their team
      "platform-team@example.com": platform
      "research@example.com": research
    role_from_groups:
      "gateway-admins@example.com": admin
      "finance@example.com": finance
    team_from_emails:
      "bob@example.com": data-science   # an exact address still wins over a group
      "@example.com": general           # the domain catches everyone in no mapped group
```

**Which mapping wins.** The team comes from, in order:

1. the person's exact address in `team_from_emails`;
2. the first group in `team_from_groups` they're in, directly or through nested groups;
3. their domain in `team_from_emails`;
4. `default_team`.

The role is the highest that any of their groups, their address or their domain gives; everyone else
is a user. Addresses match ignoring case. A team or role an admin set on the People page wins over all
of them. Map only groups whose membership your admins control: a group anyone in the organization can
join, mapped to a role, lets anyone take that role.

**Setup.** You need a Google Cloud project and a Google Workspace super admin.

1. Google Cloud console → **APIs & Services → Library** → **Cloud Identity API** → **Enable**.
2. **IAM & Admin → Service Accounts → Create service account**, for example `meritorder-groups`. It
   needs no IAM roles in the project. Copy its email address.
3. Give the gateways a way to act as it, one of:
   - **GKE Workload Identity** (no key to keep): let the gateways' Kubernetes service account act as it,

     ```bash
     gcloud iam service-accounts add-iam-policy-binding meritorder-groups@PROJECT.iam.gserviceaccount.com \
       --role roles/iam.workloadIdentityUser --member "serviceAccount:PROJECT.svc.id.goog[NAMESPACE/KSA]"
     ```

     and annotate it in the Helm values: `serviceAccount.annotations: {iam.gke.io/gcp-service-account:
     meritorder-groups@PROJECT.iam.gserviceaccount.com}`. Leave `MERITORDER_GOOGLE_GROUPS_CREDENTIALS`
     unset. A pod has one Google identity, so if the gateways already use a service account for Vertex,
     give that one the role in step 4 instead. Compute Engine and Cloud Run work the same way, through
     the service account attached to the VM or service.
   - **A key**: the service account → **Keys → Add key → Create new key → JSON**. Put the file's
     contents on one line (`jq -c . key.json`) in `MERITORDER_GOOGLE_GROUPS_CREDENTIALS`, in `.env` or
     the gateways' Secret. With `secrets.mountAsFiles` in Helm, also set `credentials_file:
     /run/secrets/meritorder/MERITORDER_GOOGLE_GROUPS_CREDENTIALS`, so a rotated key is used without a
     restart. If your organization blocks key creation (`iam.disableServiceAccountKeyCreation`), use
     Workload Identity.
4. In the Google Admin console (admin.google.com), signed in as a super admin: **Menu → Account →
   Admin roles**. Point to **Groups Reader**, click **Assign admin**, then **Assign service
   accounts**. Enter the service account's email address, click **Add**, then **Assign role**. To
   limit the role to security groups, choose that while assigning it and set
   `security_groups_only: true`. If multi-party approval is on for role changes, another admin
   approves it.
5. Set `MERITORDER_GOOGLE_GROUPS=true` (or switch on **Read Google Groups** on Config → Access) and map
   groups by address. `meritorder check` shows which key or identity the gateway will call Google as,
   without calling it; the first sign-in shows whether Google answers (People page, and an alert if not).

That's all: no domain-wide delegation and no scopes to authorize in the Admin console. The gateway asks
Google for one read-only scope, `https://www.googleapis.com/auth/cloud-identity.groups.readonly`. If
the metadata server gives a token with the broader `cloud-platform` scope instead (GKE Workload
Identity does), the Cloud Identity API accepts that too, and the service account can still only read
groups: that's all its role allows. Keys and tokens are never logged or stored.

**When groups are read.** At sign-in, and again for people using the gateway: anyone who made a
request since their groups were last read is read again once `refresh_seconds` (60) have passed, by
one gateway at a time. A removal reaches the user record then, and every gateway's key cache within a
minute after, as when SCIM brings an Entra group change: about two minutes in all by default. People
who stop using the gateway aren't read until they're back. Each reading is one call to Google per
person (and a page per 1,000 groups). People who signed in with Google before groups were turned on
are read the first time they use the gateway after that.

**Nested groups.** Google's transitive search (`searchTransitiveGroups`) lists every group someone is
in, through nested groups too, in one call. Google offers it on Workspace Enterprise Standard and
Plus, Enterprise for Education, and Cloud Identity Premium; other editions get a 403. The gateway then
lists direct groups (`searchDirectGroups`) and follows the nesting itself, one call per group, keeping
each group's parents for a refresh period. A group the service account can't see into (another
organization's, say) is left out and logged.

**When Google can't be reached.** Each person keeps the groups last read for them for
`keep_last_known_hours` (24). After that, their team and role come from the email and domain rules
alone, until Google answers again. Each step raises an alert on the console's attention list and the
webhook: Google Groups unavailable (for a setup problem, such as a missing role, scope or API, the
alert says what to fix), the fallback to the email rules, and the recovery. The last groups read live
in Redis with the rest of the gateways' shared state.

**On the People page**, a Google groups column shows each person's mapped groups (the one that set
their team filled, nested ones marked), the rest on hover, which mapping set their team and role, and
whether Google answered last time. Team leads see only the groups the mappings use. **Follow sign-in**
reads the person's groups at once and applies them.

## Stored responses: who holds them and who can read them

A team can turn on stored mode for OpenAI's Responses API (Config → Teams → Stored responses;
[04](04-caching-and-sessions.md#stateful-apis), decision 51). **Then the gateway holds conversation content**:
each response's input and output, and each conversation's items, sealed with `MERITORDER_RESPONSES_KEY`, for the
`retention_days` the operator set (required; there is no default). Elsewhere the gateway keeps none.

| Who | Can |
|---|---|
| The person whose key made it, on the team it was made in | Read it, list its input items, chain from it, cancel it (background), delete it |
| A role listed in the team's `stored_responses.readers` | Read and chain from it: admins from any team, the other roles on the same team. Not delete it |
| Anyone else, admins included | Nothing: it's 404 to them, as if it didn't exist |

- **A response belongs to its person and team.** Someone moved to another team can't read or chain from what they
  stored on the old one; it expires with the old team's retention.
- **Removing someone deletes what they stored.** Disabling them on the People page, or deactivating or deleting them
  through SCIM, deletes their stored responses and conversations at once, and the providers' copies (backends with
  `responses_store`). Enabling them again doesn't bring them back. Their ledger rows stay, as for anyone.
- **Spend is as for any request.** Each stored turn is one ledger row, checked against the organization, team, person
  and session budgets, rate limits and the per-request cost limit before it's sent. A chained turn is priced on the
  whole conversation it's rebuilt into, which is what the provider bills.
- **The console shows sizes, never content.** Config → Teams and the Teams page show, per team, how many responses,
  conversations and items are stored, their sealed size, for how many people, and since when. No page shows what
  they say.

## Secrets in a saved configuration

An admin who saves a configuration from the console chooses both where a backend's key comes from and the
backend's `base_url`, and the backend sends its key to that URL. So a saved configuration may read only what the
operator allows (the YAML file on disk is the operator's and isn't checked; `configstore.secret_problems`):

| Field | May read |
|---|---|
| A backend's or bill source's `auth.value_env`, or `${NAME}` in its `auth.value` | A provider's key variable the shipped configs use (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY`, `AZURE_FOUNDRY_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `MINIMAX_API_KEY`, `ANTHROPIC_ADMIN_KEY`, `OPENAI_ADMIN_KEY`, `AZURE_EXPORT_SAS`), or any `MERITORDER_BACKEND_<NAME>` |
| The gateway's own secret fields | Only their own variable: `reporting.clickhouse.auth` `MERITORDER_CLICKHOUSE_PASSWORD`, `compressor.api_key_env` `MERITORDER_COMPRESSOR_KEY`, `auth.oidc.google_groups.credentials_env` `MERITORDER_GOOGLE_GROUPS_CREDENTIALS`, `auth.oidc.public_client_secret` `MERITORDER_OIDC_CLIENT_SECRET`, `batches.key_env` `MERITORDER_BATCH_KEY` (and `_PREVIOUS`), `response_store.key_env` `MERITORDER_RESPONSES_KEY` (and `_OLD_KEYS`). A static key's `key_env` may name any variable: its value is only compared with callers' keys |
| Any `*_file` field (`value_file`, `key_file`, `credentials_file`, ...) | A file inside `MERITORDER_SECRETS_DIR` (default `/run/secrets/meritorder`, the chart's `secrets.mountAsFiles`), with `..` refused and symlinks resolved, named for a variable the field may read |
| `${NAME}` anywhere else (a `base_url`, a region, a budget) | Only the variables the shipped config uses there (`AZURE_OPENAI_ENDPOINT`, `AWS_REGION`, `MERITORDER_ORG_BUDGET_USD`, ...; `configstore.PLAIN_ENVS`) |

Anything else (`MERITORDER_DATABASE_URL`, `MERITORDER_SCIM_TOKEN`, `MERITORDER_ALERT_WEBHOOK_URL`, any file
elsewhere) is refused with a message saying what the field may read. The operator adds names in the gateways'
environment: `MERITORDER_CONFIG_SECRET_ENVS` for secret fields and `MERITORDER_CONFIG_ENVS` for `${NAME}` elsewhere
(comma-separated, a trailing `*` for a prefix). Restoring an old version applies the same rules.

## Where budgets and limits are set

Every budget and limit below is a field in the configuration. There are two places a configuration
can come from, and only one is in effect at a time:

1. **The YAML file**, `config/meritorder.yaml` (or `MERITORDER_CONFIG`), with its `include:` files.
   It is in effect only until someone saves a configuration from the console.
2. **The newest version saved in Postgres.** The console saves one when an admin saves on the
   Controls page (**Save as new config version**) or the Config page (**Save and apply**), restores
   an old version (Config → History), or applies an eval run's scores. Once any version exists,
   every gateway, the worker and the controller use the newest one and ignore the YAML file.
   Editing the file after that has no effect, so make later changes on the console (the Config
   page's YAML tab takes the whole document).

**Two saves never undo each other.** Every save names the version it was made to (`base_version`: the
`version` that `GET /v1/admin/config/source` returned, `null` while the file is in effect). If someone
saved another version since, the gateway refuses with 409 ("someone else saved the configuration
(version N) since you opened version M; reload to see their change, then make yours again") and saves
nothing. The check and the insert are one step in Postgres (an advisory lock), so of two admins saving
together exactly one wins. Every console save sends it: Config (**Save and apply**, **Restore** in
History) and Controls. Changes the gateway or the worker writes for you (an eval run's scores, a level
from the outcome report, the worker's `auto_apply`) are made to the newest version, read just before
saving, and checked the same way; the worker skips a recommendation that loses the race and tries it on
its next pass. `base_version` is optional on `PUT /v1/admin/config` and
`POST /v1/admin/config/versions/{id}/restore`: a script that leaves it out saves over whatever version
is newest, as before.

The first save copies the whole running document into Postgres (the file with its `include:` files
merged in), with the fields you changed set to their new values. `${NAME}` references are copied as
written, not as their values. Each process fills them in from its own environment every time it
loads the configuration.

```mermaid
flowchart TD
    L["A gateway, the worker or the controller<br/>loads the configuration"] --> Q{"Any version saved<br/>in Postgres?"}
    Q -- no --> F["YAML file<br/>config/meritorder.yaml + includes"]
    Q -- yes --> D["Newest stored version<br/>(the YAML file is ignored)"]
    F --> R{"Does the field hold<br/>a ${NAME} reference?"}
    D --> R
    R -- yes --> E["Value of NAME in this process's environment,<br/>else the default after :-, else no limit"]
    R -- no --> V["The number written there"]
```

So the environment variables in the shipped file (`MERITORDER_ORG_BUDGET_USD` and the others under
[Organization-wide safeguards](#organization-wide-safeguards)) set a field only while that field
still holds its `${...}` reference. That is true of the file, and of stored versions in which nobody
has changed that field. When an admin sets the field on the Controls page, the saved version holds
the number instead, and the variable no longer has any effect on it. Clearing a field on the
Controls page removes it from the document, which means no limit, not the variable's value.

Saving needs Postgres (`MERITORDER_DATABASE_URL`). Without it the console can edit and validate,
but not save, and the YAML file stays in effect. If a stored version can't be loaded when a gateway starts, the
gateway logs the error and runs on the YAML file. The worker and the controller log it and keep
the configuration they already had (the YAML file, if they had just started).

```mermaid
sequenceDiagram
    actor A as Admin
    participant C as Console (Controls page)
    participant G as Gateway that gets the save
    participant P as Postgres
    participant R as Redis
    participant O as Other gateways
    participant W as Worker and controller

    A->>C: Change the org budget, click Save
    C->>G: GET /v1/admin/config/source (the document in effect)
    C->>C: Set safeguards.org_budget_usd_month in it
    C->>G: POST /v1/admin/config/validate
    C->>G: PUT /v1/admin/config (base_version N-1)
    G->>P: Save as version N (author, comment), unless another was saved since: 409
    G->>G: Apply version N
    G->>R: Publish a new config token
    loop every 5 seconds
        O->>R: Has the token changed?
        O->>P: If so, load version N
    end
    W->>P: On each pass (every minute by default), load the newest version if it changed
```

| Setting | Where to change it |
|---|---|
| Organization budget, GPU budget, GPU burn rate and replica caps, per-request cost limit | **Controls** page (admins; finance can view it), or `safeguards:` in the file |
| Team budget, per-person default, per-session cap | **Controls** page or **Config → Teams**, or `teams:` in the file |
| Rate limits, model and backend policy, exploration | **Config → Teams**, or `teams:` in the file |
| A level moved by the outcome report (`routing.level_map`) | **Reports → Levels** → *Apply* (admins), **Config → YAML**, or `routing:` in the file |
| One person's own monthly limit | **People** page, or `PATCH /v1/admin/users/{id}`. Kept on the user record in Postgres, not in the configuration |

Each save is a new version with its author, time and comment. **Config → History** lists them and
restores any of them, which saves it again as the newest version.

## Budgets

```mermaid
flowchart TD
    ORG["Org budget<br/>$/month"] --> T1["Team: platform<br/>$/month"]
    ORG --> T2["Team: data-science<br/>$/month"]
    T1 --> U1["User budget"]
    T1 --> U2["User budget"]
    T2 --> U3["User budget"]
    U1 --> K1["Key"]
    U1 --> K2["Key"]
```

- A request must fit **every** level above it: organization, team, and person.
- **Each person can have their own monthly limit.** Without one, the team's per-person default
  (`user_budget_usd_month`) applies. A person's own limit replaces that default, higher or lower;
  the team and organization budgets still apply on top. `$0` stops their requests. Set it in either
  place below; the People page wins when both are set, and changes apply within a minute on every
  gateway, keys already issued included:
  - The console's **People** page (admins), or `PATCH /v1/admin/users/{id}` with
    `{"budget_usd_month": 250}`. Send `null` to clear it and go back to the default.
  - `budget_usd_month` on a static key in the config file, for people who use one.
- A person's limit counts everything they spent this month, on whichever team they were on.
- Spend is checked before a request is sent and counted when it finishes (Redis counters seeded
  from the Postgres ledger, which stays the source of truth). A request that finishes after Redis lost a month's
  counter (a flush, a failover, eviction) doesn't start it again: the next request seeds it from the ledger. One that
  finishes while the ledger is being read for a seed is kept aside and added to it, so it isn't lost.
- **The worker checks the counters against the ledger** every cycle (a minute): this month's for the organization, each
  team and each person, recomputed from the ledger plus running batches' reservations, the same sum a seed uses. A
  counter that's off by the same amount on two cycles running is corrected by that amount (a request finishing between
  writing its counter and its ledger row makes a difference that's gone the next cycle). That covers a Redis restored
  from an old snapshot, whose counters exist but are behind; the compose file runs Redis without persistence so that
  doesn't happen ([07](07-deployment.md)).
- **A batch** is checked once, against its estimated cost at batch prices, and refused if that doesn't fit what's left of
  any budget it counts against. The estimate is reserved in the same counters (so live requests see it) until the worker
  settles each result at what it cost. A request sent to a GPU reserves its fallback provider's estimate, since it may end
  up there, and settles at the GPU time it took. Rate limits and `max_session_usd` don't apply to batches
  ([02](02-request-flow.md#batches-work-that-can-wait)). A reservation counts in every month it's outstanding: a batch made
  on the 31st that settles on the 1st is charged in the new month, so the new month's budgets hold room for it. A batch
  that can't be stored takes its reservation back at once.
- **Judged labels** (opt-in per team, [03](03-routing.md#judged-labels)) spend as an internal client of the team,
  `judged-labels:<team>`, which shows as its own line in reports by person. Its requests count against the team's and
  the organization's budgets and are refused at 100% like anyone's; no per-person limit applies to it. Its monthly cap
  (`judged_labels.max_usd_month`, required, no default) is checked when each sample starts: none starts once it's spent,
  and one that started finishes. The worker alerts at 80% and 100% of the cap.
- **Exploration** (opt-in per team, `teams.<name>.exploration`, Config → Teams → Exploration;
  [03](03-routing.md#exploration)) sends a few of the team's `auto` task starts a level down or up, while the learned
  router is on (shadow mode at least). A task explored up
  costs more, so exploring up stops once any budget that applies to the request (the organization's, the person's, the
  team's, the session's) is 90% spent; exploring down goes on. It never goes past the team's `allowed_models` or
  `allowed_backends`, or the per-request cost limit. Explored requests are ordinary requests of the person: they count
  against every budget, and the ledger tags them `explore` and `explore_from`.
- Alerts go out at 80% and 100%; at 100% requests are refused with a 429 that says which budget
  was reached.
- Policy lives alongside budgets, per team: `allowed_models` and `allowed_backends`, glob lists
  with `!` exclusions. For example `allowed_backends: ["*", "!deepseek"]` keeps a team's requests off
  the `deepseek` backend (DeepSeek's own API).

## Limits that stop runaway spend

| Setting (per team) | What it does |
|---|---|
| `budget_usd_month`, `user_budget_usd_month` | Monthly caps for the team, and the default for each person on it; requests are refused at 100% (alerts at 80%). A person's own limit replaces the per-person default ([Budgets](#budgets)) |
| `max_session_usd` | Stops one session (typically an agent stuck in a loop) once it has spent this much. A Claude Code session's subagents and side requests count toward it |
| `rate_limits: {user_rpm, user_tpm, team_rpm, team_tpm}` | Requests and prompt tokens per minute; 429 with `Retry-After` |

## Organization-wide safeguards

Hard limits for everyone. The console's **Controls** page shows each one next to this month's
spend and the pace it's on. An admin changes them there, which saves a new config version in
Postgres that every gateway picks up within seconds
([Where budgets and limits are set](#where-budgets-and-limits-are-set)).

The shipped `config/meritorder.yaml` fills them from environment variables, so a new install can
set its starting values in `.env` without editing the file:

| Field | Variable in the shipped file | If the variable is unset or blank |
|---|---|---|
| `org_budget_usd_month` | `MERITORDER_ORG_BUDGET_USD` | no limit |
| `gpu_budget_usd_month` | `MERITORDER_GPU_BUDGET_USD` | no limit |
| `max_gpu_usd_per_hour` | `MERITORDER_MAX_GPU_USD_PER_HOUR` | no limit |
| `max_gpu_replicas` | `MERITORDER_MAX_GPU_REPLICAS` | no limit |
| `max_request_usd` | `MERITORDER_MAX_REQUEST_USD` | 25 |

A variable is read only while its field still holds the `${...}` reference. Once an admin sets that
field on the Controls page, the stored number wins and the variable is ignored.

These are the fastest stop there is: they act on the gateway's own ledger, request by request.

**What "spent" means for a budget.** One total, `spend.budget_spend(store, cfg, kind, ident)`, is what every surface
shows for a budget: admission seeds its counters from it, and Controls, the console's attention panel and the budget
alerts show it. It is the month's ledger (from Postgres) plus what running batches have reserved (shown on its own as
"reserved by running batches"), and for the organization the GPU time no request paid for. A person's spend is across
every team they were on this month, as admission counts it. A team's and a person's GPU requests count at their shares
of the GPU's time; the idle time is the organization's alone, so a team's budget can't be used up by GPUs it didn't
start. Each gateway reads the organization's GPU time at most once a minute (the controller adds to it once a cycle).
Cloud budgets (AWS Budgets, Azure Cost Management) see spend hours later, and on their own only
send email, so treat them as a backstop for anything that doesn't go through the gateway.

| Setting | What it does |
|---|---|
| `org_budget_usd_month` | All LLM spend: the ledger, what running batches have reserved, and GPU time no request paid for (idle, starting, draining), so GPUs count at what they cost to run ([08](08-reporting.md#gpu-time-in-spend)). At 100% every request is refused until the month ends or it's raised |
| `gpu_budget_usd_month` | GPU time alone (replicas × hourly price), a cap of its own; the same time also counts in the org budget. At 100% running GPUs drain and none start, pins included |
| `max_gpu_usd_per_hour` | Burn-rate cap for the whole GPU fleet; deployments whose demand best covers their cost get capacity first. Each replica counts at its expected (cheapest) price, or, while it runs, at what it really burns when that's more (a pricier region, a spot price that moved). A GPU with no price is never started, so nothing escapes the cap |
| `max_gpu_replicas` | Replica cap across all deployments |
| `max_request_usd` | Per request. One that sets `max_tokens` is checked at its worst case (input tokens × input price + `max_tokens` × output price; self-hosted routes count as $0): cheaper candidates are used instead, and if none fit it's refused (400) with what it would have cost. One without `max_tokens` may write as much as the model can, less whatever wouldn't fit under the limit (the reply's `x-meritorder-max-tokens` header says how much it got, and `x-meritorder-max-tokens-source: cost limit` that it was trimmed); it's refused only if its input alone costs more |
| `alert_at` | Fractions of the org and GPU budgets that send alerts (default 80% and 100%) |

GPUs can also be stopped, pinned, or stopped all at once from the console; see
[05](05-gpu-autoscaling.md#controls-and-safeguards).

## What gets charged

| Backend | Charged to the user's budget |
|---|---|
| API | Provider cost of the cached, uncached, and output tokens at the route's live list price (OpenRouter's catalog or LiteLLM's price list, refreshed every 15 minutes) or its `price:` override. OpenRouter picks among providers whose prices differ, so for OpenRouter the ledger records what it billed (`usage.cost`; with your own provider key, its fee plus the provider's charge). Set `billed_cost: reported` or `catalog` on a backend to choose |
| Self-hosted | Chargeback: the GPU time the request's tokens take at `capacity_tokens_per_second`, at the replica's hourly price (SkyPilot's catalog price for the running replicas, or on Kubernetes their node type's configured price, else `gpu_cost_per_hour`), so it's not $0. Idle GPU time isn't charged to anyone; the GPU budget covers all GPU time |
| Server-side tools | Anthropic web search at $10 per 1,000 searches (`price.web_search_per_1k`), on top of tokens. Web fetch adds only tokens; code-execution container time isn't modeled |
| Batch requests | The route's batch price: the live list's batch price, else the provider's published discount (half; Moonshot 40%, xAI 20%), or the route's `price.batch`. On a GPU, the GPU time it took, like live GPU work |

**An unknown price is never served as free.** A route with no price (none in the live list yet, no `price:` override)
on an API backend can't be used: `auto` passes it by, and a request that names its model, an embedding request and a
batch request get a 503 that says so ("no price known for this route yet; set `price:` or wait for the price list"),
unless the model has another, priced route. The worker raises a critical alert for each such route, once a day. A
self-hosted route is charged by its GPU time, so a named request may use one without a price. Mock backends stand in for
an API and follow the same rule: give their routes a `price:` (the shipped config's mocks have one).

**OpenRouter's `usage.cost`** comes back on every response without asking: OpenRouter's usage accounting docs (November
2026) say `usage: {include: true}` is deprecated and has no effect, so the gateway doesn't send it. Streams ask for
usage with `stream_options.include_usage`, as for every OpenAI-format backend. A response without `usage.cost` is
charged at the catalog price.

Some `anthropic-beta` features change pricing (for example 1M-token context) in ways the cost model
doesn't track. To keep them off, list the betas a backend may forward: `anthropic_betas: [...]`
(prefix match; unset forwards everything the client sends).

Budgets use chargeback; the router uses marginal cost. They answer different questions.

These are computed costs. Reports → Bills checks them against each provider's own cost data (Anthropic's and
OpenAI's admin APIs, AWS Cost Explorer or its CUR 2.0 export, the Google Cloud billing export, Azure Cost Management
or its exports) and alerts when a day's bill and ledger drift apart; see
[08](08-reporting.md#checking-costs-against-the-bills).

## The savings ledger

One row per request, written async:

| Field | Example |
|---|---|
| user, team, key, session | |
| model requested / floor / served | `auto` / `coding:3` / `qwen3-coder-next` |
| backend | `gpu-qwen-coder` |
| tokens: uncached in / cache read / cache write / out | 2,100 / 118,000 / 0 / 640 |
| **actual cost** (`actual_cost`) | what budgets are charged: chargeback on a self-hosted backend |
| **served model at API prices** (`served_api_cost`) | the same tokens on the model's API route |
| **baseline cost** (`baseline_cost`) | the team's `baseline_model` at API prices, without caching Merit Order added |
| **list cost** (`list_cost`) | the served model at list price, no caching |
| savings by cause | routing, caching, self-hosting, batch discount, compression by the rules, compression by the model, response cache |
| service tier, batch | `batch` and the batch's id, for a request sent through a provider's batch API |
| upgraded for free? | yes |

Reports add these rows up: what was spent, what it would have cost, savings by cause, and how many
requests were upgraded for free. How savings are calculated and reported is in
[08, Reporting](08-reporting.md).
