import { writeFile } from 'node:fs/promises';
import { publicPortfolio } from '../../src/data/public';

// Build step, not a runtime import: the API ships with this JSON and never reads frontend TypeScript.
// The field allowlist lives in src/data/public.ts, shared with the site's /portfolio.json.
const knowledge = publicPortfolio();

const target = new URL('./knowledge.json', import.meta.url);
await writeFile(target, `${JSON.stringify(knowledge, null, 2)}\n`);
console.log(`Wrote ${knowledge.projects.length} projects, ${knowledge.research.length} research entries and ${knowledge.featuredRepos.length} featured repositories to src/knowledge.json`);
