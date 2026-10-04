import express from 'express';
import session from 'express-session';
import SqliteStoreFactory from 'better-sqlite3-session-store';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, ROOT } from './config.js';
import { db } from './db.js';
import authRoutes from './routes/auth.js';
import documentRoutes from './routes/documents.js';
import prepareRoutes from './routes/prepare.js';
import signRoutes from './routes/sign.js';
import verifyRoutes from './routes/verify.js';
import settingsRoutes from './routes/settings.js';
import teamRoutes from './routes/team.js';
import profileRoutes from './routes/profile.js';
import dashboardRoutes from './routes/dashboard.js';
import templateRoutes from './routes/templates.js';
import platformRoutes from './routes/platform.js';
import { startReminderSweeps } from './reminders.js';
import { currentUser } from './middleware/auth.js';
import { version } from './version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const SqliteStore = SqliteStoreFactory(session);

// Only trust proxy headers when told to — otherwise a client could spoof the
// IP that ends up on the audit trail.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// Signatures, drawings and attachments arrive as base64 data URLs, which
// inflate by a third — the limit has to clear an 8 MB attachment encoded.
app.use(express.json({ limit: '16mb' }));

// Stamped onto asset URLs so a stylesheet change is picked up immediately
// instead of being masked by a cached copy for up to an hour. In development
// it changes every restart; in production it only moves when the build does.
const ASSET_VERSION =
  process.env.NODE_ENV === 'production'
    ? process.env.ASSET_VERSION || 'v1'
    : String(Date.now());

app.use(
  '/static',
  express.static(path.join(ROOT, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '30d' : 0,
    etag: true,
  })
);
app.use(
  '/static/vendor/pdfjs',
  express.static(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build'), { maxAge: '1d' })
);

app.use(
  session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'signflow.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

app.use(currentUser);
app.use((req, res, next) => {
  res.locals.brand = config.brand;
  res.locals.dataRegion = config.dataRegion;
  res.locals.dataRegionShort = config.dataRegionShort;
  res.locals.v = ASSET_VERSION;
  res.locals.appVersion = version;
  // Lets the sidebar mark the current section without each view passing it in.
  res.locals.path = req.path;
  res.locals.query = req.query;
  // The sidebar names the organisation; only signed-in pages draw it.
  res.locals.orgName = req.company?.name || null;
  // The dropzone rejects oversized files before uploading them, so it needs the
  // same limit multer enforces — derived from it rather than restated.
  res.locals.maxUploadMb = Math.round(config.maxUploadBytes / 1024 / 1024);
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.use('/', authRoutes);
app.use('/', settingsRoutes);
app.use('/', teamRoutes);
app.use('/', profileRoutes);
app.use('/', dashboardRoutes);
app.use('/', templateRoutes);
app.use('/', platformRoutes);
app.use('/', documentRoutes);
app.use('/', prepareRoutes);
app.use('/', signRoutes);
app.use('/', verifyRoutes);

/**
 * Unauthenticated on purpose: a load balancer health check cannot sign in, and
 * knowing which build is live is the first question when something is wrong.
 * It exposes the version and nothing else — no counts, no configuration.
 */
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    version: version.number,
    commit: version.sha,
    startedAt: version.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// '/' is owned by the verification page — see routes/verify.js.

app.use((req, res) => res.status(404).render('error', { code: 404, message: 'Page not found.' }));

app.use((err, req, res, _next) => {
  console.error(err);
  const code = err.status || 500;
  res.status(code).render('error', {
    code,
    message: code === 500 ? 'Something went wrong on our side.' : err.message,
  });
});

app.listen(config.port, () => {
  console.log(`${config.brand.name} listening on ${config.baseUrl}`);
  startReminderSweeps();
});
