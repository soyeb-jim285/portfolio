// Every question the site itself puts to the assistant. One list, so the buttons that send them and
// the server that answers them ahead of time (the cache warm-up) can never drift apart by a character:
// a cached answer is found only for the exact same words.
export const starters = [
  { tag: '01 / Read the source', question: 'How does HyprFM copy files without freezing the UI? Show me the code.' },
  { tag: '02 / AI engineering', question: 'Tell me about Jim’s AI engineering work.' },
  { tag: '03 / Match a role', question: 'I will paste a job description. Which requirements does Jim actually have evidence for?' },
];
export const hardQuestion = 'How does HyprFM keep file transfers off the UI thread? Cite the code.';
export const projectQuestion = (name: string) => `Explain how ${name} works, citing the code.`;

export const fixedQuestions = (projectNames: string[]) => [
  ...starters.map(starter => starter.question), hardQuestion, ...projectNames.map(projectQuestion),
];
