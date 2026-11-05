import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const overrides = {
  'abstract-logging': 'third-party/licenses/abstract-logging.txt',
  'client-only': 'third-party/licenses/client-only.txt',
};

// Include all installed production dependencies, including lazily loaded renderers.
export async function writeDependencyNotices(destination) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const sections = ['OpenBot dependency notices\n\nDependencies retain their original licenses.'];
  const seen = new Set();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location.startsWith('node_modules/') || entry.dev || entry.link) continue;
    const directory = join(root, location);
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (entry.optional && error.code === 'ENOENT') continue;
      throw error;
    }
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (file) =>
          file.isFile() && /^(?:licen[sc]e|copying|notice|copyright)(?:[._-].*)?$/i.test(file.name),
      )
      .map((file) => file.name)
      .sort();
    const license = typeof pkg.license === 'string' ? pkg.license : entry.license;
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const text = [
      `${id}\nLicense: ${license || 'See license text'}${repository ? `\nSource: ${repository}` : ''}`,
    ];
    for (const filename of files)
      text.push(`${filename}\n\n${await readFile(join(directory, filename), 'utf8')}`);
    if (!files.length) {
      if (!overrides[pkg.name]) throw new Error(`Missing license text for ${id}`);
      text.push(await readFile(join(root, overrides[pkg.name]), 'utf8'));
    }
    sections.push(text.join('\n\n'));
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
  console.log(`Dependency notices prepared for ${seen.size} packages.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Supply an output file path');
  await writeDependencyNotices(resolve(process.argv[2]));
}
