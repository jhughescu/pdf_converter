#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const entryPath = path.join(__dirname, '..', 'index.js');

const child = spawn(process.execPath, [entryPath], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', code => {
  process.exit(code || 0);
});
