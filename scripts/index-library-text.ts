import { runTextIndex, textConfig } from '../src/services/library-text';
import { TextStore } from '../src/services/library-text/store';
async function main() {
const args = process.argv.slice(2);
if (!(args.length === 1 && args[0] === '--all') && !(args.length === 2 && args[0] === '--sample' && /^\d+$/.test(args[1]))) throw new Error('Use --sample 20 or --all');
const config = await textConfig();
const store = new TextStore(config.databaseFile, config.rootId);
const timer = setInterval(() => console.log(JSON.stringify(store.progress())), 30_000);
try {
  const result = await runTextIndex({ ...config, store, sample: args[0] === '--sample' ? Math.max(1, Math.min(20, Number(args[1]))) : undefined });
  console.log(JSON.stringify({ progress: result.progress, stats: result.stats }));
  if (result.progress?.error) process.exitCode = 1;
} finally { clearInterval(timer); store.close(); }

}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
