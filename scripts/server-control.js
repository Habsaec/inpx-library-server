import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const command = String(process.argv[2] || 'status').toLowerCase();
const explicitPort = Number(process.argv[3] || 0);
const targetPort = Number.isInteger(explicitPort) && explicitPort > 0 ? explicitPort : config.port;
const statePath = path.join(config.dataDir, `server-process-${targetPort}.json`);

function ensureStateDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function readState() {
  try {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(payload) {
  ensureStateDir();
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf8');
}

function removeState() {
  try {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  } catch {
  }
}

function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function findPidByPort(port) {
  let result;
  if (process.platform === 'win32') {
    result = spawnSync('cmd', ['/c', `netstat -ano | findstr LISTENING | findstr :${port}`], {
      cwd: config.rootDir,
      encoding: 'utf8',
      windowsHide: true
    });
  } else {
    result = spawnSync('sh', ['-c', `lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || ss -tlnp sport = :${port} 2>/dev/null | grep -oP 'pid=\K[0-9]+'`], {
      cwd: config.rootDir,
      encoding: 'utf8'
    });
  }

  if (result.status !== 0 || !result.stdout) {
    return 0;
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split(/\s+/).filter(Boolean);
    const pid = Number(parts[parts.length - 1] || 0);
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }

  return 0;
}

function getLiveState() {
  const state = readState();
  if (!state) {
    const portPid = findPidByPort(targetPort);
    if (!portPid) {
      return null;
    }
    const inferred = {
      pid: portPid,
      port: targetPort,
      startedAt: '',
      rootDir: config.rootDir,
      script: path.join(config.rootDir, 'src', 'server-entry.js')
    };
    writeState(inferred);
    return inferred;
  }
  if (!isProcessAlive(Number(state.pid))) {
    const portPid = findPidByPort(targetPort);
    if (!portPid) {
      removeState();
      return null;
    }
    const inferred = {
      ...state,
      pid: portPid,
      port: targetPort,
      rootDir: config.rootDir,
      script: path.join(config.rootDir, 'src', 'server-entry.js')
    };
    writeState(inferred);
    return inferred;
  }
  return state;
}

async function startServer() {
  const active = getLiveState();
  if (active) {
    console.log(`Server is already running on port ${active.port} (PID ${active.pid}).`);
    return;
  }

  const child = spawn(process.execPath, [path.join('src', 'server-entry.js')], {
    cwd: config.rootDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(targetPort) }
  });
  child.unref();

  writeState({
    pid: child.pid,
    port: targetPort,
    startedAt: new Date().toISOString(),
    rootDir: config.rootDir,
    script: path.join(config.rootDir, 'src', 'server-entry.js')
  });

  console.log(`Server started on http://localhost:${targetPort} (PID ${child.pid}).`);
}

async function stopServer() {
  const active = getLiveState();
  if (!active) {
    console.log('Server is not running.');
    return;
  }

  let result;
  if (process.platform === 'win32') {
    result = spawnSync('taskkill', ['/PID', String(active.pid), '/T', '/F'], {
      cwd: config.rootDir,
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    result = spawnSync('kill', ['-TERM', String(active.pid)], {
      cwd: config.rootDir,
      stdio: 'ignore'
    });
  }

  if (result.status !== 0 && isProcessAlive(Number(active.pid))) {
    throw new Error(`Failed to stop server process ${active.pid}.`);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(Number(active.pid))) {
      removeState();
      console.log(`Server stopped (PID ${active.pid}).`);
      return;
    }
    await delay(250);
  }

  removeState();
  console.log(`Stop signal sent to PID ${active.pid}.`);
}

async function restartServer() {
  await stopServer();
  await delay(600);
  await startServer();
}

function printStatus() {
  const active = getLiveState();
  if (!active) {
    console.log('Server status: stopped.');
    return;
  }
  console.log(`Server status: running on http://localhost:${active.port} (PID ${active.pid}).`);
}

try {
  if (command === 'start') {
    await startServer();
  } else if (command === 'stop') {
    await stopServer();
  } else if (command === 'restart') {
    await restartServer();
  } else {
    printStatus();
  }
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
