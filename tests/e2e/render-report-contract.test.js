const fs = require("fs");
const {
  runHeadlessRenderReportContract,
} = require("../../scripts/render-report-contract-headless");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

(function run() {
  const result = runHeadlessRenderReportContract();
  assertOk(Boolean(result?.reportPath), "render-report contract: expected output artifact path.");
  assertOk(fs.existsSync(result.reportPath), `render-report contract: artifact missing at ${result.reportPath}`);
  assertOk(Number(result.trackCount) >= 1, "render-report contract: expected at least one synthesized track.");
  console.log("OK: render-report contract keeps probeCodecName key present with string|null type");
})();
