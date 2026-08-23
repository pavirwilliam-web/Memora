// Backend Memora — a lancer avec Node.js (18+ recommande, pour le fetch() natif).
// Voir README.md pour l'installation et le deploiement.

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_CODE = process.env.ADMIN_CODE;

if (!JWT_SECRET) { console.error('ERREUR : JWT_SECRET manquant dans .env'); process.exit(1); }
if (!GEMINI_API_KEY) console.warn('ATTENTION : GEMINI_API_KEY manquant — les fonctions IA échoueront.');
if (!ADMIN_CODE) console.warn('ATTENTION : ADMIN_CODE manquant — personne ne pourra devenir admin.');
// Le code est haché en mémoire au démarrage : il n'est jamais stocké ni renvoyé en clair,
// et n'apparaît nulle part dans le code envoyé au navigateur — seule cette instance du
// serveur le connaît, à partir de la variable d'environnement ADMIN_CODE.
const ADMIN_CODE_HASH = ADMIN_CODE ? bcrypt.hashSync(ADMIN_CODE, 10) : null;

const app = express();
app.use(express.json({ limit: '25mb' })); // limite large car les photos (base64) passent par ici
// Si le JSON dépasse la limite (plusieurs photos volumineuses envoyées d'un coup), Express
// renvoyait avant une page d'erreur HTML que le front essayait de parser comme du JSON —
// ce qui provoquait une exception silencieuse côté navigateur ("Erreur" générique sans
// explication). On répond maintenant proprement en JSON pour que le vrai message s'affiche.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Image(s) trop volumineuse(s) : réduis la taille ou envoie-les une par une.' });
  }
  if (err) {
    console.error(err);
    return res.status(400).json({ error: 'Requête invalide.' });
  }
  next();
});

// ================= Stockage simple (fichier JSON) =================
// Suffisant pour une petite appli / un usage en classe. Pour un usage a plus grande echelle,
// remplacer ce module par une vraie base de donnees (PostgreSQL, SQLite, etc.) tout en
// gardant les memes routes /api/*.
const DB_PATH = path.join(__dirname, 'data', 'db.json');
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { return { users: {}, shared: {}, private: {} }; }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
let db = loadDB();

// ================= Auth =================
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non connecté.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.username = payload.username;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
}

// Vérifie le bannissement stocké par le front (clé partagée "banned-usernames"), pour que
// l'interdiction s'applique même si quelqu'un appelle l'API directement en contournant le site.
function isBannedServerSide(usernameKey) {
  const list = db.shared['banned-usernames'];
  return Array.isArray(list) && list.includes(usernameKey);
}

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !username.trim() || !password || password.length < 6) {
    return res.status(400).json({ error: "Identifiant requis, mot de passe d'au moins 6 caractères." });
  }
  const key = username.trim().toLowerCase();
  if (db.users[key]) return res.status(400).json({ error: "Ce nom d'utilisateur existe déjà." });
  if (isBannedServerSide(key)) return res.status(403).json({ error: 'Cet identifiant a été banni.' });
  const passwordHash = await bcrypt.hash(password, 10);
  db.users[key] = { username: username.trim(), passwordHash, isAdmin: false, createdAt: Date.now() };
  saveDB(db);
  const token = jwt.sign({ username: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: username.trim(), isAdmin: false });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const key = (username || '').trim().toLowerCase();
  const user = db.users[key];
  if (!user) return res.status(400).json({ error: 'Identifiants incorrects.' });
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Identifiants incorrects.' });
  if (isBannedServerSide(key)) return res.status(403).json({ error: 'Ce compte a été suspendu par l\'admin.' });
  const token = jwt.sign({ username: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, isAdmin: !!user.isAdmin });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.users[req.username];
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ username: user.username, isAdmin: !!user.isAdmin });
});

app.post('/api/auth/admin-check', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!ADMIN_CODE_HASH) return res.status(500).json({ error: 'Code admin non configuré côté serveur.' });
  const ok = await bcrypt.compare(code || '', ADMIN_CODE_HASH);
  if (ok) {
    db.users[req.username].isAdmin = true;
    saveDB(db);
  }
  res.json({ isAdmin: ok });
});

// ================= Proxy IA (clé jamais exposée au navigateur) =================
// Utilise l'API Gemini de Google (gratuite, sans carte bancaire) via sa couche de
// compatibilité OpenAI. Le modèle "gemini-2.5-flash" gère à la fois le texte et les
// images (photos de cours).
function toOpenAiMessages(messages, system){
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of (messages || [])) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const parts = (m.content || []).map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'image' && block.source) {
        return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
      }
      return null;
    }).filter(Boolean);
    out.push({ role: m.role, content: parts });
  }
  return out;
}
app.post('/api/ask', requireAuth, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY non configurée côté serveur.' });
  try {
    const { max_tokens, messages, system } = req.body || {};
    const hasImages = (messages || []).some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'));
    // Note : les demandes qui utilisaient la recherche web (tools) côté Anthropic génèrent
    // maintenant leur réponse à partir des seules connaissances du modèle, sans recherche live.
    const body = {
      model: 'gemini-3.5-flash', // gemini-2.5-flash a été retiré par Google (erreur 404) : on utilise la génération actuelle
      max_tokens: (max_tokens || 1000) + (hasImages ? 1200 : 500), // marge pour le raisonnement interne du modèle (plus large avec des images)
      reasoning_effort: 'low',
      messages: toOpenAiMessages(messages, system),
    };
    const apiRes = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) {
      // On journalise la réponse brute de Google côté serveur (visible dans les logs Render)
      // et on renvoie un message plus parlant que le "Erreur API Gemini." générique d'avant,
      // qui masquait la vraie cause (clé invalide, modèle inconnu, quota dépassé, etc.).
      console.error('Erreur Gemini', apiRes.status, JSON.stringify(data));
      const detail = data.error?.message || data.error?.status || (data.error ? JSON.stringify(data.error) : null);
      return res.status(apiRes.status).json({ error: detail ? `Erreur Gemini (${apiRes.status}) : ${detail}` : `Erreur Gemini (HTTP ${apiRes.status}), voir les logs du serveur pour le détail.` });
    }
    const choice = data.choices?.[0];
    const text = choice?.message?.content || '';
    // Si le modèle a épuisé son budget de tokens en "réflexion" interne sans jamais produire
    // de réponse (fréquent avec plusieurs images + une consigne JSON stricte), l'API renvoie
    // un contenu vide sans erreur — on le détecte ici pour éviter un échec silencieux côté site.
    if (!text && choice?.finish_reason === 'length') {
      return res.status(502).json({ error: "L'IA a manqué de place pour répondre (trop d'images ou de texte à la fois) — réessaie avec moins d'images ou des photos plus légères." });
    }
    res.json({ text, raw: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur pendant l\'appel à Gemini : ' + (e.message || 'inconnue') });
  }
});

// ================= Stockage partagé / privé =================
app.get('/api/storage', requireAuth, (req, res) => {
  const { key, shared } = req.query;
  if (!key) return res.status(400).json({ error: 'key manquant.' });
  const store = shared === 'true' ? db.shared : (db.private[req.username] || {});
  res.json({ value: store[key] != null ? JSON.stringify(store[key]) : null });
});

app.post('/api/storage', requireAuth, (req, res) => {
  const { key, value, shared } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key manquant.' });
  let parsed = value;
  try { parsed = JSON.parse(value); } catch (e) { /* valeur simple non-JSON, on la garde telle quelle */ }
  if (shared) {
    db.shared[key] = parsed;
  } else {
    if (!db.private[req.username]) db.private[req.username] = {};
    db.private[req.username][key] = parsed;
  }
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/storage/list', requireAuth, (req, res) => {
  const { prefix = '', shared } = req.query;
  const store = shared === 'true' ? db.shared : (db.private[req.username] || {});
  const keys = Object.keys(store).filter(k => k.startsWith(prefix));
  res.json({ keys });
});

app.delete('/api/storage', requireAuth, (req, res) => {
  const { key, shared } = req.query;
  if (!key) return res.status(400).json({ error: 'key manquant.' });
  if (shared === 'true') {
    delete db.shared[key];
  } else if (db.private[req.username]) {
    delete db.private[req.username][key];
  }
  saveDB(db);
  res.json({ ok: true });
});

// ================= Fichiers statiques (le site lui-même) =================
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Memora backend lancé sur http://localhost:${PORT}`));
