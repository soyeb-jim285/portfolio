import { z } from 'zod';

export const configSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1).refine(value => !value.startsWith('replace-'), 'Set your OpenRouter key'),
  OPENROUTER_MODEL: z.string().min(1).refine(value => !value.startsWith('replace-'), 'Select an OpenRouter model'),
  DATABASE_URL: z.string().min(1).refine(value => /^postgres(ql)?:\/\//.test(value), 'Use a postgresql:// connection string'),
  SITE_ORIGIN: z.string().url().refine(value => new URL(value).origin === value, 'Use an origin without a trailing slash'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(10000).default(10000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(60000),
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(20).default(3),
  REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  MAX_REQUESTS_PER_DAY: z.coerce.number().int().min(1).default(200),
  OPENROUTER_EMBEDDING_MODEL: z.string().min(1).default('openai/text-embedding-3-small'),
  OPENROUTER_EMBEDDING_DIMS: z.coerce.number().int().min(8).max(8192).default(1536),
  GITHUB_OWNER: z.string().min(1).default('soyeb-jim285'),
  GITHUB_TOKEN: z.string().min(1).optional(),
  REPO_CACHE_DIR: z.string().min(1).default('.cache/repos'),
  MAX_TOOL_STEPS: z.coerce.number().int().min(0).max(6).default(3),
  RESEND_API_KEY: z.string().min(1).optional(),
  CONTACT_FROM: z.string().min(1).optional(),
  CONTACT_TO: z.string().email().optional(),
  CONTACT_LABEL: z.string().min(1).default('Jim'),
  CONTACT_DRAFT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  CONTACT_SENDS_PER_HOUR: z.coerce.number().int().min(1).default(3),
  CONTACT_SENDS_PER_DAY: z.coerce.number().int().min(1).default(20),
  R2_ENDPOINT: z.string().url().optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  ARTIFACT_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  ARTIFACT_MAX_BYTES: z.coerce.number().int().min(1000).max(1000000).default(64000),
  ARTIFACT_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  // Which calendar the assistant books in.
  SCHEDULER: z.enum(['cal', 'google']).default('cal'),

  // Cal.com. One entry per bookable meeting: "<eventTypeId>:<minutes>:<label>", separated by "|".
  CAL_API_KEY: z.string().min(1).optional(),
  CAL_API_BASE: z.string().url().default('https://api.cal.com/v2'),
  CAL_SLOTS_API_VERSION: z.string().min(1).default('2024-09-04'),
  CAL_BOOKINGS_API_VERSION: z.string().min(1).default('2024-08-13'),
  CAL_EVENT_TYPES: z.string().default('').transform((value, ctx) => {
    if (!value.trim()) return [] as { id: number; minutes: number; label: string; key: string }[];
    const types = value.split('|').map(entry => entry.trim()).filter(Boolean).map(entry => {
      const [id, minutes, ...label] = entry.split(':');
      return { id: Number(id), minutes: Number(minutes), label: label.join(':').trim(), key: `${Number(minutes)}min` };
    });
    if (types.some(type => !Number.isInteger(type.id) || type.id <= 0 || !Number.isInteger(type.minutes) || type.minutes <= 0 || !type.label)) {
      ctx.addIssue({ code: 'custom', message: 'Each CAL_EVENT_TYPES entry must be "<eventTypeId>:<minutes>:<label>"' });
    }
    if (new Set(types.map(type => type.key)).size !== types.length) {
      ctx.addIssue({ code: 'custom', message: 'CAL_EVENT_TYPES entries must have distinct durations' });
    }
    return types;
  }),

  // Google Calendar, used when SCHEDULER=google. Run `npm run google:auth` for the refresh token.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REFRESH_TOKEN: z.string().min(1).optional(),
  GOOGLE_CALENDAR_ID: z.string().min(1).default('primary'),
  GOOGLE_ADD_MEET: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  // One entry per bookable meeting: "<minutes>:<label>", entries separated by "|".
  MEETING_TYPES: z.string().default('30:Intro call|15:Quick chat').transform((value, ctx) => {
    const types = value.split('|').map(entry => entry.trim()).filter(Boolean).map(entry => {
      const [minutes, ...label] = entry.split(':');
      return { minutes: Number(minutes), label: label.join(':').trim(), key: `${Number(minutes)}min` };
    });
    if (types.some(type => !Number.isInteger(type.minutes) || type.minutes <= 0 || !type.label)) {
      ctx.addIssue({ code: 'custom', message: 'Each MEETING_TYPES entry must be "<minutes>:<label>"' });
    }
    if (new Set(types.map(type => type.key)).size !== types.length) {
      ctx.addIssue({ code: 'custom', message: 'MEETING_TYPES entries must have distinct durations' });
    }
    return types;
  }),
  // The host's own zone and working hours: slots exist only inside these.
  MEETING_TIME_ZONE: z.string().min(1).default('Asia/Dhaka').refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Use an IANA time zone such as Asia/Dhaka'),
  MEETING_DAYS: z.string().default('1,2,3,4,5').transform(value => value.split(',').map(day => Number(day.trim())).filter(day => day >= 0 && day <= 6)),
  MEETING_START: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  MEETING_END: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'),
  BOOKING_NOTICE_MINUTES: z.coerce.number().int().min(0).max(20160).default(720),
  BOOKING_BUFFER_MINUTES: z.coerce.number().int().min(0).max(240).default(10),
  BOOKING_STEP_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  BOOKING_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  BOOKING_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  BOOKINGS_PER_DAY: z.coerce.number().int().min(1).default(5),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  MAX_MESSAGES_PER_SESSION: z.coerce.number().int().min(2).max(200).default(40),
});

export type Config = z.infer<typeof configSchema>;
