# Memora — backend + site

Ce dossier contient tout ce qu'il faut pour héberger Memora avec les fonctions IA et les
comptes utilisateurs réellement fonctionnels (contrairement au fichier `index.html` seul,
qui ne marche que dans l'aperçu Claude.ai).

## Contenu
- `server.js` — le serveur (comptes, appel sécurisé à Claude, stockage)
- `public/index.html` — le site (servi automatiquement par le serveur)
- `package.json` — dépendances
- `.env.example` — modèle du fichier de configuration secrète
- `data/db.json` — généré automatiquement au premier lancement (comptes, scores, contenus)

## Installation locale (pour tester avant de mettre en ligne)

1. Installe [Node.js](https://nodejs.org) (version 18 ou plus).
2. Dans ce dossier, ouvre un terminal et lance :
   ```
   npm install
   ```
3. Copie `.env.example` en `.env` :
   ```
   cp .env.example .env
   ```
4. Remplis `.env` :
   - `GEMINI_API_KEY` : gratuite, sans carte bancaire — connecte-toi avec un compte Google sur https://aistudio.google.com puis "Get API Key" → "Create API Key"
   - `JWT_SECRET` : génère-en une avec `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `ADMIN_CODE` : ton code admin, en clair (le serveur le protège lui-même au démarrage)
5. Lance le serveur :
   ```
   npm start
   ```
6. Ouvre `http://localhost:3000` dans ton navigateur — le site tourne avec l'IA et les comptes réels.

## Mise en ligne (vrai hébergement)

Ce serveur doit tourner en continu (ce n'est pas un simple fichier HTML) : il te faut un
hébergement qui exécute du Node.js. Options simples et peu coûteuses :
- **Render.com** ou **Railway.app** : connecte ton dépôt GitHub, ajoute les mêmes variables
  que dans `.env` dans leur interface "Environment Variables", et c'est en ligne en quelques
  minutes.
- Un VPS (OVH, Hetzner...) : installe Node.js, copie ce dossier, `npm install`, puis lance le
  serveur avec un gestionnaire de process comme `pm2` pour qu'il redémarre automatiquement.

Dans tous les cas :
- Ne mets **jamais** ton fichier `.env` sur GitHub (ajoute-le à un `.gitignore`).
- Ton nom de domaine pointera directement vers ce serveur, qui sert le site **et** les
  fonctions IA/comptes en même temps (même adresse, pas de configuration supplémentaire
  côté navigateur).

## Sécurité — ce qui a changé par rapport à la version précédente
- Le mot de passe unique du site a été remplacé par un vrai système de comptes (inscription/
  connexion), mots de passe **hachés** avec bcrypt côté serveur — jamais stockés ou visibles
  en clair.
- Le code admin (`ADMIN_CODE` dans `.env`) est haché automatiquement en mémoire au démarrage
  du serveur et vérifié contre ce hash — il n'apparaît nulle part dans le code envoyé au
  navigateur.
- La clé API Gemini reste sur le serveur (`.env`), jamais visible depuis le navigateur.

## Fonctions IA — gratuit via Gemini (Google)
Ce backend appelle l'API Gemini de Google plutôt que l'API Anthropic (payante à l'usage).
Gratuit, sans carte bancaire, mais **attention** : sur ce palier gratuit, Google indique que
les contenus envoyés (questions, photos de cours) peuvent être utilisés pour améliorer ses
modèles — contrairement à l'offre payante. Limite connue également : la génération de fiche
par recherche web ne fait plus une vraie recherche en ligne — elle génère le contenu à partir
des connaissances du modèle. Le reste (quiz, corrections, flashcards, analyse de photos de
cours, chat) fonctionne normalement.

## Limite connue
Le stockage utilise un simple fichier `data/db.json` — largement suffisant pour une classe ou
un usage personnel, mais pas conçu pour un très grand nombre d'utilisateurs simultanés. Si le
site grandit beaucoup, il vaudra la peine de migrer vers une vraie base de données (SQLite ou
PostgreSQL) en gardant les mêmes routes `/api/*`.
