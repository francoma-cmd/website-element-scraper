// electron-builder afterPack hook.
//
// When we build macOS artifacts without a Developer ID identity (e.g. "identity": null),
// electron-builder can produce an app bundle that triggers Gatekeeper's "is damaged"
// dialog when quarantined because the bundle lacks `_CodeSignature/CodeResources`.
//
// This hook ad-hoc signs the whole `.app` bundle, generating CodeResources so the
// bundle is internally consistent. This is NOT a substitute for proper Developer ID
// signing + notarization for distribution.
//
// Opt out by setting `MAC_ADHOC_SIGN=0`.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function findSingleAppBundle(appOutDir) {
  const entries = fs.readdirSync(appOutDir, { withFileTypes: true });
  const apps = entries
    .filter((e) => e.isDirectory() && e.name.endsWith(".app"))
    .map((e) => path.join(appOutDir, e.name));

  if (apps.length === 0) return null;
  if (apps.length === 1) return apps[0];

  // Prefer the common "Website Element Scraper.app" name if present.
  const preferred = apps.find((p) => path.basename(p) === "Website Element Scraper.app");
  return preferred || apps[0];
}

exports.default = async function afterPack(context) {
  if (process.platform !== "darwin") return;
  if (process.env.MAC_ADHOC_SIGN === "0") return;

  const appPath = findSingleAppBundle(context.appOutDir);
  if (!appPath) {
    // Nothing to sign (unexpected for mac builds).
    return;
  }

  // If the build is being properly signed, do not overwrite it.
  // We detect this by presence of a bundle code signature folder.
  const codeSigDir = path.join(appPath, "Contents", "_CodeSignature");
  if (fs.existsSync(codeSigDir)) return;

  const res = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    { stdio: "inherit" }
  );

  if (res.status !== 0) {
    throw new Error(`codesign ad-hoc signing failed for ${appPath}`);
  }
};

