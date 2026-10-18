import assert from 'node:assert/strict';
import test from 'node:test';
import type { Experimental_CompositionEvaluator } from '@json-render/core';
import { buildGenUiCandidates, composeGenerativeUi, createOpenRouterEvaluator } from './gen-ui';

const choosingHyprFm: Experimental_CompositionEvaluator = async request => ({
  answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const choices = Object.keys(question.criteria);
    const choice = choices.includes('overview-board') ? 'overview-board'
      : choices.includes('use:project-hyprfm') ? 'use:project-hyprfm'
      : choices.includes('omit') ? 'omit'
      : choices[0];
    return [id, { choice, confidence: 1 }];
  })),
});

test('Jev composition can only arrange server-owned portfolio candidates', async () => {
  const result = await composeGenerativeUi({ message: 'Show HyprFM', answer: 'HyprFM is a Qt file manager.', sources: [] }, choosingHyprFm, new AbortController().signal);
  assert.equal(result?.model, 'typesafe/jev-1.13');
  assert.equal(result?.spec.elements[result.spec.root].type, 'Board');
  assert.deepEqual(Object.values(result!.spec.elements).map(element => element.type), ['Board', 'Project']);
  assert.equal(Object.values(result!.spec.elements)[1].props.href, '/projects/hyprfm/');
});

test('source candidates retain exact server-provided citations', () => {
  const candidates = buildGenUiCandidates([{
    repo: 'hyprfm', path: 'src/FileOps.cpp', language: 'cpp', symbols: ['copy'], startLine: 10, endLine: 20,
    commit: 'a'.repeat(40), url: `https://github.com/soyeb-jim285/hyprfm/blob/${'a'.repeat(40)}/src/FileOps.cpp#L10-L20`, snippet: 'void copy() {}',
  }]);
  const evidence = candidates.find(candidate => candidate.id === 'evidence-1');
  assert.deepEqual(evidence?.element.props, {
    repo: 'hyprfm', path: 'src/FileOps.cpp', range: '10-20', commit: 'aaaaaaaa',
    href: `https://github.com/soyeb-jim285/hyprfm/blob/${'a'.repeat(40)}/src/FileOps.cpp#L10-L20`, symbols: ['copy'],
  });
});

test('OpenRouter evaluator sends System One choices and maps the response', async t => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({
      model: 'typesafe/jev-1.13-20260917',
      answers: { root: { type: 'choice', choice: 'overview-board', confidence: 0.92 } },
      usage: { input_tokens: 321, output_tokens: 1 },
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  const evaluate = createOpenRouterEvaluator('openrouter-key', 'typesafe/jev-1.13', 5000, fetcher);
  const result = await evaluate({
    state: { prompt: 'Show relevant work' },
    questions: { root: { type: 'choice', instructions: 'Choose a root', criteria: { 'overview-board': 'Overview', unavailable: 'Nothing fits' } } },
    signal: t.signal,
  });
  assert.equal(request?.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer openrouter-key');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    model: 'typesafe/jev-1.13', state: { prompt: 'Show relevant work' },
    questions: { root: { type: 'choice', instructions: 'Choose a root', criteria: { 'overview-board': 'Overview', unavailable: 'Nothing fits' } } },
  });
  assert.deepEqual(result, { answers: { root: { choice: 'overview-board', confidence: 0.92 } }, usage: { inputTokens: 321 } });
});

test('OpenRouter evaluator rejects missing and out-of-catalog choices', async t => {
  for (const answers of [{}, { root: { type: 'choice', choice: 'invented' } }]) {
    const evaluate = createOpenRouterEvaluator('key', 'typesafe/jev-1.13', 5000, async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers, usage: { input_tokens: 1, output_tokens: 1 } })));
    await assert.rejects(evaluate({
      state: {}, questions: { root: { type: 'choice', instructions: 'Choose', criteria: { allowed: 'Allowed' } } }, signal: t.signal,
    }));
  }
});
