import { build } from 'esbuild';
import { cp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDependencyNotices } from './write-dependency-notices.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'apps/desktop/src-tauri/runtime');
const require = createRequire(import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'bin'), { recursive: true });
await cp(
  process.execPath,
  join(output, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
  { dereference: true },
);
await chmod(join(output, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), 0o755);
await build({
  absWorkingDir: root,
  entryPoints: { host: 'apps/desktop-runtime/host.mts', bridge: 'apps/bridge/src/index.ts' },
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['better-sqlite3', 'bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __runtimeRequire } from 'node:module'; import { fileURLToPath as __runtimeFile } from 'node:url'; import { dirname as __runtimeDir } from 'node:path'; const require = __runtimeRequire(import.meta.url); const __filename = __runtimeFile(import.meta.url); const __dirname = __runtimeDir(__filename);",
  },
  logLevel: 'warning',
});
for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  const source = dirname(require.resolve(name + '/package.json'));
  await cp(source, join(output, 'node_modules', name), {
    recursive: true,
    dereference: true,
    filter: (path) => !path.includes('/node_modules/') || path.startsWith(source),
  });
}
await cp(join(root, 'apps/server/migrations'), join(output, 'migrations'), { recursive: true });
await cp(join(root, 'packages/shared/ui-contract'), join(output, 'ui-contract'), {
  recursive: true,
});
await writeFile(
  join(output, 'version.json'),
  JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }),
);
await cp(join(root, 'LICENSE'), join(output, 'OPENBOT-LICENSE'));
await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'));
await writeDependencyNotices(join(output, 'THIRD_PARTY_LICENSES.txt'));
// Retain the embedded runtime's license alongside the redistributed executable.
const nodeLicense = join(dirname(process.execPath), '../LICENSE');
try {
  await cp(nodeLicense, join(output, 'NODE-LICENSE'));
} catch {
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
  );
  if (!response.ok) throw new Error('Cannot obtain Node.js license');
  await writeFile(join(output, 'NODE-LICENSE'), await response.text());
}
console.log('Embedded local runtime prepared.');
