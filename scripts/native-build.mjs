import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, symlink, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const bundle = join(root, 'apps/desktop/src-tauri/target/release/bundle');
const application = join(bundle, 'macos/Personal OpenBot Group.app');
const destination = join(bundle, 'dmg', `Personal-OpenBot-Group_${version}_${process.arch}.dmg`);
const identity = process.env.APPLE_SIGNING_IDENTITY;
const profile = process.env.APPLE_NOTARY_PROFILE;
const teamId = process.env.APPLE_TEAM_ID;
const notarizeOnly = process.argv.includes('--notarize-only');

if (identity || profile || notarizeOnly) {
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId))
    throw new Error('Signing requires an explicit APPLE_TEAM_ID (10 uppercase letters/digits)');
  if (!identity?.startsWith('Developer ID Application: ') || !identity.endsWith(`(${teamId})`))
    throw new Error('APPLE_SIGNING_IDENTITY must be a Developer ID Application for APPLE_TEAM_ID');
}

async function run(command, args, env = process.env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env,
    });
    let output = '';
    let error = '';
    if (capture) {
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        error += chunk;
      });
    }
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(capture === 'combined' ? output + error : output)
        : reject(new Error(`${command} exited with ${code}${capture ? `: ${error.trim()}` : ''}`)),
    );
  });
}

async function verifySigningTeam(path) {
  await run('codesign', ['--verify', '--deep', '--strict', path]);
  const details = await run(
    'codesign',
    ['--display', '--verbose=4', path],
    process.env,
    'combined',
  );
  if (!details.split(/\r?\n/).includes(`TeamIdentifier=${teamId}`))
    throw new Error(
      'Application signature does not match APPLE_TEAM_ID; rebuild with the correct certificate',
    );
  if (!details.includes('Authority=Developer ID Application: '))
    throw new Error('Application must have a Developer ID Application signature');
}

async function signApplication() {
  const runtime = join(application, 'Contents/Resources/runtime');
  const entitlements = join(root, 'apps/desktop/src-tauri/node.entitlements.plist');
  const sign = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime'];
  await run('codesign', [...sign, '--entitlements', entitlements, join(runtime, 'bin/node')]);
  async function signLibraries(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await signLibraries(path);
      else if (/\.(?:node|dylib)$/.test(item.name)) await run('codesign', [...sign, path]);
    }
  }
  await signLibraries(join(runtime, 'node_modules'));
  await run('codesign', [...sign, application]);
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', application]);
  await verifySigningTeam(application);
}

async function notarize(path, label) {
  const output = await run(
    'xcrun',
    [
      'notarytool',
      'submit',
      path,
      ...(process.env.APPLE_NOTARY_S3_ACCELERATION === 'false' ? ['--no-s3-acceleration'] : []),
      '--keychain-profile',
      profile,
      '--wait',
      '--timeout',
      '20m',
      '--output-format',
      'json',
    ],
    process.env,
    true,
  );
  const submission = JSON.parse(output);
  console.log(`${label} notarization: ${submission.status} (${submission.id})`);
  if (submission.status !== 'Accepted') {
    const log = join(bundle, 'dmg', `notarization-${submission.id}.json`);
    await mkdir(join(bundle, 'dmg'), { recursive: true });
    await run('xcrun', ['notarytool', 'log', submission.id, '--keychain-profile', profile, log]);
    throw new Error(`Apple rejected ${label}; inspect ${log}`);
  }
  if (!path.endsWith('.zip')) {
    await run('xcrun', ['stapler', 'staple', path]);
    await run('xcrun', ['stapler', 'validate', path]);
  }
  return submission.id;
}

if (notarizeOnly && (process.platform !== 'darwin' || !identity || !profile))
  throw new Error(
    '--notarize-only requires macOS, APPLE_SIGNING_IDENTITY and APPLE_NOTARY_PROFILE',
  );

if (!notarizeOnly) {
  await run('npm', ['run', 'release:check']);
  await run('npm', ['run', 'typecheck']);
  const args = ['run', 'tauri', '-w', '@openbot/desktop', '--', 'build'];
  if (process.platform === 'darwin') args.push('--bundles', 'app');
  await run('npm', args, {
    ...process.env,
    PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`,
  });
  if (process.platform === 'darwin' && identity) await signApplication();
  await run(process.execPath, ['scripts/smoke/embedded-runtime.mjs'], {
    ...process.env,
    ...(process.platform === 'darwin'
      ? { OPENBOT_RUNTIME_DIR: join(application, 'Contents/Resources/runtime') }
      : {}),
  });
}

if (process.platform === 'darwin') {
  const packagedVersion = (
    await run(
      'plutil',
      [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        join(application, 'Contents/Info.plist'),
      ],
      process.env,
      true,
    )
  ).trim();
  if (packagedVersion !== version)
    throw new Error(`Packaged version ${packagedVersion} does not match source version ${version}`);
  const staging = await mkdtemp(join(tmpdir(), 'openbot-release-'));
  const submissions = {};
  try {
    if (profile) {
      if (!identity) throw new Error('Notarization requires APPLE_SIGNING_IDENTITY');
      await verifySigningTeam(application);
      const archive = join(staging, 'Personal-OpenBot-Group.zip');
      await run('ditto', ['-c', '-k', '--keepParent', application, archive]);
      submissions.application = await notarize(archive, 'application archive');
      // ZIPs cannot carry tickets; staple the accepted application itself.
      await run('xcrun', ['stapler', 'staple', application]);
      await run('xcrun', ['stapler', 'validate', application]);
      await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', application]);
    }
    await mkdir(join(bundle, 'dmg'), { recursive: true });
    const imageSource = join(staging, 'image');
    await mkdir(imageSource);
    // Preserve macOS metadata, including the application's stapled ticket.
    await run('ditto', [application, join(imageSource, 'Personal OpenBot Group.app')]);
    await symlink('/Applications', join(imageSource, 'Applications'));
    await run('hdiutil', [
      'create',
      '-volname',
      'Personal OpenBot Group',
      '-srcfolder',
      imageSource,
      '-ov',
      '-format',
      'UDZO',
      destination,
    ]);
    if (identity) {
      await run('codesign', ['--force', '--sign', identity, '--timestamp', destination]);
      await run('codesign', ['--verify', '--strict', '--verbose=2', destination]);
    }
    if (profile) {
      submissions.diskImage = await notarize(destination, 'disk image');
      await run('spctl', [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose=2',
        destination,
      ]);
    }
    const sha256 = createHash('sha256')
      .update(await readFile(destination))
      .digest('hex');
    await writeFile(
      join(bundle, 'dmg', 'SHA256SUMS'),
      `${sha256}  Personal-OpenBot-Group_${version}_${process.arch}.dmg\n`,
    );
    await writeFile(
      join(bundle, 'dmg', 'release-metadata.json'),
      JSON.stringify(
        {
          version,
          platform: process.platform,
          arch: process.arch,
          signed: Boolean(identity),
          notarized: Boolean(profile),
          teamId: identity ? teamId : null,
          submissions,
          sha256,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`DMG ready: ${destination}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
