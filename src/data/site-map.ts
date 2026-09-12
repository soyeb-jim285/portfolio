// The only places the assistant may send a visitor. Ids are a closed set shared by the
// API (as the show_section enum) and the browser (as the executor's lookup table), so a
// model can never produce an arbitrary URL, selector or script.
import { projects } from './content';

export type SiteTarget = {
  id: string;
  route: string;
  anchor: string;          // matches a data-anchor attribute in the markup
  label: string;
  description: string;     // shown to the model when it picks a target
  action?: 'reveal' | 'contact';
};

export const siteTargets: SiteTarget[] = [
  { id: 'home', route: '/', anchor: 'home-hero', label: 'Title sheet', description: 'Landing sheet: name, tagline and the main calls to action.' },
  { id: 'home-projects', route: '/', anchor: 'home-parts', label: 'Selected projects', description: 'Highlighted project cards on the title sheet.' },
  { id: 'work', route: '/work/', anchor: 'work-intro', label: 'Work sheet', description: 'Role at Fuego.io building Apa, the conversational shopping agent.' },
  { id: 'work-agent-architecture', route: '/work/', anchor: 'work-architecture', label: 'Apa architecture', description: 'Diagram and capability blocks of the agent: tools, retrieval, multimodal input, reliability.' },
  { id: 'work-skills', route: '/work/', anchor: 'work-skills', label: 'Skills table', description: 'Languages, ML, LLM, web and systems skills.' },
  { id: 'research', route: '/research/', anchor: 'research-intro', label: 'Research sheet', description: 'Overview of the biosignal and physics-informed research.' },
  { id: 'research-pain', route: '/research/', anchor: 'research-pain', label: 'Pain detection study', description: 'AI4Pain 2026 hierarchical classifier, results and the localisation ceiling.' },
  { id: 'research-movement', route: '/research/', anchor: 'research-movement', label: 'Movement intent study', description: 'MUMIDC challenge: EEG, EMG and IMU movement-intent classification.' },
  { id: 'projects', route: '/projects/', anchor: 'projects-list', label: 'Project list', description: 'Table of every project with stack and links.' },
  { id: 'record', route: '/record/', anchor: 'record-table', label: 'Record sheet', description: 'Contests, olympiads, ratings and publications.' },
  { id: 'contact', route: '/contact/', anchor: 'contact-form', label: 'Contact sheet', description: 'Contact details and the message form.' },
  { id: 'contact-dialog', route: '', anchor: '', label: 'Message dialog', action: 'contact', description: 'Open the message dialog over the current page so the visitor can write to Jim.' },
  ...projects.map(project => ({
    id: `project-${project.slug}`,
    route: `/projects/${project.slug}/`,
    anchor: 'project-detail',
    label: `${project.name} detail sheet`,
    description: `${project.name}: ${project.kicker}.`,
  })),
];

export const targetIds = siteTargets.map(target => target.id);
export const findTarget = (id: string) => siteTargets.find(target => target.id === id);

// The only images the assistant may put on screen. Like the targets above, the model names an
// id and nothing else: it can never point the page at an arbitrary URL.
export type SiteImage = { id: string; src: string; alt: string; caption: string };

export const siteImages: SiteImage[] = [
  { id: 'portrait', src: '/assets/portrait.jpg', alt: 'Soyeb Pervez Jim', caption: 'Soyeb Pervez Jim, Dhaka' },
  ...projects.flatMap(project => {
    const shots = [project.image, ...(project.images ?? [])].filter((src): src is string => Boolean(src));
    return [...new Set(shots)].map((src, index) => ({
      id: `${project.slug}${index ? `-${index + 1}` : ''}`,
      src,
      alt: `${project.name} screenshot`,
      caption: `${project.name}: ${project.kicker}`,
    }));
  }),
];

export const imageIds = siteImages.map(image => image.id);
export const findImage = (id: string) => siteImages.find(image => image.id === id);
