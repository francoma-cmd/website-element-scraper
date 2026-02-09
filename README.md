# Website Element Scraper

Internal distribution notes (macOS): since this app is **not notarized**, macOS may show:

`Apple could not verify “Website Element Scraper” is free of malware…`

The lowest-friction way to install is to use the provided installer script, which downloads via `curl` (no Finder quarantine) and installs the app.

## macOS install (recommended)

Install into `/Applications`:

```sh
curl -fsSL https://raw.githubusercontent.com/francoma-cmd/website-element-scraper/main/scripts/install-mac.sh | bash -s -- --tag v1.0.1-beta.4
```

Install into `~/Applications` (no admin password prompts):

```sh
curl -fsSL https://raw.githubusercontent.com/francoma-cmd/website-element-scraper/main/scripts/install-mac.sh | bash -s -- --tag v1.0.1-beta.4 --user
```

More details: `docs/mac-install.md`.
