import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbot-release-check-'));
  directories.push(directory);
  const write = (name: string, content: string) => {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), content);
  };
  for (const name of [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/README.md',
    'docs/releasing.md',
  ])
    write(name, 'Release fixture\n');
  write('README.md', '[Documentation](docs/README.md)\n');
  write('.env.example', 'API_KEY=\n');
  write('.gitignore', '*.p8\n');
  write('package.json', JSON.stringify({ name: 'openbot', version: '1.0.0' }));
  write(
    'package-lock.json',
    JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }),
  );
  write('apps/desktop/src-tauri/tauri.conf.json', JSON.stringify({ version: '1.0.0' }));
  write(
    'apps/desktop/src-tauri/Cargo.toml',
    '[package]\nname = "openbot-desktop"\nversion = "1.0.0"\n',
  );
  write(
    'apps/desktop/src-tauri/Cargo.lock',
    '[[package]]\nname = "openbot-desktop"\nversion = "1.0.0"\n',
  );
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(
    new URL('../../scripts/check-release.mjs', import.meta.url),
    join(directory, 'scripts/check-release.mjs'),
  );
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
  };
  const check = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['scripts/check-release.mjs', ...args], {
      cwd: directory,
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { directory, write, git, commit, check };
}

it('accepts clean source and history, and rejects broken links and mismatched versions', () => {
  const f = fixture();
  f.commit();
  expect(f.check('--history').status).toBe(0);
  f.write('README.md', '[Missing](missing.md)\n');
  f.write('apps/desktop/src-tauri/tauri.conf.json', JSON.stringify({ version: '2.0.0' }));
  const result = f.check();
  expect(result.status).toBe(1);
  expect(result.output).toContain('broken local link');
  expect(result.output).toContain('tauri.conf.json: version must match');
});

it('detects deleted historical credentials without printing the secret', () => {
  const f = fixture();
  const secret = 'sk-' + 'x'.repeat(32);
  f.write('removed-config.ts', `export const key = '${secret}';\n`);
  f.commit();
  f.git('rm', 'removed-config.ts');
  f.git('commit', '-qm', 'remove credential');
  expect(f.check().status).toBe(0);
  const result = f.check('--history');
  expect(result.status).toBe(1);
  expect(result.output).toContain('removed-config.ts:1: API key');
  expect(result.output).not.toContain(secret);
});

it('rejects force-added signing keys and dangling symlinks', () => {
  const f = fixture();
  f.write('signing.p8', 'credential fixture\n');
  f.git('add', '--force', 'signing.p8');
  symlinkSync('missing-target', join(f.directory, 'dangling'));
  const result = f.check();
  expect(result.status).toBe(1);
  expect(result.output).toContain('signing.p8: local data, credentials');
  expect(result.output).toContain('dangling: review symlink');
});

it('rejects an unspecified or mismatched signing team before invoking build tools', () => {
  const script = fileURLToPath(new URL('../../scripts/native-build.mjs', import.meta.url));
  for (const teamId of ['', 'BBBBBBBBBB']) {
    const result = spawnSync(process.execPath, [script, '--notarize-only'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (AAAAAAAAAA)',
        APPLE_TEAM_ID: teamId,
        APPLE_NOTARY_PROFILE: 'release-fixture',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('APPLE_TEAM_ID');
    expect(result.stdout).not.toContain('tauri');
  }
});
