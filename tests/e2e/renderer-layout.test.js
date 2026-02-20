const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const isRunner = process.argv.includes('--runner');
const forcedHeadlessSkip = process.env.RENDERER_LAYOUT_FORCE_HEADLESS_SKIP === '1';

function shouldSkipGuiLayoutTest() {
  if (forcedHeadlessSkip) return true;
  if (process.platform !== 'linux') return false;
  const hasDisplay = Boolean(String(process.env.DISPLAY || '').trim());
  const hasWayland = Boolean(String(process.env.WAYLAND_DISPLAY || '').trim());
  return !hasDisplay && !hasWayland;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertOk(condition, message) {
  if (!condition) fail(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWindowLoaded(BrowserWindow, timeoutMs = 20000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const win = wins[0];
      if (!win.webContents.isLoadingMainFrame()) return win;
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
      return win;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for main renderer window.');
}

async function runRendererCheck(win) {
  const metrics = await win.webContents.executeJavaScript(`
    (() => {
      if (!window.__frenderTestHooks) {
        throw new Error('window.__frenderTestHooks is unavailable');
      }
      window.__frenderTestHooks.injectMockTracks(50);
      return window.__frenderTestHooks.getLayoutMetrics();
    })();
  `, true);

  assertOk(metrics.trackCount === 50, `Renderer layout: expected 50 tracks, got ${metrics.trackCount}.`);
  assertOk(metrics.bodyOverflowX === 'hidden', `Renderer layout: body overflow-x must be hidden (got ${metrics.bodyOverflowX}).`);
  assertOk(metrics.bodyOverflowY === 'hidden', `Renderer layout: body overflow-y must be hidden (got ${metrics.bodyOverflowY}).`);
  assertOk(metrics.htmlOverflowX === 'hidden', `Renderer layout: html overflow-x must be hidden (got ${metrics.htmlOverflowX}).`);
  assertOk(metrics.htmlOverflowY === 'hidden', `Renderer layout: html overflow-y must be hidden (got ${metrics.htmlOverflowY}).`);
  assertOk(!metrics.hasWindowVerticalScrollbar, 'Renderer layout: window must not have a vertical scrollbar.');
  assertOk(!metrics.hasWindowHorizontalScrollbar, 'Renderer layout: window must not have a horizontal scrollbar.');
  assertOk(metrics.trackListScrollable, 'Renderer layout: tracks panel should scroll with 50 tracks.');

  const tolerancePx = 1;
  assertOk(
    metrics.sectionHeaderTop >= (metrics.headerBottom - tolerancePx),
    `Renderer layout: tracks section header moved above titlebar boundary (${metrics.sectionHeaderTop} < ${metrics.headerBottom}).`
  );
  assertOk(
    metrics.firstTrackTop >= (metrics.sectionHeaderBottom - tolerancePx),
    `Renderer layout: first track overlaps track section header (${metrics.firstTrackTop} < ${metrics.sectionHeaderBottom}).`
  );
  assertOk(
    metrics.rightTop >= (metrics.headerBottom - tolerancePx),
    `Renderer layout: right panel overlaps titlebar (${metrics.rightTop} < ${metrics.headerBottom}).`
  );

  return metrics;
}

async function captureScreenshot(win, outputPath) {
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, image.toPNG());
}

async function createWinStyleWindow(BrowserWindow) {
  const preloadPath = path.join(projectRoot, 'preload.js');
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    resizable: false,
    useContentSize: true,
    backgroundColor: '#080b10',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  await win.loadFile(path.join(projectRoot, 'index.html'));
  await win.webContents.executeJavaScript(`
    (() => {
      document.documentElement.style.setProperty('--f', '"Segoe UI Variable", "Segoe UI", sans-serif');
      if (!window.__frenderTestHooks) {
        throw new Error('window.__frenderTestHooks is unavailable on win-style window');
      }
      window.__frenderTestHooks.injectMockTracks(50);
      window.__frenderTestHooks.setMockCoverAndFolder();
      return window.__frenderTestHooks.getLayoutMetrics();
    })();
  `, true);

  return win;
}

if (!isRunner) {
  if (shouldSkipGuiLayoutTest()) {
    console.log('SKIP: requires GUI');
    process.exit(0);
  }
  const electronBinary = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const res = spawnSync(electronBinary, [__filename, '--runner'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env,
  });

  if (res.error) {
    console.error(res.error);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

(async () => {
  if (shouldSkipGuiLayoutTest()) {
    console.log('SKIP: requires GUI');
    return;
  }
  const { app, BrowserWindow } = require('electron');
  process.chdir(projectRoot);
  require(path.join(projectRoot, 'main.js'));

  await app.whenReady();
  const mainWin = await waitForWindowLoaded(BrowserWindow);

  const metrics = await runRendererCheck(mainWin);

  const artifactsDir = path.join(projectRoot, 'test-artifacts', 'e2e', 'renderer-swap');
  const macScreenshotPath = path.join(artifactsDir, 'renderer-swap-mac.png');
  const winScreenshotPath = path.join(artifactsDir, 'renderer-swap-win.png');

  await delay(100);
  await captureScreenshot(mainWin, macScreenshotPath);

  const winStyleWindow = await createWinStyleWindow(BrowserWindow);
  await delay(100);
  await captureScreenshot(winStyleWindow, winScreenshotPath);
  try {
    if (!winStyleWindow.isDestroyed()) winStyleWindow.destroy();
  } catch {}

  console.log('OK: renderer layout is stable with 50 tracks and no window scrollbars');
  console.log(`OK: mac screenshot ${macScreenshotPath}`);
  console.log(`OK: win screenshot ${winScreenshotPath}`);
  console.log(`OK: metrics ${JSON.stringify(metrics)}`);

  await delay(50);
  app.quit();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
