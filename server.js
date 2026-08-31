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

// Compte admin de secours (bootstrap) : identifiants lus UNIQUEMENT depuis les variables
// d'environnement côté serveur, jamais présents dans le code envoyé au navigateur.
// À définir sur Render > Environment : MASTER_ADMIN_USERNAME, MASTER_ADMIN_PASSWORD.
const MASTER_ADMIN_USERNAME = process.env.MASTER_ADMIN_USERNAME || 'jos@';
const MASTER_ADMIN_PASSWORD = process.env.MASTER_ADMIN_PASSWORD || null;
if (!MASTER_ADMIN_PASSWORD) console.warn('ATTENTION : MASTER_ADMIN_PASSWORD manquant — compte de secours désactivé.');

// ================= Notifications push (web-push) =================
// Nécessite le paquet npm "web-push" : ajoute-le avec `npm install web-push`.
// Clés VAPID à générer UNE SEULE FOIS avec la commande `npx web-push generate-vapid-keys`,
// puis à mettre dans les variables d'environnement du serveur (Render > Environment) :
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (ex: "mailto:toi@exemple.com")
// Sans ces variables, les notifications sont simplement désactivées (le reste du site
// continue de fonctionner normalement).
let webpush = null;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@example.com';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e) {
    console.warn('ATTENTION : paquet "web-push" manquant (npm install web-push) — notifications désactivées.');
  }
} else {
  console.warn('ATTENTION : VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquants — notifications push désactivées.');
}

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
//
// IMPORTANT — persistance entre déploiements : sur Render (et la plupart des hébergeurs du
// même type), le disque du service est ÉPHÉMÈRE par défaut — il est réinitialisé à chaque
// nouveau déploiement, ce qui efface data/db.json. Pour que la base survive aux mises à jour :
//   1. Sur Render, ajoute un "Persistent Disk" au service (Settings > Disks), monté par
//      exemple sur /var/data.
//   2. Ajoute une variable d'environnement DB_PATH = /var/data/db.json (le chemin doit être
//      DANS le dossier monté par le disque persistant).
// Sans cette variable, le comportement actuel (fichier local, effacé à chaque déploiement)
// est conservé tel quel — rien ne change si tu ne fais rien.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');
function loadDB() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!parsed.rooms) parsed.rooms = {}; // ajouté avec la fonctionnalité "salons" : absent des anciennes sauvegardes
    return parsed;
  }
  catch (e) { return { users: {}, shared: {}, private: {}, rooms: {} }; }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
let db = loadDB();

// ================= Salons de discussion (rooms) =================
// N'importe quel élève connecté peut créer un salon avec un code à 3-4 chiffres ; les autres
// doivent connaître ce code pour y entrer (à l'admin/créateur de le partager ou non).
// Des salons "de base" (un par matière de Terminale) sont créés automatiquement au démarrage,
// sans code (accès libre), pour que le chat ne parte pas vide.
// Le code n'est JAMAIS stocké en clair : uniquement son hash bcrypt, jamais renvoyé au front.
const DEFAULT_ROOM_SUBJECTS = [
  'Mathématiques', 'Physique-Chimie', 'SVT', 'Philosophie',
  'Français', 'Anglais', 'Histoire-Géographie', 'EPS',
];
function slugifyRoomId(name) {
  return 'default-' + name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
// Le "chat général" est un salon spécial toujours présent, sans code, que tout le monde
// voit en arrivant sur l'onglet Chat (pas besoin de rejoindre un salon pour y écrire).
// Il utilise exactement le même mécanisme que les salons normaux (mêmes routes de messages),
// il est juste exclu de la liste /api/rooms et protégé contre la suppression.
const GENERAL_ROOM_ID = 'general';
function ensureDefaultRooms() {
  let changed = false;
  if (!db.rooms[GENERAL_ROOM_ID]) {
    db.rooms[GENERAL_ROOM_ID] = {
      id: GENERAL_ROOM_ID, name: 'Chat général', subject: '', codeHash: null,
      isDefault: true, isGeneral: true, createdBy: null, createdAt: Date.now(), members: [],
    };
    changed = true;
  }
  DEFAULT_ROOM_SUBJECTS.forEach(subject => {
    const id = slugifyRoomId(subject);
    if (!db.rooms[id]) {
      db.rooms[id] = {
        id, name: subject, subject, codeHash: null, isDefault: true,
        createdBy: null, createdAt: Date.now(), members: [],
      };
      changed = true;
    }
  });
  if (changed) saveDB(db);
}
ensureDefaultRooms();

function roomPublicView(room) {
  return {
    id: room.id, name: room.name, subject: room.subject || '',
    isDefault: !!room.isDefault, hasCode: !!room.codeHash,
    createdBy: room.createdBy, createdAt: room.createdAt,
    memberCount: Array.isArray(room.members) ? room.members.length : 0,
  };
}
function isRoomMember(room, usernameKey) {
  return !room.codeHash || (Array.isArray(room.members) && room.members.includes(usernameKey));
}

app.get('/api/rooms', requireAuth, (req, res) => {
  // Le chat général n'apparaît pas dans la liste des salons à rejoindre : il est toujours
  // affiché directement, séparément (voir front-end).
  const list = Object.values(db.rooms).filter(r => !r.isGeneral).map(roomPublicView)
    .sort((a, b) => (b.isDefault - a.isDefault) || (a.createdAt - b.createdAt));
  res.json({ rooms: list });
});

app.post('/api/rooms', requireAuth, (req, res) => {
  const { name, code, subject } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom du salon requis.' });
  const trimmedCode = (code || '').trim();
  if (!trimmedCode || !/^[0-9]{3,4}$/.test(trimmedCode)) {
    return res.status(400).json({ error: 'Le code doit contenir 3 ou 4 chiffres.' });
  }
  const id = 'room-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const codeHash = bcrypt.hashSync(trimmedCode, 10);
  db.rooms[id] = {
    id, name: name.trim(), subject: (subject || '').trim(), codeHash, isDefault: false,
    createdBy: req.username, createdAt: Date.now(), members: [req.username],
  };
  saveDB(db);
  res.json({ room: roomPublicView(db.rooms[id]) });
});

app.post('/api/rooms/:id/join', requireAuth, (req, res) => {
  const room = db.rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Salon introuvable.' });
  if (!room.codeHash) { // salon ouvert (par ex. un salon par défaut) : pas de code à vérifier
    if (!room.members.includes(req.username)) { room.members.push(req.username); saveDB(db); }
    return res.json({ ok: true, room: roomPublicView(room) });
  }
  const { code } = req.body || {};
  const ok = bcrypt.compareSync((code || '').trim(), room.codeHash);
  if (!ok) return res.status(403).json({ error: 'Code incorrect.' });
  if (!room.members.includes(req.username)) { room.members.push(req.username); saveDB(db); }
  res.json({ ok: true, room: roomPublicView(room) });
});

// Suppression réservée aux admins (tous les admins, pas seulement le compte de secours).
app.delete('/api/rooms/:id', requireAuth, (req, res) => {
  const user = db.users[req.username];
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Réservé aux admins.' });
  const room = db.rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Salon introuvable.' });
  if (room.isGeneral) return res.status(403).json({ error: 'Le chat général ne peut pas être supprimé.' });
  delete db.rooms[req.params.id];
  delete db.shared['room-messages:' + req.params.id]; // supprime aussi les messages du salon
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const room = db.rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Salon introuvable.' });
  if (!isRoomMember(room, req.username)) return res.status(403).json({ error: "Il faut entrer le code du salon d'abord." });
  const msgs = db.shared['room-messages:' + req.params.id] || [];
  res.json({ messages: msgs });
});

app.post('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const room = db.rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Salon introuvable.' });
  if (!isRoomMember(room, req.username)) return res.status(403).json({ error: "Il faut entrer le code du salon d'abord." });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message vide.' });
  const key = 'room-messages:' + req.params.id;
  const msgs = db.shared[key] || [];
  const user = db.users[req.username];
  const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name: (user && user.username) || req.username, text: text.trim(), time: Date.now(), reports: 0 };
  msgs.push(msg);
  while (msgs.length > 200) msgs.shift();
  db.shared[key] = msgs;
  saveDB(db);
  // Notifie les autres membres du salon (pas l'expéditeur), comme pour l'ancien chat global.
  (room.members || []).forEach(memberKey => {
    if (memberKey !== req.username) sendPushToUser(memberKey, { title: `💬 ${room.name} — ${msg.name}`, body: msg.text.slice(0, 120), tag: 'room-' + room.id }).catch(() => {});
  });
  res.json({ ok: true, message: msg });
});

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

// Connexion via le compte de secours : le mot de passe n'est comparé que côté serveur,
// contre la variable d'environnement MASTER_ADMIN_PASSWORD. Crée le compte au passage
// s'il n'existe pas encore, et le marque admin.
app.post('/api/auth/master-login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!MASTER_ADMIN_PASSWORD) return res.status(500).json({ error: 'Compte de secours non configuré côté serveur.' });
  const key = (username || '').trim().toLowerCase();
  if (key !== MASTER_ADMIN_USERNAME.trim().toLowerCase() || password !== MASTER_ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }
  if (!db.users[key]) {
    const passwordHash = await bcrypt.hash(password, 10);
    db.users[key] = { username: MASTER_ADMIN_USERNAME, passwordHash, isAdmin: true, createdAt: Date.now() };
    saveDB(db);
  } else if (!db.users[key].isAdmin) {
    db.users[key].isAdmin = true;
    saveDB(db);
  }
  const token = jwt.sign({ username: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: db.users[key].username, isAdmin: true });
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
// Le plan gratuit de Google limite le nombre de requêtes PAR MINUTE (RPM) — et cette limite
// s'applique au projet entier, pas par élève. Le vrai problème n'est donc pas le "trafic"
// global du site (qui peut être très faible) mais les RAFALES : si 2-3 élèves déclenchent une
// fonctionnalité IA à quelques secondes d'intervalle, ou si une même action interne relance
// plusieurs requêtes (ex : le quiz qui retente automatiquement en cas de JSON invalide), le
// quota par minute peut être dépassé même avec un usage global très faible.
// Avant : chaque requête partait immédiatement vers Google, et en cas de 429 on retentait
// jusqu'à 2 fois de plus quasi tout de suite (1,5s puis 3s) — ce qui, au moment précis où le
// quota était déjà saturé, envoyait en réalité JUSQU'À 3 requêtes pour une seule action, ce
// qui AGGRAVAIT le dépassement au lieu de l'absorber.
// Solution : on sérialise maintenant TOUTES les requêtes vers Gemini dans une file d'attente
// unique côté serveur, avec un espacement minimum garanti entre deux appels — quel que soit
// le nombre d'élèves connectés en même temps, le débit envoyé à Google reste toujours sous la
// limite. Réglable via la variable d'environnement GEMINI_MIN_INTERVAL_MS si besoin (par
// défaut 4000 ms, soit au maximum 15 requêtes/minute).
const GEMINI_MIN_INTERVAL_MS = parseInt(process.env.GEMINI_MIN_INTERVAL_MS || '4000', 10);
let geminiQueue = Promise.resolve();
let lastGeminiCallAt = 0;
function callGemini(body) {
  const task = geminiQueue.then(async () => {
    const wait = Math.max(0, lastGeminiCallAt + GEMINI_MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastGeminiCallAt = Date.now();
    return fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  });
  // On chaîne la suite de la file même si cette requête échoue, pour qu'un échec ne bloque
  // jamais indéfiniment les demandes suivantes des autres élèves.
  geminiQueue = task.then(() => {}, () => {});
  return task;
}
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
    const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash'; // gemini-2.5-flash a été retiré par Google (erreur 404)
    // Modèle de secours optionnel, utilisé UNIQUEMENT si le modèle principal renvoie encore un
    // 429 après toutes les tentatives ci-dessous — utile quand le quota gratuit d'un modèle
    // récent (souvent plus serré) est épuisé pour la journée alors qu'un modèle plus ancien/
    // léger a encore du quota. Vide par défaut = comportement inchangé (pas de repli).
    // Pour l'activer sur Render : variable d'environnement GEMINI_FALLBACK_MODEL, ex.
    // "gemini-2.5-flash" ou "gemini-2.5-flash-lite".
    const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || '';
    const makeBody = (model) => ({
      model,
      max_tokens: (max_tokens || 1000) + (hasImages ? 1200 : 500), // marge pour le raisonnement interne du modèle (plus large avec des images)
      reasoning_effort: 'low',
      messages: toOpenAiMessages(messages, system),
    });
    const body = makeBody(GEMINI_MODEL);
    // Filet de sécurité en plus de la file d'attente ci-dessus. Deux cas transitoires à
    // absorber automatiquement, sans faire remonter d'erreur brute à l'élève :
    //  - 429 "RESOURCE_EXHAUSTED" : quota dépassé — peut être le quota PAR MINUTE (RPM, déjà
    //    largement absorbé par la file d'attente ci-dessus) ou le quota PAR JOUR (RPD), que
    //    seul un changement de modèle ou l'attente du lendemain peut résoudre ;
    //  - 503 "UNAVAILABLE" : les serveurs de Google sont temporairement surchargés (rien à voir
    //    avec notre code ni notre quota — ça arrive surtout aux heures de pointe sur les
    //    modèles récents). Avant, seul le 429 était retenté : un 503 remontait directement
    //    l'erreur brute ("Erreur Gemini (HTTP 503)") sans aucune nouvelle tentative.
    const RETRYABLE_STATUSES = [429, 503];
    let apiRes, data;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      apiRes = await callGemini(body); // passe par la file d'attente globale (voir plus haut)
      data = await apiRes.json();
      if (apiRes.ok || !RETRYABLE_STATUSES.includes(apiRes.status) || attempt === maxAttempts) break;
      // La requête repasse par la même file d'attente (donc déjà espacée) ; on ajoute quand
      // même une petite marge croissante pour laisser le temps au quota ou aux serveurs de
      // Google de se libérer.
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
    // Si le modèle principal reste bloqué en 429 après toutes les tentatives (typiquement un
    // quota JOURNALIER épuisé, que l'attente n'a pas pu résoudre) et qu'un modèle de secours
    // est configuré, on tente UNE fois avec celui-ci avant d'abandonner.
    if (!apiRes.ok && apiRes.status === 429 && GEMINI_FALLBACK_MODEL) {
      console.error(`Quota épuisé sur ${GEMINI_MODEL}, tentative avec le modèle de secours ${GEMINI_FALLBACK_MODEL}`);
      apiRes = await callGemini(makeBody(GEMINI_FALLBACK_MODEL));
      data = await apiRes.json();
    }
    if (!apiRes.ok) {
      // On journalise la réponse brute de Google côté serveur (visible dans les logs Render) —
      // le champ data.error précise généralement s'il s'agit d'un quota par minute ou par jour
      // (utile pour savoir si GEMINI_MIN_INTERVAL_MS suffira ou s'il faut changer de modèle/
      // plan) — et on renvoie un message plus parlant que le "Erreur API Gemini." générique
      // d'avant, qui masquait la vraie cause (clé invalide, modèle inconnu, quota dépassé,
      // serveur surchargé, etc.).
      console.error('Erreur Gemini', apiRes.status, JSON.stringify(data));
      if (apiRes.status === 429) {
        return res.status(429).json({ error: "Trop de demandes à l'IA en même temps (limite du plan Gemini gratuit) — attends quelques secondes puis réessaie. Si ça persiste, évite d'envoyer plusieurs photos d'un coup." });
      }
      if (apiRes.status === 503) {
        return res.status(503).json({ error: "Les serveurs de Google sont momentanément surchargés (indépendant de ton site) — patiente quelques instants puis réessaie." });
      }
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
    // Détecte un nouveau message de chat / un nouveau code de connexion pour déclencher une
    // notification push, AVANT d'écraser l'ancienne valeur (pour comparer les deux).
    if (key === 'chat-messages' && Array.isArray(parsed)) {
      const before = Array.isArray(db.shared[key]) ? db.shared[key] : [];
      if (parsed.length > before.length) {
        const newMsg = parsed[parsed.length - 1];
        if (newMsg && newMsg.name) {
          // Tag unique par message (avant : 'chat' fixe pour tous les messages, ce qui faisait que
          // le push du 2e message remplaçait silencieusement celui du 1er sans re-notifier l'appareil).
          notifyAllExcept(newMsg.name, { title: `💬 ${newMsg.name}`, body: (newMsg.text || '').slice(0, 120), tag: 'chat-' + (newMsg.id || parsed.length) });
        }
      }
    }
    if (key.startsWith('user-status:') && parsed && !parsed.premium && parsed.trialStart) {
      const before = db.shared[key] || {};
      const elapsed = Date.now() - parsed.trialStart;
      const wasLocked = before.trialStart ? (Date.now() - before.trialStart) >= (15 * 60 * 1000) : false;
      const nowLocked = elapsed >= (15 * 60 * 1000);
      if (nowLocked && !wasLocked && !parsed.dismissed) {
        notifyAdmins({ title: '💎 Nouvelle demande premium', body: `${key.slice('user-status:'.length)} a terminé son essai gratuit.`, tag: key });
      }
    }
    // Nouvelle(s) notion(s) ajoutée(s) par un admin (front envoie l'index complet à chaque
    // ajout/suppression/édition) : si l'index s'allonge, on notifie les autres élèves du/des
    // nouveau(x) titre(s) — avant, aucune notification n'était envoyée sur ce type de sauvegarde.
    if (key === 'notions-index' && Array.isArray(parsed)) {
      const before = Array.isArray(db.shared[key]) ? db.shared[key] : [];
      if (parsed.length > before.length) {
        const beforeIds = new Set(before.map(n => n.id));
        const added = parsed.filter(n => !beforeIds.has(n.id));
        added.forEach(n => {
          notifyAllExcept(req.username, {
            title: '📘 Nouvelle notion ajoutée',
            body: n.title ? (n.title + (n.category ? ' — ' + n.category : '')) : 'Une nouvelle notion est disponible.',
            tag: 'notion-' + n.id,
          });
        });
      }
    }
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

// ================= Notifications push =================
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

// Un même élève peut avoir plusieurs appareils/navigateurs abonnés : on les garde tous
// (une liste par utilisateur), identifiés par leur "endpoint" pour éviter les doublons.
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Abonnement invalide.' });
  if (!db.private[req.username]) db.private[req.username] = {};
  const list = db.private[req.username].pushSubscriptions || [];
  const filtered = list.filter(s => s.endpoint !== subscription.endpoint);
  filtered.push(subscription);
  db.private[req.username].pushSubscriptions = filtered;
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (db.private[req.username] && Array.isArray(db.private[req.username].pushSubscriptions)) {
    db.private[req.username].pushSubscriptions = db.private[req.username].pushSubscriptions.filter(s => s.endpoint !== endpoint);
    saveDB(db);
  }
  res.json({ ok: true });
});

// Envoie une notification push à un utilisateur précis (sur tous ses appareils abonnés).
// Retire silencieusement les abonnements devenus invalides (410/404 = désinstallé, etc.).
async function sendPushToUser(usernameKey, payload) {
  if (!webpush) return;
  const priv = db.private[usernameKey];
  const subs = priv && Array.isArray(priv.pushSubscriptions) ? priv.pushSubscriptions : [];
  if (!subs.length) return;
  let changed = false;
  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      stillValid.push(sub);
    } catch (e) {
      changed = true; // abonnement expiré/invalide : on ne le garde pas
    }
  }
  if (changed) { priv.pushSubscriptions = stillValid; saveDB(db); }
}
function notifyAllExcept(excludedUsernameOrKey, payload) {
  const excludedKey = (excludedUsernameOrKey || '').trim().toLowerCase();
  Object.keys(db.private).forEach(key => { if (key !== excludedKey) sendPushToUser(key, payload).catch(() => {}); });
}
function notifyAdmins(payload) {
  Object.keys(db.users).forEach(key => { if (db.users[key].isAdmin) sendPushToUser(key, payload).catch(() => {}); });
}

// ================= Rappels de révision (planning long) =================
// Parcourt le planning privé ("revision-plan") de chaque utilisateur et envoie une
// notification push pour tout créneau dont l'heure est passée, pas encore fait, et pas
// encore notifié (flag "notified", pour ne jamais renvoyer deux fois la même notif).
//
// IMPORTANT — hébergement gratuit (Render free) : le setInterval ci-dessous ne tourne QUE
// pendant que le serveur est éveillé. Sur le plan gratuit, Render met le service en veille
// après ~15 min sans requête, ce qui arrête aussi ce setInterval — les rappels ne partiraient
// alors plus du tout tant que personne ne visite le site.
// Pour contourner ça SANS passer à un plan payant : une route dédiée /api/cron/... est
// exposée ci-dessous, à faire appeler automatiquement toutes les X minutes par un service
// de "cron" externe et gratuit (voir le message de fin pour la marche à suivre). Chaque
// appel réveille le serveur si besoin ET déclenche la vérification — c'est ce mécanisme,
// et non le setInterval, qui doit être considéré comme le vrai déclencheur fiable ici.
function checkRevisionReminders() {
  const now = Date.now();
  let changed = false;
  Object.keys(db.private).forEach(userKey => {
    const plan = db.private[userKey] && db.private[userKey]['revision-plan'];
    if (!plan || !Array.isArray(plan.days)) return;
    plan.days.forEach(day => {
      (day.slots || []).forEach(slot => {
        if (slot.done || slot.notified) return;
        const slotTime = new Date(`${day.date}T${(slot.time || '18:00')}:00`).getTime();
        if (!isNaN(slotTime) && slotTime <= now) {
          sendPushToUser(userKey, {
            title: '📚 C\'est l\'heure de réviser !',
            body: slot.subject ? (slot.subject + (slot.method ? ' — ' + slot.method : '')) : 'Un créneau de ton planning de révision.',
            tag: 'revision-slot-' + slot.id,
          }).catch(() => {});
          slot.notified = true;
          changed = true;
        }
      });
    });
  });
  if (changed) saveDB(db);
}
setInterval(checkRevisionReminders, 60 * 1000); // marche tant que le serveur est éveillé

// Route à appeler périodiquement par un service de cron externe (voir README / message de
// déploiement). CRON_SECRET est optionnel : si défini côté Render, l'appel doit fournir
// ?secret=... pour être accepté (évite que n'importe qui déclenche cette route au hasard).
const CRON_SECRET = process.env.CRON_SECRET || null;
app.get('/api/cron/check-revision-reminders', (req, res) => {
  if (CRON_SECRET && req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: 'Secret invalide.' });
  }
  checkRevisionReminders();
  res.json({ ok: true });
});

// ================= Fichiers statiques (le site lui-même) =================
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Memora backend lancé sur http://localhost:${PORT}`));
