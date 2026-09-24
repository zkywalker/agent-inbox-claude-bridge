import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const version = process.argv[2], platform = `${process.platform}-${process.arch}`;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') || !['linux-x64', 'darwin-arm64', 'darwin-x64'].includes(platform) || process.env.EXPECTED_PLATFORM && process.env.EXPECTED_PLATFORM !== platform) throw new Error('Invalid release version or platform');
const root = resolve('release'), name = `claude-bridge-${version}-${platform}`, target = join(root, name);
await mkdir(root, { recursive: true }); await mkdir(target);
for (const file of ['dist', 'package.json', 'package-lock.json', 'README.md', 'RELEASE.md', 'HOST-DEPLOYMENT.md', 'SECURITY.md', 'SOURCE.json']) await cp(file, join(target, file), { recursive: true });
await writeFile(join(target, 'bridge-version.json'), JSON.stringify({ product: 'claude-bridge', version, platform }) + '\n');
execFileSync('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-bin-links'], { cwd: target, stdio: 'inherit' });
const anthropicPackages = await readdir(join(target, 'node_modules/@anthropic-ai'));
if (anthropicPackages.some(name => /^claude-agent-sdk-(linux|darwin|win32)/.test(name))) throw new Error('Do not redistribute native Claude binaries');
const fixture = await mkdtemp(join(tmpdir(), 'claude-package-'));
try {
  const binary = join(fixture, 'claude-fixture');
  await writeFile(binary, '#!/bin/sh\nprintf "2.1.281 (Claude Code)\\n"\n', { mode: 0o700 });
  const config = join(fixture, 'config.json');
  await writeFile(config, JSON.stringify({ gatewayUrl: 'http://localhost', token: 'package-fixture-token-not-used', stateDir: join(fixture, 'state'), projectPath: fixture, claudeBinary: binary }), { mode: 0o600 });
  execFileSync(process.execPath, [join(target, 'dist/adapters/claude/main.js'), '--validate', config], { stdio: 'inherit', timeout: 20_000 });
} finally { await rm(fixture, { recursive: true, force: true }); }
const archive = join(root, `${name}.tar.gz`);
execFileSync('tar', ['-C', root, '-czf', archive, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const bytes = await readFile(archive);
if (bytes.length > 256 * 1024 * 1024) throw new Error('Archive exceeds manifest limit');
await writeFile(join(root, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}.tar.gz\n`);
await rm(target, { recursive: true });
console.log(`Packaged ${name}; native Claude installation is a host prerequisite.`);
