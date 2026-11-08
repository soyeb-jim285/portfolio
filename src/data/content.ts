// Single source of truth for every variant. Facts come from ../cv.json (with provenance);
// this file shapes them for pages. Do not invent numbers here.
import cv from './cv.json';

export const person = {
  name: 'Soyeb Pervez Jim',
  short: 'SPJ',
  role: 'Software Engineer at Fuego.io',
  tagline: 'Software engineer at Fuego.io. I build production AI systems for online stores, and open-source desktop tools for Linux.',
  location: 'Dhaka, Bangladesh',
  email: 'soyeb.jim@gmail.com',
  phone: '+8801718007639',
  education: 'BSc Electrical and Electronic Engineering, University of Dhaka, 2021 to 2026',
  languages: ['Bengali, native', 'English, C1'],
  scores: { efset: 'C1', efsetCert: 'https://cert.efset.org/LEvQnj' },
  links: {
    github: 'https://github.com/soyeb-jim285',
    linkedin: 'https://www.linkedin.com/in/soyebjim',
    codeforces: 'https://codeforces.com/profile/soyeb_p_jim',
    codechef: 'https://www.codechef.com/users/soyebjim',
    huggingface: 'https://huggingface.co/soyeb-jim285',
    site: 'https://soyebjim.me',
    resume: '/Soyeb_Pervez_Jim_Resume.pdf',
  },
  portrait: '/assets/portrait.jpg',
} as const;

export const work = {
  employer: 'Fuego.io',
  url: 'https://fuego.io',
  product: 'Apa',
  title: 'Software Engineer',
  period: 'June 2025 to present',
  start: '2025-06',
  remote: true,
  context: 'a multi-tenant, brand-configurable conversational shopping assistant embedded in native Shopify apps',
  // Fuego's engineering and its numbers are confidential. This describes what the product does for a
  // shopper, at the level Fuego's own marketing does, and nothing about how it is built or how much it handles.
  bullets: [
    'Building Apa, the AI shopping agent inside Fuego\'s native Shopify apps: streamed chat, configured per brand.',
    'Tool calling for product search, collections, product details, reviews, recommendations and order help.',
    'Semantic product search over live store catalogs.',
    'Image and voice input alongside text, with results streamed back as product cards.',
    'Caching, rate limiting and failure recovery for production traffic, plus Stripe billing across brands.',
  ],
  stack: ['TypeScript', 'Next.js', 'React', 'Node.js', 'Shopify', 'Stripe'],
} as const;

export { projects } from './projects';
export type { Project } from './projects';
export { research } from './research';

export const record = [
  { year: '2024', what: 'ICPC Dhaka Regional, team DU_Oblivion', result: '37th of 308', detail: 'preliminary 16th of 2489', href: 'https://icpc.global/regionals/finder/Dhaka-2025/standings' },
  { year: '2023', what: 'ICPC Dhaka Regional, team DU_HoneyNuts', result: '37th of 225', detail: 'preliminary 35th of 2460', href: 'https://icpc.global/regionals/finder/Dhaka-2024/standings' },
  { year: '2024', what: 'National Collegiate Programming Contest, team DU_3Musketeers', result: '27th of 196', detail: 'preliminary 31st of 1099', href: 'https://bapsoj.org/contests/ncpc-onsite-2023-hosted-by-ju/standings' },
  { year: '2024', what: 'Meta Hacker Cup, round 2', result: '962nd of 5000', detail: 'round 1: 2359th of 22494', href: 'https://www.facebook.com/codingcompetitions/hacker-cup/2024/certificate/2005569239823325' },
  { year: '2023', what: 'Meta Hacker Cup, round 2', result: '2425th of 6193', detail: 'round 1: 1760th of 20324', href: 'https://www.facebook.com/codingcompetitions/hacker-cup/2023/certificate/2005569239823325' },
  { year: '2024', what: 'BUET CSE Fest', result: '25th of 113', detail: '', href: 'https://toph.co/c/inter-university-buet-cse-fest-2024/standings' },
  { year: 'ongoing', what: 'Codeforces, handle soyeb_p_jim', result: 'Peak 1714, Expert', detail: '121 rated rounds, 769 problems solved', href: 'https://codeforces.com/profile/soyeb_p_jim' },
  { year: 'ongoing', what: 'CodeChef, handle soyebjim', result: 'Peak 2032, Div 1', detail: '32 rated contests, 229 problems solved', href: 'https://www.codechef.com/users/soyebjim' },
  { year: '2017', what: 'Bangladesh Mathematical Olympiad, national', result: 'First runner-up', detail: 'second runner-up in 2016' },
  { year: '2020', what: 'Mathematical Olympiad Problem Solve & Approach, worked olympiad solutions', result: '6.5K followers', detail: 'BdMO national sets across all four categories, IMO problems and other contests', href: 'https://www.facebook.com/mpms.solve' },
  { year: '2024', what: 'Book: গণিত অলিম্পিয়াডের হাতেখড়ি, Swapno ’71', result: 'Author', detail: 'introduction to olympiad mathematics, secondary level', href: 'https://www.rokomari.com/book/288868/gonit-olympiad-er-hate-khori-secondary' },
  { year: '2026', what: 'EF SET English Certificate', result: 'C1', detail: 'certified at cert.efset.org', href: 'https://cert.efset.org/LEvQnj' },
];

export const clubs = [
  { org: 'IEEE Computer Society', role: 'Publicity Coordinator', period: '2022 to 2024' },
  { org: 'IEEE Robotics Society', role: 'Web Master', period: '2022 to 2024' },
  { org: 'Bangladesh Mathematical Olympiad', role: 'Academic Team Member', period: '2021 to 2024' },
];

export const skills = {
  languages: ['C++', 'Python', 'TypeScript', 'QML', 'Swift', 'Lua', 'Bash'],
  ml: ['PyTorch', 'ONNX', 'scikit-learn', 'CNN / TCN / LSTM', 'Mamba', 'PINNs', 'biosignal processing', 'LOSO and subject-fold CV', 'calibration'],
  llm: ['agentic workflows', 'tool calling', 'RAG', 'vector search', 'embeddings', 'Vercel AI SDK', 'OpenAI API', 'evals'],
  web: ['Next.js', 'React', 'Astro', 'Hono', 'Express', 'Drizzle', 'Sequelize', 'Postgres', 'MySQL / Vitess', 'Redis'],
  infra: ['Docker', 'GitHub Actions', 'Traefik', 'Dokploy', 'Hetzner', 'Cloudflare R2 and DNS', 'Vercel', 'k6', 'Playwright'],
  systems: ['Qt 6', 'Wayland', 'Hyprland', 'Arch Linux', 'Flatpak', 'Nix', 'AppImage'],
};

export const provenance = cv.sources;
