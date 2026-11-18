# Contributing to the Merit Order website

Thanks for helping. [README.md](README.md) covers setup, the build and how the site is deployed. The docs, prices and
savings numbers come from the main repo ([Merit-Order/meritorder](https://github.com/Merit-Order/meritorder)), so
changes to those belong there; this repo holds the site around them.

## Pull requests

- One topic per pull request. Say what changed and why.
- The `build` check must pass: it syncs the docs, builds the site and checks the links (`npm run build`,
  `npm run check:links`).
- For a visual change, include before and after screenshots (`npm run shots` takes them in light and dark, at desktop
  and phone widths).
- Report security problems privately, as the main repo's
  [SECURITY.md](https://github.com/Merit-Order/meritorder/blob/main/SECURITY.md) describes, not in a pull request.

## Contributor License Agreement

Before your first pull request can be merged, you sign the [Contributor License Agreement](CLA.md) (CLA), once. It's
the same agreement as the main repo's. You keep your copyright; the agreement grants Espeto LLC, which maintains Merit
Order, a license to your contributions, including the right to offer them under other licenses as well as the AGPL.
[CLA.md](CLA.md) explains why, in plain words at the top.

To sign, open your pull request: the `CLA` check comments and asks you to. Reply on the pull request with exactly:

```
I have read the CLA Document and I hereby sign the CLA
```

The check records your GitHub account and passes. Your signature covers your later pull requests too. If the commits
aren't linked to your GitHub account, add the commit email address to your account and comment `recheck`. If you're
contributing for your employer, ask the maintainer about a Corporate CLA first (CLA.md says how).

Signing off commits (`git commit -s`) is welcome but not required.

## License

The site is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only), like Merit Order.
Your contributions are released under it as part of the site, and under the terms of the [CLA](CLA.md).
