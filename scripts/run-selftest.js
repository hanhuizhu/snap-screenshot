#!/usr/bin/env node
/* Runs the in-app self-test: electron . with SNAP_SELFTEST=1. */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');            // → path to the electron binary
const root = path.join(__dirname, '..');
const savePath = path.join(root, 'build', 'test-out', 'saved.png');

const child = spawn(electron, [root], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    SNAP_SELFTEST: '1',
    SNAP_DEMO: '1',
    SNAP_TEST_SAVE: process.env.SNAP_TEST_SAVE || savePath,
    ELECTRON_ENABLE_LOGGING: '',
  },
});

const timer = setTimeout(() => {
  console.error('[selftest] hard timeout after 180s');
  try { child.kill('SIGKILL'); } catch {}
  process.exit(1);
}, 180000);

child.on('exit', (code) => {
  clearTimeout(timer);
  process.exit(code === null ? 1 : code);
});
