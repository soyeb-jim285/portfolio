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
    slug: 'hyprfm', name: 'HyprFM', kicker: 'Keyboard-first file manager for Hyprland and Wayland', repo: 'soyeb-jim285/hyprfm', stars: 339, forks: 20, contributors: 12,
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
    facts: [{ label: 'Stars', value: '339' }, { label: 'Trending', value: '#3 C++ repository of the day on Trendshift, 25 Aug 2026, and #14 of the week' }, { label: 'Packages', value: 'AUR, Flatpak, AppImage, Nix' }, { label: 'Language', value: 'C++ and QML' }],
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
    slug: 'ielts-practice', name: 'IELTS Practice', kicker: 'Speaking and Writing practice that pins each mistake to the second',
    summary: 'IELTS practice on the web with native Android and iPhone apps: an examiner asks out loud, answers are scored against the band descriptors, and every pause, filler and grammar slip is marked in your own transcript.',
    body: [
      'You record a Speaking answer or write a timed essay. Speech is transcribed with the fillers kept (primed Whisper, or ElevenLabs Scribe), and fluency is measured from the word timings: speech rate, mean length of run, pause ratio, mid-clause pauses, fillers, repetitions and self-corrections. Each mistake is anchored to the word it happened on, so the transcript, the pace chart and the audio line up.',
      'Writing gets a band per criterion, the three fixes that matter most, every error explained and the essay rewritten one band higher. Listening and Reading run as computer-style tests with highlights, notes and timers, and a full mock exam chains all four skills. Mistakes come back as SM-2 review cards. A live examiner can run the Speaking test over OpenAI Realtime or Gemini Live.',
      'Bands come from a descriptor-anchored rater with a fitted calibration map. On a frozen test set of 41 published Cambridge and ielts.org essays, Writing lands at QWK 0.80 and a mean error of 0.52 bands; the Speaking curve, fitted on 66 labelled clips, has a leave-one-group-out error of 0.59. Those sets are small, scores run low at band 7.5 and above, and pronunciation is not judged from audio, so the app shows every band as an estimate with a range.',
      'One TypeScript monorepo: React 19 and Vite on the web, Hono with Postgres and Drizzle on the server, shared scoring and speech logic in a core package, plus native Kotlin (Jetpack Compose) and SwiftUI apps that CI builds but that are not in the stores yet. It ships as one Docker image on Dokploy.',
    ],
    // Launch film and loop cut from the app's own launch video (Oct 2026); stills are post-redesign captures with the demo account cropped out.
    videos: [{ src: '/assets/ielts-launch.mp4', poster: '/assets/ielts-launch.jpg', caption: 'IELTS Practice launch film, 1 minute, with sound' }],
    image: '/assets/ielts-transcript.webp', thumb: '/assets/ielts-transcript-720.webp', loop: '/assets/ielts-loop.webp', teaser: { src: '/assets/ielts-teaser.mp4', poster: '/assets/ielts-teaser.jpg' }, size: [1056, 660],
    images: ['/assets/ielts-pace.webp', '/assets/ielts-writing-fixes.webp'],
    stack: ['TypeScript', 'React 19', 'Hono', 'Postgres', 'Drizzle', 'Kotlin', 'Jetpack Compose', 'SwiftUI', 'Whisper', 'OpenAI Realtime'],
    links: [{ label: 'Live', href: 'https://ielts.soyebjim.me' }, { label: 'GitHub', href: 'https://github.com/soyeb-jim285/ielts-practice' }],
    facts: [
      { label: 'Writing score', value: 'QWK 0.80, mean error 0.52 bands on 41 held-out essays' },
      { label: 'Question bank', value: '120 cue cards, 799 Part 1 and 3 questions, 220 Writing prompts' },
      { label: 'Platforms', value: 'Web, Android (Kotlin), iPhone (SwiftUI)' },
      { label: 'Tests', value: 'About 1,000 cases across web, server, Android and iOS' },
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

export const research = [
  {
    slug: 'pce-pinn-pipelines',
    title: 'Physics-Informed Multi-Task Neural Network for Simultaneous Leak Detection, Diameter Estimation, and Localization in Multiphase Pipelines',
    short: 'Physics-informed leak detection in multiphase pipelines',
    venue: 'Process Safety and Environmental Protection, Elsevier', status: 'published, accepted September 2026',
    doi: 'https://doi.org/10.1016/j.psep.2026.109609',
    authors: 'Mridha, Kabir, Khandakar, Mia, Ahmed, Shahadad, Jim, Rahman, Ayari, Rahman and Barooah',
    abstract: 'Offshore multiphase pipelines leak, and detecting a leak, sizing it and locating it are usually three separate problems, solved either by transient models too expensive to run in the loop or by data-driven detectors with no physical consistency. PCE-PINN does all three at once, from inlet and outlet pressure and flow rate alone. A physics sub-network penalises violations of nondimensional mass, momentum and mechanical-energy balance through adaptive curriculum training and adaptive collocation.',
    finding: 'Detection is saturated at F1 = 1.00. The regression heads are what matter: location R2 improves 16.5 percent over the best of five classical baselines on identical features, so the gain comes from the physics-informed architecture rather than from the features. SHAP attribution lands on conservation-consistent variables.',
    results: [
      { label: 'Leak detection F1', value: '1.00', note: 'stratified 5-fold CV' },
      { label: 'Diameter R2', value: '0.906', note: '' },
      { label: 'Location R2', value: '0.941', note: '16.5% over the best baseline' },
    ],
    keywords: ['physics-informed neural network', 'multiphase flow', 'leak localisation', 'multi-task learning', 'explainable AI'],
  },
  {
    slug: 'pinn-e2co-co2',
    title: 'Physics-Informed Embed-to-Control and Observe with Per-Producer MLP Heads for CO2 Storage Surrogate Modelling',
    short: 'Physics-informed surrogate for CO2 storage simulation',
    venue: 'Fuel Processing Technology, Elsevier', status: 'under review, submitted July 2026',
    doi: '',
    authors: 'Khandakar (corresponding), Ruhan, Kabir, Jim, Mia, Ahmed, Rahaman, Rahman, Ayari and Rahman',
    abstract: 'A single forward solve of a high-resolution two-phase CO2 reservoir simulation takes hours, and history matching needs thousands of them. Embed-to-Control surrogates compress the state into a latent vector and advance it under well controls, but they share one linear observation model across every well, which regresses water and gas rates with very different non-linearities into one mediocre fit. PINN-E2CO replaces that block with an independent MLP head per producer over the shared latent, warm-started from a physics-free baseline at a tenth of the head learning rate, and trains under a hybrid loss whose three physics residuals are discretised on the finite-volume transmissibility operator the simulator itself uses.',
    finding: 'Per-well heads are the fix, and the physics residuals are what make them stick: saturation RMSE down 38 percent and pressure RMSE down 35 percent against the non-physics baseline, with filtered per-well R2 moving from 0.82 to 0.91 after 16 minutes of fine-tuning on a single T4. An ablation of 33 variants, including FNO decoders, neural-ODE dynamics and DeepONet heads, confirms the shared linear observe block was the bottleneck.',
    results: [
      { label: 'Saturation RMSE', value: '-38%', note: 'against the non-physics E2CO baseline' },
      { label: 'Pressure RMSE', value: '-35%', note: '' },
      { label: 'Per-well R2', value: '0.82 to 0.91', note: 'filtered' },
      { label: 'Fine-tune time', value: '16 min', note: 'single T4 GPU' },
    ],
    keywords: ['CO2 sequestration', 'physics-informed neural network', 'embed-to-control', 'reservoir surrogate', 'explainable AI'],
  },
  {
    slug: 'ai4pain-2026',
    title: 'Detecting Pain Without Localising It: A Hierarchical Physiological Classifier and the Arm-Hand Localisation Ceiling on AI4Pain 2026',
    short: 'Detecting pain without localising it',
    venue: 'ACII 2026 Grand Challenge track', status: 'under double-blind review',
    abstract: 'The AI4Pain 2026 challenge asks a model to label physiological segments from 65 subjects as No-Pain, Pain-Arm or Pain-Hand from BVP, EDA, respiration and SpO2. We present a two-stage hierarchical classifier: stage one separates pain from no-pain, stage two separates arm from hand. Both are L2-regularised logistic regressions on subject-normalised, effect-size-ranked features with isotonic calibration, decoded under the known balanced prior. Every design decision was made under 5x5 repeated subject-fold cross-validation with paired significance testing, not on the leaderboard.',
    finding: 'Stage-one detection is strong. Stage-two arm-versus-hand localisation sits near chance and stays there through baseline-relative normalisation, respiratory dynamics, modality late-fusion, a sweep of non-linear models and an oracle variant fed ground-truth labels. At the segment level these peripheral signals carry pain intensity, not somatotopic location.',
    results: [
      { label: 'Test accuracy', value: '0.572', note: '247 of 432 segments' },
      { label: 'Official baseline', value: '0.398', note: 'multimodal SVM' },
      { label: 'Detection AUC', value: '0.895', note: 'stage 1' },
      { label: 'Localisation AUC', value: '0.55', note: 'stage 2, near chance' },
      { label: 'CV estimate', value: '0.575 ± 0.024', note: '5x5 subject-fold' },
    ],
    keywords: ['pain assessment', 'electrodermal activity', 'photoplethysmography', 'hierarchical classification', 'affective computing'],
  },
  {
    slug: 'mumidc-abc2026',
    title: 'Upper-limb movement intent from EEG, EMG and IMU', short: 'Movement intent from EEG, EMG and IMU',
    venue: 'ABC2026 MUMIDC challenge', status: 'challenge submission',
    abstract: 'A CNN2D-TCN with late fusion of statistical EEG features classifying seven motor tasks across sixteen subjects under mixed leave-one-subject-out evaluation.',
    finding: 'The release task (T6) is the stubborn one at 68 to 78 percent F1 in every configuration tried; everything else is well above 85.',
    results: [
      { label: 'Accuracy', value: '87.5%', note: 'mixed LOSO, 16 folds' },
      { label: 'Macro F1', value: '87.9%', note: '' },
      { label: 'Macro AUC', value: '0.980', note: '' },
    ],
    keywords: ['EEG', 'EMG', 'IMU', 'temporal convolution', 'motor intent'],
  },
];

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
