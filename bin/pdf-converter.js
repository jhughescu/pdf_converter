#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const entryPath = path.join(__dirname, '..', 'index.js');
const forwardedArgs = process.argv.slice(2);

const child = spawn(process.execPath, [entryPath, '--pdf-converter-supervisor', ...forwardedArgs], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', code => {
  process.exit(code || 0);
});
