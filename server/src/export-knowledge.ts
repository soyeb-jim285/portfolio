import { writeFile } from 'node:fs/promises';
import { person, projects, work, research, skills } from '../../src/data/content';

// Build step, not a runtime import: the API ships with this JSON and never reads frontend TypeScript.
// Every field is listed explicitly, so nothing from the CV provenance can leak in by accident.
// Repositories the portfolio itself points at: these are the ones a visitor is most likely
// asking about, so retrieval gives them a nudge.
const featuredRepos = [...new Set(projects.flatMap(project =>
  project.links
    .map(link => /github\.com\/[^/]+\/([^/#?]+)/.exec(link.href)?.[1])
    .filter((name): name is string => Boolean(name))
    .map(name => name.replace(/\.git$/, ''))))];

const knowledge = {
  generatedAt: new Date().toISOString(),
  featuredRepos,
  person: { name: person.name, role: person.role, location: person.location, email: person.email, links: person.links },
  // The numbers ride along so the assistant can quote them; the daily count refresh re-exports this file.
  // The prompt carries what answers most questions: summaries, facts, numbers, results. The long
  // write-ups ride in `details` behind the portfolio_details tool, so every model step of every
  // answer stops resending a few thousand tokens that most questions never need.
  projects: projects.map(({ slug, name, summary, stack, links, stars, forks, contributors, facts }) => ({
    slug, name, summary, stack, links, stars, forks, facts,
    ...(contributors ? { contributors, outsideContributors: contributors - 1 } : {}),
  })),
  work: { employer: work.employer, product: work.product, title: work.title, period: work.period, remote: work.remote, context: work.context, ownership: work.ownership, bullets: work.bullets, stack: work.stack },
  research: research.map(({ slug, title, short, venue, status, finding, results }) => ({ slug, title, short, venue, status, finding, results })),
  skills,
  details: Object.fromEntries([
    ...projects.map(({ slug, body, reception }) => [slug, { body, ...(reception ? { reception } : {}) }]),
    ...research.map(({ slug, abstract, keywords }) => [slug, { abstract, keywords }]),
  ]),
};

const target = new URL('./knowledge.json', import.meta.url);
await writeFile(target, `${JSON.stringify(knowledge, null, 2)}\n`);
console.log(`Wrote ${knowledge.projects.length} projects, ${knowledge.research.length} research entries and ${featuredRepos.length} featured repositories to src/knowledge.json`);
