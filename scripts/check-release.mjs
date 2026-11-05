// Inspect publishable source without printing suspected credential values.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const files = [
  ...new Set(
    git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .toString()
      .split('\0')
      .filter(Boolean),
  ),
];
const problems = [];
const maxSize = 5 * 1024 * 1024;
const forbidden =
  /(?:^|\/)(?:\.data|node_modules|target|dist|test-results|playwright-report|coverage|\.ssh|\.codex|\.claude)(?:\/|$)|(?:^|\/)(?:\.env(?:\..+)?|config\.env|model-settings\.json(?:\..*)?)$|\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$|\.(?:pem|key|p8|p12|pfx|cer|certSigningRequest|mobileprovision|provisionprofile|keychain(?:-db)?|dmg|zip|log)$|\.tar\.gz$|(?:^|\/)[^/]+\.app(?:\/|$)/i;
const forbiddenPath = (name) => forbidden.test(name) && !/(?:^|\/)\.env\.example$/.test(name);
const checks = [
  ['local home path', /(?:\/Users\/|\/home\/)[^\s"'<>`]+|[A-Z]:\\Users\\[^\s"'<>`]+/],
  [
    'API key',
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/,
  ],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['credential in URL', /https?:\/\/[^\s/:@]+:[^\s/@]+@/],
];
function inspectContent(label, content) {
  if (content.includes(0)) return;
  for (const [index, line] of content.toString('utf8').split(/\r?\n/).entries())
    for (const [description, pattern] of checks)
      if (pattern.test(line)) problems.push(`${label}:${index + 1}: ${description}`);
}
function inspectLinks(name, content) {
  const markdown = content.toString('utf8').replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '');
  for (const match of markdown.matchAll(
    /!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g,
  )) {
    const href = match[1] ?? match[2];
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) continue;
    let path;
    try {
      path = decodeURIComponent(href.split(/[?#]/)[0]);
    } catch {
      problems.push(`${name}: malformed local link`);
      continue;
    }
    const target = resolve(dirname(resolve(root, name)), path);
    if ((target !== root && !target.startsWith(root + sep)) || !existsSync(target))
      problems.push(`${name}: broken local link to ${path}`);
  }
}
for (const name of files) {
  if (forbiddenPath(name)) {
    problems.push(`${name}: local data, credentials or generated output must not be published`);
    continue;
  }
  const filename = resolve(root, name);
  let stat;
  try {
    stat = lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') continue; // Staged or unstaged deletions.
    throw error;
  }
  if (stat.isSymbolicLink()) {
    problems.push(`${name}: review symlink before publishing`);
    continue;
  }
  if (!stat.isFile()) continue;
  if (stat.size > maxSize) {
    problems.push(`${name}: file larger than 5 MiB needs review`);
    continue;
  }
  const content = readFileSync(filename);
  inspectContent(name, content);
  if (name.endsWith('.md')) inspectLinks(name, content);
}
for (const required of [
  'LICENSE',
  'README.md',
  '.env.example',
  'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/releasing.md',
])
  if (!files.includes(required) || !existsSync(resolve(root, required)))
    problems.push(`${required}: missing from source files`);

// Lockfiles are part of the release contract, rather than optional generated caches.
const readJson = (name) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const { version } = readJson('package.json');
const lock = readJson('package-lock.json');
const checkVersion = (name, actual) => {
  if (actual !== version)
    problems.push(`${name}: version must match root package.json (${version})`);
};
checkVersion('package-lock.json', lock.version);
checkVersion('package-lock.json packages root', lock.packages?.['']?.version);
for (const name of files.filter((name) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(name))) {
  const pkg = readJson(name);
  if (!pkg.name?.startsWith('@openbot/')) continue;
  checkVersion(name, pkg.version);
  checkVersion(`package-lock.json ${dirname(name)}`, lock.packages?.[dirname(name)]?.version);
}
checkVersion('tauri.conf.json', readJson('apps/desktop/src-tauri/tauri.conf.json').version);
const cargo = readFileSync(resolve(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
checkVersion('Cargo.toml', cargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]);
const cargoLock = readFileSync(resolve(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
checkVersion(
  'Cargo.lock',
  cargoLock.match(/\[\[package\]\]\s+name = "openbot-desktop"\s+version = "([^"]+)"/)?.[1],
);

let historicalBlobs = 0;
if (process.argv.includes('--history')) {
  const commits = git(['rev-list', '--all']).toString().trim().split('\n').filter(Boolean);
  const blobs = new Map();
  const checkedPaths = new Set();
  for (const commit of commits) {
    for (const entry of git(['ls-tree', '-r', '-z', commit])
      .toString()
      .split('\0')
      .filter(Boolean)) {
      const [metadata, ...parts] = entry.split('\t');
      const name = parts.join('\t');
      const [mode, type, oid] = metadata.split(' ');
      if (type !== 'blob') continue;
      const label = `history:${commit.slice(0, 8)}:${name}`;
      const pathMode = `${mode}:${name}`;
      if (!checkedPaths.has(pathMode)) {
        if (forbiddenPath(name)) problems.push(`${label}: forbidden historical file`);
        if (mode === '120000') problems.push(`${label}: historical symlink needs review`);
        checkedPaths.add(pathMode);
      }
      if (!blobs.has(oid)) blobs.set(oid, label);
    }
  }
  for (const [oid, label] of blobs) {
    if (Number(git(['cat-file', '-s', oid]).toString()) > maxSize) {
      problems.push(`${label}: historical file larger than 5 MiB needs review`);
      continue;
    }
    inspectContent(label, git(['cat-file', 'blob', oid]));
  }
  historicalBlobs = blobs.size;
}
if (problems.length) {
  console.error('Release check failed:\n' + [...new Set(problems)].map((p) => `- ${p}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Release check passed: ${files.length} source paths; versions and local documentation links verified; no detected credentials or local artifacts.${process.argv.includes('--history') ? ` Checked ${historicalBlobs} historical blobs.` : ''}`,
  );
}
