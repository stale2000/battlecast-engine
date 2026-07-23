import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'battlecast-engine-package-'));
const npmCli = process.env.npm_execpath;

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function runNpm(args, options) {
  if (!npmCli) throw new Error('npm_execpath is required to run the package smoke test.');
  return run(process.execPath, [npmCli, ...args], options);
}

try {
  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', scratch]));
  const tarball = join(scratch, basename(packed[0].filename));
  const installDir = join(scratch, 'install');
  mkdirSync(installDir);
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: installDir });

  const installed = join(installDir, 'node_modules', 'battlecast-engine');
  for (const file of ['LICENSE', 'README.md', 'dist/arena.js', 'dist/mcp/cli.js']) {
    if (!existsSync(join(installed, file))) throw new Error(`Packed artifact is missing ${file}.`);
  }

  const request = JSON.stringify({
    version: 1, mode: 'init', seed: 7, mapId: 'open-arena', roundCap: 20,
    redParty: { characters: Array.from({ length: 4 }, () => ({ heroClass: 'Fighter', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 } })) },
    blueParty: { characters: Array.from({ length: 4 }, () => ({ heroClass: 'Fighter', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 } })) },
  });
  const binary = process.platform === 'win32' ? join(installDir, 'node_modules', '.bin', 'battlecast-engine.cmd') : join(installDir, 'node_modules', '.bin', 'battlecast-engine');
  if (!existsSync(binary)) throw new Error('Packed artifact did not install the battlecast-engine command.');
  const command = process.platform === 'win32' ? process.execPath : binary;
  const args = process.platform === 'win32' ? [join(installed, 'dist', 'mcp', 'cli.js'), 'arena', 'kaggle-step'] : ['arena', 'kaggle-step'];
  const response = run(command, args, { cwd: installDir, input: request, stdio: ['pipe', 'pipe', 'pipe'] });
  const parsed = JSON.parse(response);
  if (!parsed.state || !parsed.observations || !parsed.statuses || !parsed.rewards) throw new Error('Installed CLI returned an invalid arena response.');
  if (!readFileSync(join(installed, 'LICENSE'), 'utf8').includes('CC-BY-4.0')) throw new Error('Packed LICENSE is missing SRD attribution.');
  console.log(`Package smoke test passed: ${packed[0].filename}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
