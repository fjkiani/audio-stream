#!/usr/bin/env node
// Remove the preinstall guard from package.json before pnpm install
// The guard blocks non-pnpm user agents, which breaks CI environments
import { readFileSync, writeFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.scripts && pkg.scripts.preinstall) {
  delete pkg.scripts.preinstall;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log('Removed preinstall guard from package.json');
} else {
  console.log('No preinstall guard found');
}
