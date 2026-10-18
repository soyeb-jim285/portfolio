import {
  experimental_composeSpec,
  type Experimental_CompositionCandidate,
  type Experimental_CompositionCatalog,
  type Experimental_CompositionEvaluator,
  type Spec,
} from '@json-render/core';
import { z } from 'zod';
import { projects, research, skills, work } from '../../src/data/content';
import type { SourceHit } from './retrieval';

const boardProps = z.object({ eyebrow: z.string().max(60), title: z.string().max(100), note: z.string().max(180) }).strict();
const projectProps = z.object({
  name: z.string().max(100), kicker: z.string().max(180), summary: z.string().max(600), href: z.string().max(240),
  image: z.string().max(240).optional(), stack: z.array(z.string().max(60)).max(12), facts: z.array(z.object({ label: z.string(), value: z.string() }).strict()).max(8),
}).strict();
const researchProps = z.object({
  title: z.string().max(300), venue: z.string().max(180), status: z.string().max(100), finding: z.string().max(1000), href: z.string().max(240),
  results: z.array(z.object({ label: z.string(), value: z.string(), note: z.string() }).strict()).max(8),
}).strict();
const workProps = z.object({ employer: z.string(), title: z.string(), period: z.string(), summary: z.string(), stack: z.array(z.string()).max(12), href: z.string() }).strict();
const skillsProps = z.object({ label: z.string().max(80), items: z.array(z.string().max(80)).max(20) }).strict();
const evidenceProps = z.object({ repo: z.string(), path: z.string(), range: z.string(), commit: z.string(), href: z.string(), symbols: z.array(z.string()).max(8) }).strict();
const componentProps = { Board: boardProps, Project: projectProps, Research: researchProps, Work: workProps, Skills: skillsProps, Evidence: evidenceProps } as const;
const openRouterResponse = z.object({
  answers: z.record(z.string(), z.object({ choice: z.string(), confidence: z.number().optional() }).passthrough()),
  usage: z.object({ input_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
}).passthrough();

const elementSchema = z.object({
  type: z.enum(['Board', 'Project', 'Research', 'Work', 'Skills', 'Evidence']),
  props: z.record(z.string(), z.unknown()),
  children: z.array(z.string()).max(12).default([]),
  slots: z.record(z.string(), z.array(z.string()).max(12)).optional(),
}).passthrough();
const specSchema = z.object({
  root: z.string().min(1).max(100),
  elements: z.record(z.string(), elementSchema),
  state: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine((spec, context) => {
  if (!spec.elements[spec.root]) context.addIssue({ code: 'custom', path: ['root'], message: 'Root element is missing' });
  if (Object.keys(spec.elements).length > 8) context.addIssue({ code: 'custom', path: ['elements'], message: 'Too many elements' });
  for (const [id, element] of Object.entries(spec.elements)) {
    const parsed = componentProps[element.type].safeParse(element.props);
    if (!parsed.success) context.addIssue({ code: 'custom', path: ['elements', id, 'props'], message: 'Invalid component props' });
    for (const child of [...element.children, ...Object.values(element.slots ?? {}).flat()]) {
      if (!spec.elements[child]) context.addIssue({ code: 'custom', path: ['elements', id], message: 'Missing child element' });
    }
  }
});

const catalog: Experimental_CompositionCatalog = {
  data: {
    components: {
      Board: { props: boardProps, slots: ['default'] },
      Project: { props: projectProps },
      Research: { props: researchProps },
      Work: { props: workProps },
      Skills: { props: skillsProps },
      Evidence: { props: evidenceProps },
    },
    actions: {},
  },
  validate(spec) { return { success: specSchema.safeParse(spec).success }; },
};

export type GeneratedUi = { model: string; spec: Spec };
export type GenUiInput = { message: string; answer: string; sources: SourceHit[] };
export type GenUiComposer = (input: GenUiInput, signal: AbortSignal) => Promise<GeneratedUi | null>;

const roots = [
  ['overview-board', 'General visual summary for a portfolio answer. Use when several relevant work items or skills help.', 'Selected evidence', 'Relevant work', 'Chosen from the public portfolio for this question.'],
  ['comparison-board', 'Comparison board. Use only when the visitor asks to compare projects, research, approaches, or requirements.', 'Side by side', 'Comparison', 'The strongest directly relevant evidence, without inventing a score.'],
  ['research-board', 'Research results board. Use for papers, machine learning methods, experiments, or measured findings.', 'Research lens', 'Methods and results', 'Published portfolio evidence and clearly labelled research status.'],
] as const;

export function buildGenUiCandidates(sources: SourceHit[]): Experimental_CompositionCandidate[] {
  return [
    ...roots.map(([id, description, eyebrow, title, note]) => ({
      id, description, resource: 'root', element: { type: 'Board', props: { eyebrow, title, note } },
    })),
    ...projects.map(project => ({
      id: `project-${project.slug}`, root: false,
      description: `${project.name}, ${project.kicker}. ${project.summary} Stack: ${project.stack.join(', ')}.${project.facts?.length ? ` Facts: ${project.facts.map(fact => `${fact.label} ${fact.value}`).join('; ')}.` : ''}`,
      element: { type: 'Project', props: { name: project.name, kicker: project.kicker, summary: project.summary, href: `/projects/${project.slug}/`, ...(project.thumb || project.image ? { image: project.thumb ?? project.image } : {}), stack: project.stack, facts: project.facts ?? [] } },
    })),
    ...research.map(paper => ({
      id: `research-${paper.slug}`, root: false,
      description: `${paper.short}. ${paper.finding} Results: ${paper.results.map(result => `${result.label} ${result.value} ${result.note}`).join('; ')}. ${paper.status}.`,
      element: { type: 'Research', props: { title: paper.title, venue: paper.venue, status: paper.status, finding: paper.finding, href: paper.doi || '/research/', results: paper.results } },
    })),
    {
      id: 'work-fuego', root: false,
      description: `${work.title} at ${work.employer}, ${work.period}. ${work.context}. Public responsibilities: ${work.bullets.join(' ')}`,
      element: { type: 'Work', props: { employer: work.employer, title: work.title, period: work.period, summary: work.bullets.join(' '), stack: work.stack, href: '/work/' } },
    },
    ...Object.entries(skills).map(([group, items]) => ({
      id: `skills-${group}`, root: false,
      description: `${group} skills: ${items.join(', ')}. Include only when this skill group directly helps answer the visitor.`,
      element: { type: 'Skills', props: { label: group.toUpperCase(), items } },
    })),
    ...sources.slice(0, 10).map((source, index) => ({
      id: `evidence-${index + 1}`, root: false,
      description: `Exact source evidence from ${source.repo}/${source.path}:${source.startLine}-${source.endLine}. Symbols: ${source.symbols.join(', ') || 'none'}. Code excerpt: ${source.snippet.slice(0, 900)}`,
      element: { type: 'Evidence', props: { repo: source.repo, path: source.path, range: `${source.startLine}-${source.endLine}`, commit: source.commit.slice(0, 8), href: source.url, symbols: source.symbols.slice(0, 8) } },
    })),
  ];
}

export async function composeGenerativeUi(input: GenUiInput, evaluate: Experimental_CompositionEvaluator, signal: AbortSignal, model = 'typesafe/jev-1.13'): Promise<GeneratedUi | null> {
  let spec: Spec | null = null;
  for await (const event of experimental_composeSpec({
    catalog,
    candidates: buildGenUiCandidates(input.sources),
    prompt: `Compose an optional compact visual companion to this portfolio answer. Select only two to five items that directly improve understanding. Prefer exact evidence over broad skill lists. Do not duplicate the prose, add unsupported claims, or create a panel when plain text is clearer.\n\nVisitor: ${input.message}\n\nAnswer: ${input.answer}`,
    context: { purpose: 'portfolio answer companion' },
    evaluate,
    maxElements: 8,
    maxSteps: 8,
    maxDepth: 2,
    signal,
  })) if (event.spec) spec = event.spec;

  const parsed = specSchema.safeParse(spec);
  if (!parsed.success || Object.keys(parsed.data.elements).length < 2) return null;
  if (JSON.stringify(parsed.data).length > 60_000) return null;
  return { model, spec: parsed.data as Spec };
}

export function createOpenRouterEvaluator(apiKey: string, model: string, timeoutMs: number, fetcher: typeof fetch = fetch): Experimental_CompositionEvaluator {
  return async ({ state, questions, signal }) => {
    const response = await fetcher('https://openrouter.ai/api/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new Error(`OpenRouter Jev request failed (${response.status})`);
    const payload = openRouterResponse.parse(await response.json());
    const answers: Record<string, { choice: string; confidence?: number }> = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = payload.answers[id];
      if (!answer || !Object.hasOwn(question.criteria, answer.choice)) throw new Error('OpenRouter Jev returned an invalid choice');
      answers[id] = { choice: answer.choice, ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }) };
    }
    return { answers, ...(payload.usage?.input_tokens === undefined ? {} : { usage: { inputTokens: payload.usage.input_tokens } }) };
  };
}

export function createGenUiComposer(apiKey: string, model: string, timeoutMs: number): GenUiComposer {
  const evaluate = createOpenRouterEvaluator(apiKey, model, timeoutMs);
  return (input, signal) => composeGenerativeUi(input, evaluate, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), model);
}
