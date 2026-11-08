export type Project = {
  slug: string; name: string; kicker: string; summary: string; body: string[];
  image?: string; thumb?: string; loop?: string; teaser?: { src: string; poster: string }; images?: string[]; videos?: { src: string; poster: string; caption: string }[]; size?: [number, number]; clips?: { src: string; poster: string; alt: string }[]; repo?: string; stars?: number; forks?: number; contributors?: number; stack: string[];
  links: { label: string; href: string }[]; facts?: { label: string; value: string }[];
  // What people who used it said, quoted word for word and linked to the comment it came from.
  reception?: {
    quotes: { text: string; author: string; href: string; date: string }[];
    threads: { label: string; href: string; stats: string }[];
    // Unprompted mentions by people who had not tried it yet: coverage, never a user quote.
    mentions: { who: string; href: string; what: string; stats: string }[];
  };
};

export const projects: Project[] = [
  {
    slug: 'hyprfm', name: 'HyprFM', kicker: 'Keyboard-first file manager for Hyprland and Wayland', repo: 'soyeb-jim285/hyprfm', stars: 348, forks: 22, contributors: 15,
    summary: 'Qt6/QML file manager with Miller columns, split panes, async transfers and live-reloading TOML themes. Packaged for AUR, Flatpak, AppImage and Nix.',
    body: [
      'HyprFM started because every Wayland file manager felt like a GTK app wearing a costume. It is built from the ground up in C++ and QML with the QML front end separated from C++ backend services, so the UI stays responsive while copy and move jobs run asynchronously with progress.',
      'Grid, detail and Miller-column views; image and video thumbnails with a Space-key quick preview; split panes for two-directory workflows; a bookmarks sidebar that mounts devices through udisks2; regex bulk rename with undo and redo; drag and drop across panes and to other apps.',
      'Theming is a TOML file that reloads live. The icon set is 90+ Lucide-style SVGs built in. It ships as hyprfm-git on the AUR, as a Flatpak from a self-hosted repo, as an AppImage and as a Nix flake. LinuxLinks reviewed it and a downstream fork, Wayfile, rebuilt on top of it.',
      'People from outside have contributed to it: native Markdown rendering in the preview panes, a background rclone mount for remote directories, unlocking password-protected archives on extract, Nix inputs, extra themes. Most installs come through the AUR package rather than the release assets.',
    ],
    // Screenshots from hyprfm.soyebjim.me, copied here on 2026-10-12.
    image: '/assets/hyprfm-view-miller.webp', thumb: '/assets/hyprfm-view-miller-720.webp', loop: '/assets/hyprfm-loop.webp', teaser: { src: '/assets/hyprfm-teaser.mp4', poster: '/assets/hyprfm-teaser.jpg' }, size: [2000, 1250],
    // Both films come from HyprFM's own launch renders (hyprfm brag-output run7); the loops are the ones on hyprfm.soyebjim.me.
    videos: [
      { src: '/assets/hyprfm-short.mp4', poster: '/assets/hyprfm-short.jpg', caption: 'HyprFM in 26 seconds, with sound' },
      { src: '/assets/hyprfm-tour.mp4', poster: '/assets/hyprfm-tour.jpg', caption: 'The full tour, 1.5 minutes, with sound' },
    ],
    clips: [
      { src: '/assets/hyprfm-miller.mp4', poster: '/assets/hyprfm-miller.jpg', alt: 'Miller columns: the preview follows the arrow keys' },
      { src: '/assets/hyprfm-peek.mp4', poster: '/assets/hyprfm-peek.jpg', alt: 'Space peeks at a file; arrows move to the next one' },
      { src: '/assets/hyprfm-split.mp4', poster: '/assets/hyprfm-split.jpg', alt: 'Split panes: copy across, with a conflict prompt' },
      { src: '/assets/hyprfm-undo.mp4', poster: '/assets/hyprfm-undo.jpg', alt: 'Delete a file, then undo brings it back' },
    ],
    stack: ['C++', 'Qt 6', 'QML', 'Wayland', 'udisks2', 'Flatpak', 'Nix'],
    links: [{ label: 'GitHub', href: 'https://github.com/soyeb-jim285/hyprfm' }, { label: 'Site', href: 'https://hyprfm.soyebjim.me' }, { label: 'LinuxLinks review', href: 'https://www.linuxlinks.com/hyprfm-qt6-qml-file-manager/' }, { label: 'Trendshift', href: 'https://trendshift.io/repositories/182310' }],
    // Picked from both launch threads on 2026-09-18: only comments written after using it. Quotes are
    // exact substrings of the comment; stats are as of that date.
    reception: {
      quotes: [
        { text: 'Just installed it and have to say wow. nemo and yazi combined is my first impression.', author: 'Majoga87', href: 'https://www.reddit.com/r/hyprland/comments/1vwnsze/comment/pakr8ba/', date: 'September 2026' },
        { text: 'This is EXACTLY what I was looking for and was thinking of building it myself!', author: 'Fergtato', href: 'https://www.reddit.com/r/hyprland/comments/1vwnsze/comment/p5l2nve/', date: 'August 2026' },
        { text: 'Na this is excellent dude. Will be using it on all my machines I think', author: 'major_jazza', href: 'https://www.reddit.com/r/hyprland/comments/1vwnsze/comment/p6s7n28/', date: 'August 2026' },
      ],
      threads: [
        { label: 'r/hyprland', href: 'https://www.reddit.com/r/hyprland/comments/1vwnsze/', stats: '675 upvotes, 57 comments' },
        { label: 'r/unixporn', href: 'https://www.reddit.com/r/unixporn/comments/1vwmo5y/hyprland_hyprfm_quickshell_qt6_file_manager/', stats: '70 upvotes' },
      ],
      mentions: [
        { who: '@0xBOYD', href: 'https://x.com/0xBOYD/status/2093676066791387237', what: 'as a Finder-style column view for Linux', stats: '5K views, August 2026' },
      ],
    },
    facts: [{ label: 'Stars', value: '348' }, { label: 'Trending', value: '#3 C++ repository of the day on Trendshift, 25 Aug 2026, and #14 of the week' }, { label: 'Packages', value: 'AUR, Flatpak, AppImage, Nix' }, { label: 'Language', value: 'C++ and QML' }],
  },
  {
    slug: 'neural-network-x-ray', name: 'Neural Network X-Ray', kicker: 'Draw a character, watch 13 CNN layers fire',
    summary: 'Interactive CNN visualiser running entirely in the browser through ONNX Runtime on WebAssembly. Latin and Bengali scripts, 146 classes, about 980K training images.',
    body: [
      'You draw a letter or digit on a canvas and every layer of the network lights up as it processes the stroke: convolution, ReLU, pooling, the dense layers and the final softmax. Inference runs in the browser with ONNX Runtime Web, so nothing is uploaded.',
      'The model was trained on EMNIST ByMerge merged with BanglaLekha-Isolated: 146 classes covering A to Z, a to z, 0 to 9 and Bengali ka to ha plus compound characters, from roughly 980,000 images over 40 epochs. Weights and the merged dataset are published on Hugging Face.',
      'Built with Next.js 16, React 19 and TypeScript.',
    ],
    // Intro cut and stills recorded from ocr.soyebjim.me after the October 2026 redesign.
    videos: [{ src: '/assets/nnxray-intro.mp4', poster: '/assets/nnxray-intro.jpg', caption: 'Neural Network X-Ray intro, 21 seconds, with sound' }],
    image: '/assets/nnxray-network.webp', thumb: '/assets/nnxray-network-720.webp', loop: '/assets/nnxray-loop.webp', teaser: { src: '/assets/nnxray-teaser.mp4', poster: '/assets/nnxray-teaser.jpg' }, size: [1920, 1080],
    images: ['/assets/nnxray-feature-maps.webp', '/assets/nnxray-verdict.webp'],
    stack: ['Next.js 16', 'React 19', 'TypeScript', 'ONNX Runtime', 'WebAssembly', 'PyTorch'],
    links: [{ label: 'Live', href: 'https://ocr.soyebjim.me' }, { label: 'GitHub', href: 'https://github.com/soyeb-jim285/ocr-visualization-' }, { label: 'Model weights', href: 'https://huggingface.co/soyeb-jim285/ocr-visualization-models' }, { label: 'Dataset', href: 'https://huggingface.co/datasets/soyeb-jim285/ocr-handwriting-data' }],
    facts: [{ label: 'Classes', value: '146' }, { label: 'Training images', value: '~980K' }, { label: 'Epochs', value: '40' }, { label: 'Parameters', value: '1.7M, a 7 MB ONNX file' }, { label: 'Validation accuracy', value: '90.7%' }],
  },
  {
    slug: 'nextband', name: 'NextBand', kicker: 'IELTS practice that pins each mistake to the second',
    summary: 'NextBand (formerly IELTS Practice) is IELTS practice on the web with native Android and iPhone apps: a live examiner asks out loud, answers are scored against the band descriptors, every pause, filler and grammar slip is marked in your own transcript, and a daily coach turns your history into the next thing to practise.',
    body: [
      'You record a Speaking answer or write a timed essay. Speech is transcribed with the fillers kept (primed Whisper, or ElevenLabs Scribe), and fluency is measured from the word timings: speech rate, mean length of run, pause ratio, mid-clause pauses, fillers, repetitions and self-corrections. Each mistake is anchored to the word it happened on, so the transcript, the pace chart and the audio line up. A wav2vec2 phoneme model scores pronunciation word by word, with your own clip next to a dictionary recording, and the Improve tab rewrites your answer at Band 9 with the same ideas.',
      'The live Speaking test runs on a self-hosted LiveKit server: a Python worker with Soniox streaming transcription, local turn detection and a topic-led examiner that speaks every line. Writing gets a band per criterion, the three fixes that matter most, every error explained and the essay rewritten one band higher. Listening and Reading run as computer-style tests with highlights, notes and timers, and a full mock exam chains all four skills. Mistakes come back as SM-2 review cards.',
      'A daily coach builds facts from a student\'s history (bands, trends, recurring mistakes, days to the exam), picks a priority with plain rules, and has Haiku word the report under a validator that rejects anything the facts do not support. The same facts feed a weekly email. Plans are paid in Bangladeshi Taka through PayStation (bKash, Nagad, Rocket, Upay or card), with a free tier and plan-based limits.',
      'Bands come from a descriptor-anchored rater with a fitted calibration map. On a frozen test set of 41 published Cambridge and ielts.org essays, Writing lands at QWK 0.80 and a mean error of 0.52 bands; the Speaking curve, fitted on 66 labelled clips with pronunciation accuracy included, has a leave-one-speaker-out error of 0.55. Those sets are small and scores run low at band 7.5 and above, so the app shows every band as an estimate with a range.',
      'One TypeScript monorepo: React 19 and Vite on the web, Hono with Postgres and Drizzle on the server, shared scoring and speech logic in a core package, plus native Kotlin (Jetpack Compose) and SwiftUI apps that CI builds but that are not in the stores yet. It ships as one Docker image on Dokploy, with the LiveKit examiner as its own service.',
    ],
    // Launch film and loop cut from the app's own launch video (Oct 2026, before the NextBand rename); stills are post-redesign captures with the demo account cropped out.
    videos: [{ src: '/assets/ielts-launch.mp4', poster: '/assets/ielts-launch.jpg', caption: 'Launch film from before the NextBand rename, 1 minute, with sound' }],
    image: '/assets/ielts-transcript.webp', thumb: '/assets/ielts-transcript-720.webp', loop: '/assets/ielts-loop.webp', teaser: { src: '/assets/ielts-teaser.mp4', poster: '/assets/ielts-teaser.jpg' }, size: [1056, 660],
    images: ['/assets/ielts-pace.webp', '/assets/ielts-writing-fixes.webp'],
    stack: ['TypeScript', 'React 19', 'Hono', 'Postgres', 'Drizzle', 'LiveKit', 'Python', 'Kotlin', 'Jetpack Compose', 'SwiftUI', 'Whisper', 'wav2vec2'],
    links: [{ label: 'Live', href: 'https://nextband.app' }, { label: 'GitHub', href: 'https://github.com/soyeb-jim285/ielts-practice' }],
    facts: [
      { label: 'Writing score', value: 'QWK 0.80, mean error 0.52 bands on 41 held-out essays' },
      { label: 'Speaking score', value: 'Mean error 0.55 bands, leave-one-speaker-out on 66 clips' },
      { label: 'Question bank', value: '320 cue cards, 2,407 Part 1 and 3 questions, 720 Writing prompts' },
      { label: 'Platforms', value: 'Web, Android (Kotlin), iPhone (SwiftUI)' },
      { label: 'Tests', value: 'About 1,050 cases across web, server, Android, iOS and the examiner' },
    ],
  },
  {
    slug: 'hyprpdf', name: 'hyprpdf', kicker: 'PDF and office viewer with annotations',
    summary: 'Qt6/QML document viewer with tabs, page thumbnails, outline navigation, search, split views and annotation tools.',
    body: ['Built to sit next to HyprFM on the same desktop, with Poppler rendering, QML chrome and keyboard-driven navigation across PDF and office documents.'],
    image: '/assets/hyprpdf.jpg', thumb: '/assets/hyprpdf-720.jpg',
    stack: ['C++', 'Qt 6', 'QML', 'Poppler'],
    links: [{ label: 'GitHub', href: 'https://github.com/soyeb-jim285/hyprpdf' }],
    facts: [{ label: 'Renderer', value: 'Poppler' }, { label: 'Interface', value: 'Qt 6 and QML' }, { label: 'Tools', value: 'Annotations, search, split views' }],
  },
  {
    slug: 'quill', name: 'quill', kicker: 'Themed QML component library',
    summary: 'Buttons, toggles, dropdowns, cards and more for Qt Quick, plus quill-icons (60 stroke-based PathSvg icons derived from Lucide) and quill-polkit.',
    body: ['Extracted from HyprFM so the same components could be reused across hyprpdf, the Quickshell desktop shell and the polkit agent.'],
    stack: ['QML', 'Qt Quick'],
    links: [{ label: 'quill', href: 'https://github.com/soyeb-jim285/quill' }, { label: 'quill-icons', href: 'https://github.com/soyeb-jim285/quill-icons' }],
  },
  {
    slug: 'distrostrap', name: 'distrostrap', kicker: 'Install any Linux distro from a running host',
    summary: 'Bootstrap a distribution onto a target partition without a live USB, from whatever system is already running.',
    body: ['Python. Handles partition prep, base bootstrap, chroot configuration and bootloader entries.'],
    stack: ['Python', 'Linux'],
    links: [{ label: 'GitHub', href: 'https://github.com/soyeb-jim285/distrostrap' }],
  },
  {
    slug: 'gre-vocab-trainer', name: 'GRE Vocab Trainer', kicker: 'iOS, AI-graded, FSRS-6 scheduled',
    summary: 'You type the definition and a sentence, an AI grades both, and FSRS-6 schedules the next review. Built during the run to a 170 quant.',
    body: ['Swift. Grading is done by an LLM against the reference definition; scheduling follows the FSRS-6 spaced-repetition algorithm.'],
    stack: ['Swift', 'iOS', 'FSRS-6'],
    links: [{ label: 'GitHub', href: 'https://github.com/soyeb-jim285/gre-vocab-trainer' }],
  },
];
