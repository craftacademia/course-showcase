/**
 * CRAFT Academia — SCORM Course Library & Collection Link Generator v2
 */

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const { v4: uuidv4 } = require('uuid');
const xml2js    = require('xml2js');
const unzipper  = require('unzipper');

const app     = express();
const PORT    = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

const DATA_DIR    = path.join(__dirname, 'data');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');
const COLL_DIR    = path.join(DATA_DIR, 'collections');
const TMP_DIR     = path.join(DATA_DIR, 'tmp');

[DATA_DIR, LIBRARY_DIR, COLL_DIR, TMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename:    (_req, _file, cb) => cb(null, `${uuidv4()}.zip`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    path.extname(file.originalname).toLowerCase() === '.zip'
      ? cb(null, true)
      : cb(new Error('Only .zip files are accepted'));
  }
});

async function parseManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const xml    = fs.readFileSync(manifestPath, 'utf8');
    const result = await xml2js.parseStringPromise(xml, { explicitArray: true });
    const mf     = result?.manifest;
    if (!mf) return null;
    let courseTitle = '';
    try { courseTitle = mf.organizations?.[0]?.organization?.[0]?.title?.[0] || ''; } catch (_) {}
    const resources = mf.resources?.[0]?.resource || [];
    let launchFile  = null;
    for (const res of resources) {
      const a  = res.$ || {};
      const st = (a['adlcp:scormtype'] || a['adlcp:scormType'] || '').toLowerCase();
      if (st === 'sco' && a.href) { launchFile = a.href; break; }
    }
    if (!launchFile) {
      for (const res of resources) {
        const a = res.$ || {};
        if (a.href) { launchFile = a.href; break; }
      }
    }
    return { courseTitle, launchFile };
  } catch (err) {
    console.error('Manifest parse error:', err.message);
    return null;
  }
}

async function resolveManifest(extractDir) {
  let manifestPath = path.join(extractDir, 'imsmanifest.xml');
  let contentRoot  = extractDir;
  if (!fs.existsSync(manifestPath)) {
    for (const entry of fs.readdirSync(extractDir).filter(e => !e.startsWith('.'))) {
      const sub = path.join(extractDir, entry);
      if (fs.statSync(sub).isDirectory()) {
        const c = path.join(sub, 'imsmanifest.xml');
        if (fs.existsSync(c)) { manifestPath = c; contentRoot = sub; break; }
      }
    }
  }
  const parsed = await parseManifest(manifestPath);
  if (contentRoot !== extractDir) {
    for (const item of fs.readdirSync(contentRoot)) {
      fs.renameSync(path.join(contentRoot, item), path.join(extractDir, item));
    }
    try { fs.rmdirSync(contentRoot); } catch (_) {}
  }
  return parsed;
}

function getBase(req) {
  return BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function readMeta(courseId) {
  const p = path.join(LIBRARY_DIR, courseId, '.meta.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function readAllCourses() {
  if (!fs.existsSync(LIBRARY_DIR)) return [];
  const courses = [];
  for (const id of fs.readdirSync(LIBRARY_DIR)) {
    const meta = readMeta(id);
    if (meta) courses.push(meta);
  }
  return courses.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function readCollection(collectionId) {
  const p = path.join(COLL_DIR, `${collectionId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function readAllCollections() {
  if (!fs.existsSync(COLL_DIR)) return [];
  const colls = [];
  for (const file of fs.readdirSync(COLL_DIR).filter(f => f.endsWith('.json'))) {
    try { colls.push(JSON.parse(fs.readFileSync(path.join(COLL_DIR, file), 'utf8'))); } catch (_) {}
  }
  return colls.sort((a, b) => b.createdAt - a.createdAt);
}

function isUUID(s) { return /^[0-9a-f-]{36}$/.test(s); }

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/library', upload.single('scorm'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const courseId  = uuidv4();
  const courseDir = path.join(LIBRARY_DIR, courseId);
  const zipPath   = req.file.path;
  try {
    fs.mkdirSync(courseDir, { recursive: true });
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: courseDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    fs.unlinkSync(zipPath);
    const parsed    = await resolveManifest(courseDir);
    let launchFile  = parsed?.launchFile || 'index.html';
    let courseTitle = parsed?.courseTitle || req.file.originalname.replace(/\.zip$/i, '');
    if (!fs.existsSync(path.join(courseDir, launchFile))) {
      if (fs.existsSync(path.join(courseDir, 'index.html'))) {
        launchFile = 'index.html';
      } else {
        throw new Error('Cannot find a launch file. Check the SCORM package has imsmanifest.xml or index.html at its root.');
      }
    }
    const meta = {
      courseId,
      title:       courseTitle,
      description: req.body.description || '',
      category:    req.body.category    || 'General',
      language:    req.body.language    || 'English',
      durationMins: parseInt(req.body.durationMins || '0', 10) || 0,
      launchFile,
      originalName: req.file.originalname,
      uploadedAt:  Date.now()
    };
    fs.writeFileSync(path.join(courseDir, '.meta.json'), JSON.stringify(meta, null, 2));
    res.json({ success: true, course: meta });
  } catch (err) {
    console.error('Upload error:', err.message);
    if (fs.existsSync(zipPath))   try { fs.unlinkSync(zipPath); } catch (_) {}
    if (fs.existsSync(courseDir)) fs.rmSync(courseDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

app.get('/api/library', (_req, res) => {
  res.json({ courses: readAllCourses() });
});

app.patch('/api/library/:courseId', (req, res) => {
  const { courseId } = req.params;
  if (!isUUID(courseId)) return res.status(400).json({ error: 'Invalid ID' });
  const metaPath = path.join(LIBRARY_DIR, courseId, '.meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Course not found' });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  for (const key of ['title', 'description', 'category', 'language', 'durationMins']) {
    if (req.body[key] !== undefined) meta[key] = req.body[key];
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  res.json({ success: true, course: meta });
});

app.delete('/api/library/:courseId', (req, res) => {
  const { courseId } = req.params;
  if (!isUUID(courseId)) return res.status(400).json({ error: 'Invalid ID' });
  const dir = path.join(LIBRARY_DIR, courseId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.post('/api/collections', (req, res) => {
  const { clientName, courseIds, expiresAt, note } = req.body;
  if (!clientName?.trim())   return res.status(400).json({ error: 'Client name is required' });
  if (!courseIds?.length)    return res.status(400).json({ error: 'Select at least one course' });
  if (!expiresAt)            return res.status(400).json({ error: 'Expiry date is required' });
  const expTs = new Date(expiresAt).getTime();
  if (isNaN(expTs) || expTs <= Date.now()) {
    return res.status(400).json({ error: 'Expiry date must be in the future' });
  }
  for (const id of courseIds) {
    if (!readMeta(id)) return res.status(400).json({ error: `Course not found: ${id}` });
  }
  const collectionId = uuidv4();
  const collection   = {
    collectionId,
    clientName: clientName.trim(),
    note:       (note || '').trim(),
    courseIds,
    expiresAt:  expTs,
    createdAt:  Date.now()
  };
  fs.writeFileSync(
    path.join(COLL_DIR, `${collectionId}.json`),
    JSON.stringify(collection, null, 2)
  );
  res.json({ success: true, collection });
});

app.get('/api/collections', (req, res) => {
  const base = getBase(req);
  const now  = Date.now();
  const colls = readAllCollections().map(c => ({
    ...c,
    link:    `${base}/c/${c.collectionId}`,
    expired: now > c.expiresAt
  }));
  res.json({ collections: colls });
});

app.delete('/api/collections/:collectionId', (req, res) => {
  const { collectionId } = req.params;
  if (!isUUID(collectionId)) return res.status(400).json({ error: 'Invalid ID' });
  const f = path.join(COLL_DIR, `${collectionId}.json`);
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/course/:courseId/*', (req, res) => {
  const { courseId } = req.params;
  if (!isUUID(courseId)) return res.status(400).send('Invalid ID');
  const courseDir = path.join(LIBRARY_DIR, courseId);
  if (!fs.existsSync(courseDir)) return res.status(404).send('Course not found');
  const filePath = req.params[0];
  const fullPath = path.resolve(path.join(courseDir, filePath));
  if (!fullPath.startsWith(path.resolve(courseDir))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return res.status(404).send('File not found');
  }
  res.sendFile(fullPath);
});

app.get('/c/:collectionId', (req, res) => {
  const { collectionId } = req.params;
  if (!isUUID(collectionId)) return res.status(400).send('Invalid link');
  const collection = readCollection(collectionId);
  if (!collection) {
    return res.status(404).send(errorPage('Link Not Found', 'This collection link does not exist or has been removed.'));
  }
  if (Date.now() > collection.expiresAt) {
    const expDate = fmtDate(collection.expiresAt);
    return res.status(410).send(errorPage('Access Expired', `This course collection link expired on ${expDate}.`));
  }
  const courses = collection.courseIds.map(id => readMeta(id)).filter(Boolean);
  const base    = getBase(req);
  const expDate = fmtDate(collection.expiresAt);
  res.send(collectionPage(collection, courses, base, expDate));
});

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function errorPage(title, msg) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — CRAFT Academia</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#F0F4F8;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{background:#fff;border-radius:14px;padding:44px 52px;text-align:center;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h2{color:#1B3A5C;margin-bottom:10px;font-size:22px}p{color:#64748B;line-height:1.6}
.logo{margin:0 auto 20px;display:block;height:48px}</style></head>
<body><div class="c"><img src="/Craft.png" alt="CRAFT Academia" class="logo"/><h2>${esc(title)}</h2><p>${esc(msg)}</p></div></body></html>`;
}

const CAT_COLORS = {
  'Sales':             { bg: '#1B3A5C', badge: '#EEF4FF', badgeTxt: '#1B3A5C', init: 'S'  },
  'Credit':            { bg: '#0D6B3C', badge: '#ECFDF5', badgeTxt: '#065F46', init: 'CR' },
  'Collections':       { bg: '#B45309', badge: '#FFFBEB', badgeTxt: '#92400E', init: 'CO' },
  'Compliance':        { bg: '#6D28D9', badge: '#F5F3FF', badgeTxt: '#5B21B6', init: 'CP' },
  'Soft Skills':       { bg: '#0891B2', badge: '#ECFEFF', badgeTxt: '#0E7490', init: 'SS' },
  '1st Time Managers': { bg: '#BE185D', badge: '#FDF2F8', badgeTxt: '#9D174D', init: 'M'  },
  'Vedic Wisdom':      { bg: '#92400E', badge: '#FEF3C7', badgeTxt: '#78350F', init: 'V'  },
  'General':           { bg: '#374151', badge: '#F9FAFB', badgeTxt: '#374151', init: 'G'  },
};

function catColor(c) { return CAT_COLORS[c] || CAT_COLORS['General']; }

function collectionPage(collection, courses, base, expDate) {
  const cards = courses.map(course => {
    const c   = catColor(course.category);
    const url = `${base}/course/${course.courseId}/${course.launchFile}`;
    const dur = course.durationMins > 0 ? `${course.durationMins} min` : '';
    const meta = [course.language, dur].filter(Boolean).join(' · ');
    return `
    <div class="card">
      <div class="stripe" style="background:${c.bg}">
        <span class="init">${c.init}</span>
      </div>
      <div class="cbody">
        <span class="badge" style="background:${c.badge};color:${c.badgeTxt}">${esc(course.category)}</span>
        <h3 class="ctitle">${esc(course.title)}</h3>
        ${course.description ? `<p class="cdesc">${esc(course.description)}</p>` : ''}
        ${meta ? `<p class="cmeta">${esc(meta)}</p>` : ''}
        <a class="launch" href="${esc(url)}" target="_blank" rel="noopener">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Launch Course
        </a>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(collection.clientName)} — CRAFT Academia</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#EEF2F7;color:#0F172A;min-height:100vh;display:flex;flex-direction:column}
header{background:#fff;padding:0 32px;height:72px;display:flex;align-items:center;border-bottom:1px solid #E2E8F0;flex-shrink:0}
main{flex:1;max-width:1000px;width:100%;margin:0 auto;padding:40px 24px 64px}
.ch{margin-bottom:32px}
.cl{font-size:11px;font-weight:700;color:#8098B3;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.ct{font-size:28px;font-weight:700;color:#1B3A5C;line-height:1.2}
.cnote{margin-top:14px;padding:14px 18px;background:#fff;border:1px solid #D1DCE8;border-left:4px solid #F5A623;border-radius:8px;font-size:14px;color:#334155;line-height:1.6}
.cexp{margin-top:12px;font-size:12px;color:#8098B3;display:flex;align-items:center;gap:5px}
.cc{font-size:13px;font-weight:500;color:#5C7A9B;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}
.card{background:#fff;border:1px solid #D1DCE8;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;transition:box-shadow .15s,transform .15s}
.card:hover{box-shadow:0 8px 28px rgba(27,58,92,.14);transform:translateY(-2px)}
.stripe{height:72px;display:flex;align-items:center;padding:0 20px;flex-shrink:0}
.init{font-size:24px;font-weight:700;color:rgba(255,255,255,.88)}
.cbody{padding:18px 20px 22px;display:flex;flex-direction:column;flex:1;gap:9px}
.badge{display:inline-block;font-size:11px;font-weight:600;border-radius:99px;padding:3px 10px;align-self:flex-start}
.ctitle{font-size:15px;font-weight:600;color:#1B3A5C;line-height:1.35}
.cdesc{font-size:13px;color:#64748B;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cmeta{font-size:12px;color:#94A3B8}
.launch{display:inline-flex;align-items:center;gap:6px;margin-top:auto;padding:10px 18px;background:#1B3A5C;color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;transition:background .15s;align-self:flex-start}
.launch:hover{background:#24507D}
footer{background:#1B3A5C;padding:18px 32px;text-align:center;font-size:12px;color:rgba(255,255,255,.38)}
footer strong{color:rgba(255,255,255,.65)}
@media(max-width:600px){main{padding:24px 16px 48px}.ct{font-size:22px}.grid{grid-template-columns:1fr}header{padding:0 16px}}
</style>
</head>
<body>
<header><img src="/Craft.png" alt="CRAFT Academia" style="height:44px"/></header>
<main>
  <div class="ch">
    <div class="cl">Course Collection</div>
    <div class="ct">${esc(collection.clientName)}</div>
    ${collection.note ? `<div class="cnote">${esc(collection.note)}</div>` : ''}
    <div class="cexp">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      Access available until ${esc(expDate)}
    </div>
  </div>
  <div class="cc">${courses.length} course${courses.length !== 1 ? 's' : ''} in this collection</div>
  <div class="grid">${cards}</div>
</main>
<footer><strong>CRAFT Academia</strong> · Skill-tech training for BFSI · craftacademia.com</footer>
</body></html>`;
}

app.listen(PORT, () => {
  console.log(`\n✅  CRAFT Course Library running`);
  console.log(`    Local  → http://localhost:${PORT}`);
  if (BASE_URL) console.log(`    Public → ${BASE_URL}`);
});
