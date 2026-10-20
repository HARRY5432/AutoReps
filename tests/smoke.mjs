import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.service_worker, 'background.js');
assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
assert.deepEqual(manifest.content_scripts[0].js, ['content/perception.js', 'content/actor.js']);

for (const file of [
  'background.js',
  'sidepanel.js',
  'lib/ai-provider.js',
  'content/perception.js',
  'content/actor.js'
]) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
}

const perception = read('content/perception.js');
const provider = read('lib/ai-provider.js');
const actor = read('content/actor.js');
const sidepanel = read('sidepanel.js');
const fixture = read('test-page.html');

assert.match(perception, /autorep\.page-intelligence\.v1/);
assert.match(perception, /snapshotId/);
assert.match(perception, /candidateCount/);
assert.match(perception, /contentSignals/);
assert.match(perception, /open-shadow-dom/);
assert.match(perception, /inaccessibleFrames/);
assert.match(perception, /actionabilityReasons/);
assert.match(perception, /getRegistryEntry/);

assert.match(provider, /snapshotId/);
assert.match(provider, /INVENTORY/);
assert.match(provider, /CONTROLS/);
assert.match(provider, /Do not request or expose outerHTML/);
assert.doesNotMatch(provider, /elements\.map\(e => \(\{ id: e\.id, role: e\.role, name: e\.name, tag: e\.tag \}\)\)\.slice\(0, 80\)/);

assert.match(actor, /STALE_SNAPSHOT/);
assert.match(actor, /STALE_TARGET/);
assert.match(actor, /snapshotId/);
assert.match(sidepanel, /snapshotId:s\.snapshot\.snapshotId/);
assert.match(sidepanel, /validatePlan/);
assert.match(sidepanel, /human review required/);

assert.match(fixture, /attachShadow/);
assert.match(fixture, /type="checkbox"/);
assert.match(fixture, /<select>/);
assert.match(fixture, /<button/);

console.log('AutoRep smoke checks passed');
