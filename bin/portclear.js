#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

const rawArgs = process.argv.slice(2);
const autoConfirm = rawArgs.includes('--yes') || rawArgs.includes('-y');
const killAllMode = rawArgs.includes('--all');
const portArg = rawArgs.find(arg => /^\d+$/.test(arg));
const requestedPort = Number.parseInt(portArg, 10);
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

function getProcessNameWindows(pid) {
  const output = readCommandOutput(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
  if (!output.trim() || /No tasks are running/i.test(output)) {
    return 'unknown';
  }

  const firstLine = output.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!firstLine) {
    return 'unknown';
  }

  const match = firstLine.match(/^"([^"]+)"/);
  return match && match[1] ? match[1] : 'unknown';
}

function getProcessNameUnix(pid) {
  const output = readCommandOutput(`ps -p ${pid} -o comm=`).trim();
  return output || 'unknown';
}

function getProcessName(pid) {
  if (process.platform === 'win32') {
    return getProcessNameWindows(pid);
  }
  return getProcessNameUnix(pid);
}

function getProcessCommandLineWindows(pid) {
  const output = readCommandOutput(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine"`);
  return output.trim();
}

function getProcessCommandLineUnix(pid) {
  return readCommandOutput(`ps -p ${pid} -o args=`).trim();
}

function getProcessCommandLine(pid) {
  if (process.platform === 'win32') {
    return getProcessCommandLineWindows(pid);
  }
  return getProcessCommandLineUnix(pid);
}

function isLikelyPdfConverterProcess(proc) {
  const name = String(proc.name || '').toLowerCase();
  const cmd = String(proc.commandLine || '').toLowerCase();

  if (!name.startsWith('node')) {
    return false;
  }

  if (cmd.includes('--pdf-converter-supervisor') || cmd.includes('--pdf-converter-child')) {
    return true;
  }

  if (cmd.includes('pdf_converter') && cmd.includes('index.js')) {
    return true;
  }

  if (cmd.includes('@j.hughes.cu/pdf-converter')) {
    return true;
  }

  return false;
}

function getParentPidWindows(pid) {
  const output = readCommandOutput(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId"`).trim();
  const parsed = Number.parseInt(output, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getParentPidUnix(pid) {
  const output = readCommandOutput(`ps -p ${pid} -o ppid=`).trim();
  const parsed = Number.parseInt(output, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getParentPid(pid) {
  if (process.platform === 'win32') {
    return getParentPidWindows(pid);
  }
  return getParentPidUnix(pid);
}

function getRelatedSupervisorProcesses(listeners) {
  const known = new Set(listeners.map(proc => proc.pid));
  const extras = [];

  for (const listener of listeners) {
    if (!/^node/i.test(listener.name)) {
      continue;
    }

    const parentPid = getParentPid(listener.pid);
    if (!parentPid || parentPid === process.pid || known.has(parentPid)) {
      continue;
    }

    const parentName = getProcessName(parentPid);
    const parentCommandLine = getProcessCommandLine(parentPid);
    const parentProc = {
      pid: parentPid,
      name: parentName,
      commandLine: parentCommandLine,
    };

    if (!isLikelyPdfConverterProcess(parentProc)) {
      continue;
    }

    known.add(parentPid);
    extras.push({
      pid: parentPid,
      name: parentName,
      commandLine: parentCommandLine,
      isPdfConverter: true,
      relatedTo: listener.pid,
      kind: 'supervisor',
    });
  }

  return extras;
}

function sleepMs(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
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

function askForConfirmation(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, answer => {
      rl.close();
      resolve(String(answer || '').trim().toLowerCase());
    });
  });
}

async function main() {
  const pids = getListeningPids(port);

  if (pids.length === 0) {
    console.log(`No listening process found on port ${port}.`);
    process.exit(0);
  }

  console.log(`Found ${pids.length} process(es) listening on port ${port}: ${pids.join(', ')}`);
  if (killAllMode) {
    console.log('Mode: --all (all listening processes on this port will be terminated after confirmation).');
  }

  const listeners = pids.map(pid => ({
    pid,
    name: getProcessName(pid),
    commandLine: getProcessCommandLine(pid),
    kind: 'listener',
  }));

  listeners.forEach(proc => {
    proc.isPdfConverter = isLikelyPdfConverterProcess(proc);
  });

  const supervisors = getRelatedSupervisorProcesses(listeners);
  const processes = [...listeners, ...supervisors];

  processes.forEach(proc => {
    const appTag = proc.isPdfConverter ? ' [pdf-converter]' : '';
    if (proc.kind === 'supervisor') {
      console.log(`- PID ${proc.pid}: ${proc.name}${appTag} (parent supervisor for PID ${proc.relatedTo})`);
      return;
    }
    console.log(`- PID ${proc.pid}: ${proc.name}${appTag}`);
  });

  const nonPdf = processes.filter(proc => !proc.isPdfConverter);
  if (nonPdf.length > 0) {
    console.log('⚠ One or more listeners do not look like pdf-converter processes. Review before confirming.');
    if (!killAllMode) {
      console.log('Tip: use --all to explicitly confirm you want to stop all listeners on this port.');
    }
  }

  if (!autoConfirm) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('Confirmation required but no interactive terminal is available.');
      console.error('Re-run with --yes to proceed non-interactively.');
      process.exit(1);
    }

    const response = await askForConfirmation(`Stop these process(es) on port ${port}? Type y to continue: `);
    if (response !== 'y' && response !== 'yes') {
      console.log('Operation cancelled. No processes were stopped.');
      process.exit(0);
    }
  }

  const failed = [];
  for (const proc of processes) {
    console.log(`Attempting to stop PID ${proc.pid} (${proc.name})...`);
    const ok = terminatePid(proc.pid);
    if (ok) {
      console.log(`Stopped PID ${proc.pid} (${proc.name}).`);
    } else {
      failed.push(proc.pid);
      console.log(`Could not stop PID ${proc.pid} (${proc.name}).`);
    }
  }

  if (failed.length > 0) {
    console.error(`Failed to stop: ${failed.join(', ')}.`);
    process.exit(1);
  }

  sleepMs(350);
  const remainingPids = getListeningPids(port);
  if (remainingPids.length > 0) {
    console.error(`Port ${port} is still in use by PID(s): ${remainingPids.join(', ')}.`);
    console.error('A process may have restarted immediately. Re-run portclear or stop that parent process manually.');
    process.exit(1);
  }

  console.log(`Port ${port} is now clear.`);
}

main().catch(err => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
