# The website on AWS

`website.yaml` is a CloudFormation stack that serves the site at https://meritorder.dev: a private S3 bucket,
CloudFront with Origin Access Control, security headers and a CloudFront Function for `www` and Astro's clean URLs,
an ACM certificate for `meritorder.dev` and `www.meritorder.dev`, Route 53 alias records (A and AAAA for both), and an
IAM role GitHub Actions deploys with. It mirrors the console demo's stack (`deploy/aws/demo-site.yaml` in the main
repo, `meritorder-demo-site`, serving https://dev.meritorder.dev). No servers.

It lives in Merit Order's own AWS account (146879032513), stack `meritorder-website`, in **us-east-1** (CloudFront only
takes certificates from there). Use that account's profile and nothing else.

## Create or change the stack

```bash
P="--profile meritorder-admin --region us-east-1"
aws sts get-caller-identity $P                                         # the Merit Order account
aws route53 list-hosted-zones-by-name --dns-name meritorder.dev $P     # the zone: Z03013552QM54WTIRZBSF
gh api repos/therick/meritorder-website/actions/oidc/customization/sub       # the OIDC subject form (see GitHubSubjects)

aws cloudformation deploy $P --stack-name meritorder-website --template-file deploy/aws/website.yaml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides HostedZoneId=Z03013552QM54WTIRZBSF \
  --tags project=meritorder purpose=website
```

The first create took about 5 minutes. Parameters:

| Parameter | Default | What it is |
|---|---|---|
| `DomainName` | `meritorder.dev` | The apex. `www.` in front of it redirects there. |
| `HostedZoneId` | (required) | The Route 53 zone for the name. |
| `GitHubSubjects` | `repo:therick@319326/meritorder-website@1459849084:ref:refs/heads/main,repo:therick/meritorder-website:ref:refs/heads/main` | Who the deploy role trusts. The repo uses GitHub's immutable subjects, so it sends the first form; the plain form is there in case that is turned off. |
| `GitHubOidcProviderArn` | (empty: the account's `token.actions.githubusercontent.com` provider) | The stack never creates an OIDC provider. The account's one belongs to the `meritorder-demo-site` stack, which created it: don't delete that stack without moving the provider first. |

Outputs: `BucketName` (`meritorder-website-146879032513`), `DistributionId` (`E2OT5K7PVMFDFI`),
`DistributionDomainName`, `DeployRoleArn` (`arn:aws:iam::146879032513:role/meritorder-website-deploy`), `Url`.

## What CloudFront does

- **URLs** (CloudFront Function, viewer request): any host other than the apex gets a 301 to
  `https://meritorder.dev` with the same path and query. `/savings` gets a 301 to `/savings/`; `/savings/` is served
  from `savings/index.html`. Paths whose last segment has a dot are files.
- **Not found**: S3 answers 403 for a missing key (CloudFront can't list the bucket), so 403 and 404 both serve
  `/404.html` with status 404.
- **Caching**: set on the objects by the upload. `/_astro/*` (content-hashed names):
  `public, max-age=31536000, immutable`. Everything else (HTML, Pagefind's index, `/data/`, the sitemap):
  `no-cache`, so a deploy shows at once. Managed-CachingOptimized follows those and compresses.
- **Headers**: HSTS (2 years, subdomains), `nosniff`, `X-Frame-Options: DENY`, a referrer policy, a permissions
  policy, COOP, and a Content-Security-Policy: everything from the site itself, no third-party origins,
  `frame-ancestors 'none'`, `'wasm-unsafe-eval'` for Pagefind. The header allows inline scripts because it can't know
  their hashes; every page carries a meta CSP (`scripts/csp.mjs`) that narrows `script-src` to the sha256 of each inline
  script on that page, and browsers enforce both.

## The deploy role

- **Trust:** `sts:AssumeRoleWithWebIdentity` from the account's GitHub OIDC provider, when the audience is
  `sts.amazonaws.com` and the subject is one of `GitHubSubjects`: a workflow on `main` of `therick/meritorder-website`.
  Branches, tags, pull requests, other repos and jobs that name an environment get other subjects and are refused.
- **Permissions:** `s3:ListBucket` on the bucket, `s3:PutObject` and `s3:DeleteObject` on its objects, and
  `cloudfront:CreateInvalidation` on the distribution. Nothing else.

## Repository variables

```bash
gh variable set SITE_DEPLOY_ROLE_ARN --repo therick/meritorder-website --body arn:aws:iam::146879032513:role/meritorder-website-deploy
gh variable set SITE_BUCKET          --repo therick/meritorder-website --body meritorder-website-146879032513
gh variable set SITE_DISTRIBUTION_ID --repo therick/meritorder-website --body E2OT5K7PVMFDFI
```

## Deploying by hand

What the pipeline does, from a checkout:

```bash
npm ci && npm run build
B=meritorder-website-146879032513; D=E2OT5K7PVMFDFI; P="--profile meritorder-admin"
aws s3 sync dist/_astro s3://$B/_astro --cache-control "public, max-age=31536000, immutable" $P
aws s3 sync dist s3://$B --exclude "_astro/*" --cache-control "no-cache" --delete $P
aws s3 sync dist/_astro s3://$B/_astro --cache-control "public, max-age=31536000, immutable" --delete $P
aws cloudfront create-invalidation --distribution-id $D --paths "/*" $P
```

## Costs

Close to nothing at a project site's traffic. The hosted zone ($0.50 a month) is already paid for by the demo, and
alias queries to CloudFront are free. CloudFront's always-free tier covers 1 TB and 10 million requests a month, and
2 million CloudFront Function invocations; past that the function is $0.10 per million. S3 holds about 10 MB (well
under a cent a month) and the deploys' few hundred PUTs a run cost a fraction of a cent. The certificate is free, and
one `/*` invalidation a deploy stays inside the 1,000 free paths a month even with the daily build.

## Removing it

Empty the bucket (`aws s3 rm s3://meritorder-website-146879032513 --recursive`), then
`aws cloudformation delete-stack --stack-name meritorder-website --region us-east-1`. The OIDC provider stays: it isn't
this stack's.
