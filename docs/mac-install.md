# macOS Install (Internal, Not Notarized)

This app is **not notarized** (no Apple Developer Program enrollment), so Gatekeeper may show:

`Apple could not verify “Website Element Scraper” is free of malware…`

You can still run it internally. The steps below minimize friction.

## Option A: One-command install (recommended)

This method downloads the DMG using `curl` (which typically does not apply Finder quarantine), installs the app, and removes any quarantine attributes just in case.

Install into `/Applications`:

```sh
curl -fsSL https://raw.githubusercontent.com/francoma-cmd/website-element-scraper/main/scripts/install-mac.sh | bash -s -- --tag v1.0.1-beta.4
```

Install into `~/Applications` (no admin prompts):

```sh
curl -fsSL https://raw.githubusercontent.com/francoma-cmd/website-element-scraper/main/scripts/install-mac.sh | bash -s -- --tag v1.0.1-beta.4 --user
```

## Option B: Finder DMG install + remove quarantine

1. Drag `Website Element Scraper.app` into `/Applications`
2. Run:

```sh
xattr -dr com.apple.quarantine "/Applications/Website Element Scraper.app"
open -a "/Applications/Website Element Scraper.app"
```

## If Your Mac Is Managed (MDM)

If your organization enforces policies that block unsigned/unnotarized apps, these bypasses may not work.
In that case you need either:

1. An IT-managed deployment/allowlist (Jamf/Munki/MDM), or
2. Proper Developer ID signing + notarization (requires paid Apple Developer Program enrollment).
