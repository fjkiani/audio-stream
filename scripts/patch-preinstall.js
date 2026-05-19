#!/usr/bin/env node
// Remove the preinstall guard from package.json before pnpm install
// The guard blocks non-pnpm user agents, which breaks CI environments
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.scripts && pkg.scripts.preinstall) {
  delete pkg.scripts.preinstall;
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log('Removed preinstall guard from package.json');
} else {
  console.log('No preinstall guard found');
}
