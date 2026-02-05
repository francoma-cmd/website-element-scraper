const { execSync } = require("child_process");

const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: "0"
};

try {
  execSync("npx playwright install chromium", {
    stdio: "inherit",
    env
  });
} catch (error) {
  console.error("Failed to install Playwright Chromium. Try running:");
  console.error("  npx playwright install chromium");
  process.exit(1);
}
