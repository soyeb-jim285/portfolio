// The log sheet's index. One entry per post, in reverse date order; each post is its own page
// under src/pages/log/, because a post with its own figures is a drawing, not a template fill.
export type Post = {
  slug: string;
  title: string;      // set in the display face, so short
  dek: string;
  date: string;       // ISO, for the machine
  when: string;       // how the sheet prints it
  minutes: number;
  tags: string[];
};

export const posts: Post[] = [
  {
    slug: 'startup-halved',
    title: 'Startup, halved',
    dek: 'Three weeks of profiling a file manager: 336 ms to 163 ms, 184 MB to 109 MB, and the four numbers I had to publicly take back.',
    date: '2026-09-20',
    when: '20 Sep 2026',
    minutes: 18,
    tags: ['HyprFM', 'Qt', 'C++', 'profiling'],
  },
];

export const findPost = (slug: string) => posts.find((p) => p.slug === slug);
