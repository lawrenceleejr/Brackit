#!/usr/bin/env node
'use strict';
// Terminal mode: `brackit [folder] [--port N] [--no-open]`
// Starts the local server and opens Brackit in your default browser.

const { execFile } = require('child_process');
const path = require('path');
const { createServer, listen } = require('../server');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--port'));

if (flag('--help') || flag('-h')) {
  console.log(`brackit — review Fujifilm film-simulation brackets

usage: brackit [folder] [--port 4870] [--no-open]

  folder     SD card or folder to open (e.g. /Volumes/Untitled)
  --port     port to listen on (default 4870)
  --no-open  don't open a browser window`);
  process.exit(0);
}

// make ctrl-c run 'exit' handlers (finishes any pending card deletions)
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

(async () => {
  const server = createServer({ shell: 'browser' });
  let port;
  try {
    port = await listen(server, Number(opt('--port') || 4870));
  } catch {
    port = await listen(server, 0);
  }
  let url = `http://127.0.0.1:${port}/`;
  if (positional[0]) url += `?open=${encodeURIComponent(path.resolve(positional[0]))}`;
  console.log(`\n  brackit  →  ${url}\n  ctrl-c to quit\n`);
  if (!flag('--no-open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(cmd, [url], () => {});
  }
})();
