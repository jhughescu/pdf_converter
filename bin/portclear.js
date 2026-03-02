#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');

const requestedPort = Number.parseInt(process.argv[2], 10);
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 3000;

function readCommandOutput(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    return '';
  }
}

function getListeningPidsWindows(targetPort) {
  const output = readCommandOutput(`netstat -ano -p tcp | findstr :${targetPort}`);
  if (!output.trim()) {
    return [];
  }

  const pids = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line.includes(`:${targetPort}`) && /LISTENING/i.test(line))
    .map(line => {
      const parts = line.split(/\s+/);
      const maybePid = parts[parts.length - 1];
      const parsed = Number.parseInt(maybePid, 10);
      return Number.isInteger(parsed) ? parsed : null;
    })
    .filter(pid => pid && pid > 0 && pid !== process.pid);

  return [...new Set(pids)];
}

function getListeningPidsUnix(targetPort) {
  const output = readCommandOutput(`lsof -nP -iTCP:${targetPort} -sTCP:LISTEN -t`);
  if (!output.trim()) {
    return [];
  }

  const pids = output
    .split(/\r?\n/)
    .map(line => Number.parseInt(line.trim(), 10))
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

  return [...new Set(pids)];
}

function getListeningPids(targetPort) {
  if (process.platform === 'win32') {
    return getListeningPidsWindows(targetPort);
  }
  return getListeningPidsUnix(targetPort);
}

function terminatePid(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
    return result.status === 0;
  }

  const sigterm = spawnSync('kill', ['-15', String(pid)], { stdio: 'ignore' });
  if (sigterm.status === 0) {
    return true;
  }

  const sigkill = spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
  return sigkill.status === 0;
}

const pids = getListeningPids(port);

if (pids.length === 0) {
  console.log(`No listening process found on port ${port}.`);
  process.exit(0);
}

console.log(`Found ${pids.length} process(es) listening on port ${port}: ${pids.join(', ')}`);

const failed = [];
for (const pid of pids) {
  const ok = terminatePid(pid);
  if (ok) {
    console.log(`Stopped PID ${pid}.`);
  } else {
    failed.push(pid);
    console.log(`Could not stop PID ${pid}.`);
  }
}

if (failed.length > 0) {
  console.error(`Failed to stop: ${failed.join(', ')}.`);
  process.exit(1);
}

console.log(`Port ${port} is now clear.`);
