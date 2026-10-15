// After `cap sync android`, give each app flavor its own Capacitor config so the Station app opens the
// station terminal and the Wallet app opens the employee wallet. APP_URL overrides the server.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const base = (process.env.APP_URL ?? 'https://bousol-prepaid-fuel.vercel.app').replace(/\/$/, '');
const main = 'android/app/src/main/assets/capacitor.config.json';
const config = JSON.parse(readFileSync(main, 'utf8'));
for (const [flavor, path] of [['station', '/station'], ['wallet', '/employee']]) {
  const dir = `android/app/src/${flavor}/assets`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/capacitor.config.json`, JSON.stringify({ ...config, server: { ...config.server, url: base + path } }, null, 2));
  console.log(`${flavor}: ${base + path}`);
}
rmSync(main);
