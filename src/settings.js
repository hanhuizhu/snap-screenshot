'use strict';

/**
 * Tiny persisted settings store (userData/settings.json).
 * Values are read lazily because app.getPath('userData') needs a ready app.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const DEFAULTS = {
  keepAwake: false,     // prevent display sleep
  openAtLogin: false,   // start with the system
  hotkey: null,         // override ⌃⌘A
  panelBounds: null,    // last console window rect {x,y,width,height,maximized}
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json');
  return filePath;
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get(key, fallback) {
  const v = load()[key];
  if (v === undefined || v === null) return fallback !== undefined ? fallback : DEFAULTS[key];
  return v;
}

function all() {
  return { ...load() };
}

function set(key, value) {
  load()[key] = value;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load(), null, 2));
  } catch {
    /* settings are best-effort */
  }
  return value;
}

module.exports = { get, set, all, DEFAULTS };
