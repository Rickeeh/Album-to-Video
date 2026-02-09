const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function rotateLogs(logDir, keepLatest) {
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .map((name) => {
        const fullPath = path.join(logDir, name);
        try {
          return { name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }

  files.slice(keepLatest).forEach((f) => {
    try {
      fs.unlinkSync(f.fullPath);
    } catch {}
  });
}

function createSessionLogger(app, opts = {}) {
  app.setAppLogsPath();
  const logsRoot = app.getPath('logs');
  const appLogDir = path.join(logsRoot, opts.appFolderName || 'Album-to-Video');
  ensureDir(appLogDir);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(appLogDir, `session-${ts}-${process.pid}.jsonl`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  const keepLatest = Number.isFinite(opts.keepLatest) ? opts.keepLatest : 20;
  const isDev = !app.isPackaged;

  const write = (level, msg, data) => {
    const payload = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data && typeof data === 'object' ? data : { data }),
    };
    const line = `${JSON.stringify(payload)}\n`;
    try {
      stream.write(line);
    } catch {}

    if (isDev) {
      if (level === 'error') console.error(payload);
      else if (level === 'warn') console.warn(payload);
      else console.log(payload);
    }
  };

  rotateLogs(appLogDir, keepLatest);
  write('info', 'logger.ready', { filePath });

  return {
    filePath,
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
    close: () => {
      try { stream.end(); } catch {}
    },
  };
}

module.exports = { createSessionLogger };
