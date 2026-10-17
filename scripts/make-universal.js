#!/usr/bin/env node
/* Merges the x64 and arm64 Snap.app bundles into one universal bundle and
 * re-signs it. Usage: node scripts/make-universal.js <x64.app> <arm64.app> <out.app> [identity]
 */
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  const [x64AppPath, arm64AppPath, outAppPath, identity = '-'] = process.argv.slice(2);
  if (!x64AppPath || !arm64AppPath || !outAppPath) {
    console.error('usage: make-universal.js <x64.app> <arm64.app> <out.app> [identity]');
    process.exit(2);
  }

  const { makeUniversalApp } = require('@electron/universal');

  await makeUniversalApp({
    x64AppPath,
    arm64AppPath,
    outAppPath,
    force: true,
    mergeASARs: false,
    // per-arch build products inside the payload (the native helper is a Mach-O
    // binary, so it gets lipo'd; anything else arch-specific is listed here)
    singleArchFiles: '**/build/winsnap',
  });

  const payload = path.join(outAppPath, 'Contents', 'Resources', 'app', 'build', 'winsnap');
  const archs = execFileSync('lipo', ['-archs', path.join(outAppPath, 'Contents', 'MacOS', 'Snap')])
    .toString().trim();
  const helperArchs = execFileSync('lipo', ['-archs', payload]).toString().trim();
  console.log(`  · main binary archs: ${archs}`);
  console.log(`  · winsnap archs:     ${helperArchs}`);
}

main().catch((err) => {
  console.error('universal merge failed:', err && err.message ? err.message : err);
  process.exit(1);
});
