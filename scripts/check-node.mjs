// Fails fast with a human explanation instead of a cryptic syntax error three
// packages deep. Runs on `pnpm install` via the `prepare` script.
const REQUIRED_MAJOR = 22;

const [major] = process.versions.node.split('.').map(Number);

if (typeof major !== 'number' || Number.isNaN(major) || major < REQUIRED_MAJOR) {
  console.error(
    [
      '',
      `HQPixels requires Node.js ${REQUIRED_MAJOR} or newer (you have ${process.versions.node}).`,
      '',
      'Install it with one of:',
      '  nvm install 22 && nvm use 22          (macOS / Linux)',
      '  winget install OpenJS.NodeJS.LTS      (Windows)',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
