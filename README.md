# WildPote — Documentation technique

Bot pour **WildStat MMO** (`wildstatmmo.com`), un ARPG idle joué dans le navigateur.
Le bot est injecté via **Violentmonkey** (userscript) et interagit avec l'API officielle du jeu.

**Version actuelle** : 10.5 — Kiting fonctionnel, Home fonctionnel

---

## Table des matières

1. [Contexte du jeu](#1-contexte-du-jeu)
2. [Architecture de l'API du jeu](#2-architecture-de-lapi-du-jeu)
3. [Le problème du CSP et de l'isolation](#3-le-problème-du-csp-et-de-lisolation)
4. [Architecture du bot](#4-architecture-du-bot)
5. [Le hook Array cross-context](#5-le-hook-array-cross-context)
6. [Le kiting](#6-le-kiting)
7. [Home et voyage](#7-home-et-voyage)
8. [Debug et diagnostic](#8-debug-et-diagnostic)
9. [Historique des décisions](#9-historique-des-décisions)
10. [Pistes futures](#10-pistes-futures)

---

## 1. Contexte du jeu

### Stack
- **Frontend** : modules ES, bundles `coop-client.*.js` + `game.*.js`
- **Backend** : **SpacetimeDB** (`maincloud.spacetimedb.com`, database `wildwood-coop`)
- **Auth** : JWT SpacetimeDB stocké dans `localStorage` (clés `auth_token/spacetimeauth_id_token_v1`, etc.)
- **Communication** : WebSocket binaire (BSATN), **pas** du JSON
- **Mobs** : **100% simulés côté client**. Le serveur valide uniquement la "crédibilité" des kills (position cohérente, arme équipée, etc.)

### Maps connues
- **`town`** : hub principal, pas de portails vers les zones de jeu. Arrivée à `(6120, 5110)`.
- **`home_exterior`** : alias historique qui **redirige vers `town`** côté serveur.
- **Maps de campagne** : `tutorial_forest`, `beginner_desert`, …, `ion_citadel` (15 maps).
- **Maps Endless** : `endless_1`, `endless_2`, … (générées).

### Mécaniques de déplacement
1. **Portails in-world** : pour passer d'une zone de campagne à une autre (ou entre endless).
   **Aucun portail ne relie town aux zones de jeu.**
2. **Bouton menu « Home »** : seul moyen de rentrer en town depuis une zone.
   Appelle `changeMap("town", player.x, player.y)`.

---

## 2. Architecture de l'API du jeu

Le jeu expose un objet global **`window.wildstatCoop`** (et un alias legacy `window.wildwoodCoop`) via :

```js
Object.defineProperty(window, 'wildstatCoop', {
  value: wildstatCoop,
  writable: false,
  configurable: false,
  enumerable: true
});

L'objet est figé (Object.freeze). Il est posé après la connexion SpacetimeDB initiale.
Méthodes utiles
Méthode	Signature	Usage
isConnected()	() → boolean	Vérifier la connexion au serveur
localState()	() → {x, y, facing, speed, moving, mapId}	Position + map actuelles
localIdentity()	() → string	Identité du joueur (hex)
changeMap(mapId, x, y)	(string, number, number) → Promise<boolean>	Changer de map (mécanique du bouton Home)
findTeleportPlayer(query)	(string) → Promise<{identity, mapId}>	Dev uniquement
devTeleportToPlayer(id, mapId)	(string, string) → Promise<boolean>	Dev uniquement
devTeleportEndless(n)	(number) → Promise<{ok, error}>	Dev uniquement
syncMovementState(x, y, vx, vy, source, force, area, extra)	multiple	Envoi position (géré par le jeu)
useTownDoor(index)	(number) → Promise	Entrer/sortir d'un bâtiment en town
fallIntoWell()	() → Promise	Retour place de town (puits)
sendChatMessage(...)		Chat
startResearch(id)	(id) → Promise	Lancer une recherche
startItemUpgrade(slot, itemId, position)		Upgrade un item
mineNode(x, y)		Miner

⚠️ Les callbacks setOn* (ex: setOnItemDrop) sont réservés au jeu lui-même. Ils ne peuvent être revendiqués qu'une fois. Ne jamais les utiliser dans un userscript.
Structure d'un mob (EnemyState)

Capturée via le hook Array, 38 clés dont :
Clé	Type	Usage
x, y	number	Position
vx, vy	number	Vélocité
r	number	Rayon (hitbox)
hp, maxHp	number	Santé
dead	boolean	Mort
engaged	boolean	En combat
leashing	boolean	En retour (ignore)
aggroTargetId	string	Cible (hex identity ou "local-player")
aggroRadius	number	Zone d'aggro
leashRange	number	Portée max
speed	number	Vitesse
type, campName	string	Type et camp
generatedBoss	boolean	Boss
3. Le problème du CSP et de l'isolation
Le CSP du site
text

script-src 'self' 'unsafe-eval'

Conséquences :

    ❌ Les scripts injectés dynamiquement (<script src>, <script>inline</script>) sont bloqués

    ❌ GM_addElement('script', {...}) est bloqué sur Chrome ET Firefox

    ❌ unsafeWindow.eval(...) depuis un userscript classique est bloqué

    ✅ 'unsafe-eval' autorise eval() dans le contexte de la page, mais pas dans la sandbox du userscript

L'isolation des userscripts
Gestionnaire	Comportement
Tampermonkey (sandbox)	window isolé, unsafeWindow = proxy qui ne suit pas les ajouts dynamiques
Tampermonkey (@sandbox JavaScript, Firefox)	USERSCRIPT_WORLD, bypass le CSP, mais Xray bloque les écritures cross-context
Violentmonkey (@grant none)	window = window de la page, mais Xray bloque quand même les écritures
Violentmonkey (@grant unsafeWindow)	unsafeWindow = window de la page, mais Xray bloque les écritures

Xray Vision (Firefox) : barrière de sécurité qui empêche un userscript de lire/écrire dans les objets de la page (fonctions, prototypes, objets complexes). Les strings et nombres passent, mais pas les objets.
Ce qui marche / ce qui ne marche pas
Tentative	Firefox	Chrome
@grant none + window.wildstatCoop	❌ sandbox	❌ sandbox
@grant unsafeWindow + unsafeWindow.wildstatCoop	❌ Xray	❌ proxy
GM_addElement('script', {textContent})	❌ CSP	❌ CSP
unsafeWindow.eval(code)	❌ CSP	❌ CSP
Injection <script> inline	❌ CSP	❌ CSP
Blob + <script src="blob:...">	❌ CSP	❌ CSP
@sandbox JavaScript + unsafeWindow.wrappedJSObject	✅ API accessible	N/A
pageWindow.eval() depuis @sandbox JavaScript	✅ hook installé	N/A
pageWindow.__wildpote_chasers_json__ (string)	✅ lisible cross-context	N/A
La solution finale

Firefox uniquement (Chrome non supporté pour l'instant) :

    @sandbox JavaScript dans Violentmonkey (ou Tampermonkey)

    @grant unsafeWindow

    pageWindow = unsafeWindow.wrappedJSObject || unsafeWindow

    pageWindow.eval(code) pour injecter le hook dans la page

    Le hook écrit dans pageWindow.__wildpote_chasers_json__ (string JSON)

    Le sandbox lit pageWindow.__wildpote_chasers_json__ et parse via JSON.parse()

4. Architecture du bot
Fichiers

    WildPote.user.js — userscript unique (Violentmonkey, Firefox)

    docs/ARCHITECTURE.md — cette doc

Structure du userscript
text

┌─ En-tête Violentmonkey ────────────┐
│ @match wildstatmmo.com             │
│ @grant unsafeWindow                │
└────────────────────────────────────┘
              ↓
┌─ pageWindow = unsafeWindow ────────┐
│ Accès à la vraie window            │
└────────────────────────────────────┘
              ↓
┌─ installerHookArray() ─────────────┐
│ pageWindow.eval(code)              │
│ → hook installé DANS la page       │
│ → écrit __wildpote_chasers_json__  │
└────────────────────────────────────┘
              ↓
┌─ boucleKiting() (50ms) ────────────┐
│ Lit __wildpote_chasers_json__      │
│ JSON.parse → chasers               │
│ Calcule orbite                     │
│ Envoie touches via canvas          │
└────────────────────────────────────┘
              ↓
┌─ UI (onglets) ─────────────────────┐
│ FARM / QUEST / KITING / MISC       │
│ MISC → bouton "Copier diagnostic"  │
└────────────────────────────────────┘

Onglets de l'UI
Onglet	Statut	Contenu
FARM	À peupler	Mode campaign/reflect/aggro/soul, build, sliders
QUEST	À peupler	Tracker, bouton GO
KITING	✅ Fonctionnel	Toggle, stats live, config, anti-stuck
MISC	✅ Fonctionnel	État, diagnostic, bouton copier
Persistance (localStorage)
Clé	Valeur	Défaut
wildpote_kiting	'true' / 'false'	false
wildpote_antistuck	'true' / 'false'	true
wildpote_logs	'true' / 'false'	false
wildpote_pos	{top, left}	coin haut-droite
wildpote_tab	'kiting' etc.	'kiting'
wildpote_collapsed	'true' / 'false'	false
5. Le hook Array cross-context
Principe

Le hook est installé dans la page via pageWindow.eval(). Il intercepte .forEach(), .some(), .map(), .filter() sur Array.prototype, filtre les tableaux qui ressemblent à des mobs, et calcule les chasseurs.

Il écrit le résultat dans pageWindow.__wildpote_chasers_json__ (string JSON), ce qui contourne Xray.
Code du hook (simplifié)
javascript

(function() {
  if (window.__wildpote_hook_installed__) return;
  window.__wildpote_hook_installed__ = true;

  const origForEach = Array.prototype.forEach;
  const origSome = Array.prototype.some;
  const origMap = Array.prototype.map;
  const origFilter = Array.prototype.filter;

  let derniereCaptureTs = 0;

  function tryCapture(arr) {
    const now = performance.now();
    if (now - derniereCaptureTs < 50) return;  // Throttle 50ms

    if (arr.length === 0 || arr.length > 300) return;
    const first = arr[0];
    if (!first || typeof first !== 'object' || !first.hp || !first.x) return;

    derniereCaptureTs = now;

    try {
      const coop = window.wildstatCoop;
      if (!coop || !coop.isConnected()) return;
      const player = coop.localState();
      const identity = coop.localIdentity();
      if (!player) return;

      const chasers = [];
      let engagedCount = 0;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (e.dead) continue;
        if (e.engaged) engagedCount++;
        if (!e.engaged || e.leashing) continue;
        if (identity && e.aggroTargetId !== identity) continue;
        const dist = Math.hypot(e.x - player.x, e.y - player.y);
        if (dist < 600) {
          chasers.push({ x: e.x, y: e.y, r: e.r || 20, dist });
        }
      }

      chasers.sort((a, b) => a.dist - b.dist);
      const top5 = chasers.slice(0, 5);

      window.__wildpote_chasers__ = top5;
      window.__wildpote_chasers_json__ = JSON.stringify(top5);
      window.__wildpote_enemies_count__ = arr.length;
      window.__wildpote_engaged_count__ = engagedCount;
      window.__wildpote_last_capture_ts__ = Date.now();
    } catch (err) {
      // silencieux
    }
  }

  Array.prototype.forEach = function(...args) {
    if (this.length > 0 && this.length < 300) tryCapture(this);
    return origForEach.apply(this, args);
  };
  Array.prototype.some = function(...args) {
    if (this.length > 0 && this.length < 300) tryCapture(this);
    return origSome.apply(this, args);
  };
  Array.prototype.map = function(...args) {
    if (this.length > 0 && this.length < 300) tryCapture(this);
    return origMap.apply(this, args);
  };
  Array.prototype.filter = function(...args) {
    if (this.length > 0 && this.length < 300) tryCapture(this);
    return origFilter.apply(this, args);
  };

  console.log('[WildPote-Hook] Hook forEach/some/map/filter installé (throttled)');
})();

Pourquoi throttle 50ms ?

Sans throttle, le hook s'exécute des milliers de fois par seconde (18 701 appels en 2s mesurés). Firefox finit par planter ou freezer. Le throttle limite à 20 captures par seconde, largement suffisant pour le kiting.
Pourquoi pageWindow.eval et pas <script> ?

    <script> est bloqué par CSP

    pageWindow.eval est autorisé par 'unsafe-eval' dans le CSP

    pageWindow.eval s'exécute dans le contexte de la page (accès total à Array.prototype, window.wildstatCoop, etc.)

Pourquoi __wildpote_chasers_json__ (string) et pas __wildpote_chasers__ (array) ?

    __wildpote_chasers__ = tableau d'objets créés dans la page → Xray bloque la lecture depuis le sandbox

    __wildpote_chasers_json__ = string JSON → accessible partout (Xray ne bloque pas les strings)

6. Le kiting
Principe (porté de auto-farm-dodge.ts du jeu)

Le jeu a un système de kiting désactivé (AUTO_FARM_EVASION = false), mais tout le code est présent dans auto-farm-dodge.ts. On l'a porté dans WildPote.

Idée : les chasseurs courent plus vite que le joueur (+25 u/s), mais tournent lentement (ENEMY_CHASE_TURN_RATE = 6 rad/s). Si le joueur tourne en cercle de rayon R, le chasseur "settle" sur un cercle plus petit à l'intérieur, en traînant, et ne le rattrape jamais.
Formule clé (orbitTrail)
javascript

function orbitTrail(radius, speed, chaseSpeed, turnRate = 6) {
  const spin = speed / radius;
  const lag = Math.atan(spin / turnRate);
  const inner = chaseSpeed / (spin * Math.sqrt(1 + (spin / turnRate) ** 2));
  const square = radius * radius - (inner * Math.cos(lag)) ** 2;
  return square < 0 ? null : inner * Math.sin(lag) + Math.sqrt(square);
}

Retourne la distance de traînée d'un chasseur qui poursuit un joueur tournant en cercle de rayon radius à vitesse speed. null si le chasseur peut rattraper.
Sélection du rayon (orbitRadii)
javascript

function orbitRadii(speed, chaseSpeed, r, chasers, maxRadius) {
  // Calcule le "needed" : distance minimale pour être safe
  const widest = Math.max(...chasers.map(c => c.r || 20));
  const mean = chasers.reduce((s, c) => s + (c.r || 20), 0) / chasers.length;
  const needed = r + widest + ORBIT_CLEARANCE + ORBIT_CROWDING * mean * Math.sqrt(chasers.length - 1);

  // Cherche la "bande" de rayons qui donnent trail >= needed
  let low = Infinity, high = -Infinity;
  for (let radius = MIN_LOOP; radius <= maxRadius; radius += 2) {
    const trail = orbitTrail(radius, speed, Math.max(speed, chaseSpeed));
    if (trail === null) break;
    if (trail >= needed) { low = Math.min(low, radius); high = radius; }
  }

  // Prend 3 rayons dans la bande (band share 0.7, 0.4, 0.95) + des wide loops
  // ...
}

Constantes clés
Constante	Valeur	Rôle
ENEMY_CHASE_TURN_RATE	6	Rad/s, vitesse de rotation des mobs
ORBIT_CLEARANCE	6	Marge de sécurité
ORBIT_CROWDING	0.55	Facteur de foule
ORBIT_BAND_SHARE	0.7	Où dans la bande prendre le rayon
WIDE_LOOPS	[220, 170, 130]	Rayons de secours
MIN_LOOP	40	Rayon minimum
NOT_HOLDING	150	Pénalité si le rayon ne tient pas
ENTRY_COST	15	Pénalité si entrée mauvaise direction
ORBIT_LEAD	0.15	Avance sur l'orbite
CHASE_SPEED_BONUS	25	Vitesse mob = joueur + 25
KITE_GAP	60	Distance minimale (pas utilisé actuellement)
KITE_ROOM	160	Distance déclencheur du kiting
Boucle kiting (50ms)

    Vérifie kitingActif, estMort(), dernierInputJoueur (< 1.5s), coop.isConnected()

    Lit pageWindow.__wildpote_chasers_json__ → JSON.parse → chasers

    Si chasers.length === 0 → état attente

    Calcule plusProche (min des dist - r - PLAYER_RADIUS)

    Si plusProche >= KITE_ROOM → état safe (pas de kiting)

    Anti-stuck : si bloqué > 2s → relâche + change de direction

    Recalcule l'orbite si absente ou trop loin (> 50% de déviation)

    Si orbite → calcule orbitStep (point à viser sur l'orbite) → envoie les touches

Envoi des touches
javascript

function envoyerTouches(touchesVoulues) {
  const canvas = getCanvas();
  if (!canvas) return;
  if (document.activeElement !== canvas) canvas.focus();

  for (const t of touchesVoulues) {
    if (!touchesActives.has(t)) {
      canvas.dispatchEvent(new KeyboardEvent('keydown', {
        key: t, code: t, keyCode: KEYCODES[t], which: KEYCODES[t],
        bubbles: true, cancelable: true
      }));
      touchesActives.add(t);
    }
  }
  for (const t of touchesActives) {
    if (!touchesVoulues.includes(t)) {
      canvas.dispatchEvent(new KeyboardEvent('keyup', {
        key: t, code: t, keyCode: KEYCODES[t], which: KEYCODES[t],
        bubbles: true, cancelable: true
      }));
      touchesActives.delete(t);
    }
  }
}

Le canvas doit avoir le focus (canvas.focus()) pour que les touches soient prises en compte.
Direction → touches
javascript

function directionVersTouches(angleRad) {
  const deg = (angleRad * 180 / Math.PI + 360) % 360;
  const secteurs = [
    { min: 337.5, max: 22.5, touches: ['ArrowRight'] },
    { min: 22.5, max: 67.5, touches: ['ArrowDown', 'ArrowRight'] },
    { min: 67.5, max: 112.5, touches: ['ArrowDown'] },
    // ... 8 secteurs
  ];
  for (const s of secteurs) {
    if (s.min > s.max) { if (deg >= s.min || deg < s.max) return s.touches; }
    else if (deg >= s.min && deg < s.max) return s.touches;
  }
  return ['ArrowRight'];
}

Compatibilité autofarm

Les touches s'ajoutent au mouvement de l'autofarm (elles ne le remplacent pas). Le serveur accepte les kills car le perso reste à portée du camp (validé par le puppet plan).

Test : baseline autofarm seul 5s = 1054 unités. Avec ArrowUp maintenu 5s = 1945 unités. Les deux se combinent.
7. Home et voyage
Home (retour town)

Le bouton « Home » du jeu fait :
javascript

changeMap("town", player.x, player.y)

C'est la seule mécanique légale pour rentrer en town depuis une zone de jeu (aucun portail).

Test : changeMap("town", 3294, 2673) depuis endless_8 → true, atterrit en town (6120, 5110).
Voyage (retour à la map précédente)

Le champ homeDeparture n'est pas exposé dans wildstatCoop (il est interne à mapController).

Solution : le bot doit mémoriser lui-même la map avant chaque Home (via polling de localState().mapId).
travelFromHome

travelFromHome n'est pas exposé non plus. Le bouton « Retour » du jeu passe par le picker de voyage (dialogue HTML natif), qui s'ouvre quand on marche sur le portail de town (4780, 3635).

Non implémenté dans WildPote V10.5 (peu fiable en bot).
changeMap — validation serveur

    changeMap("endless_8", x, y) échoue avec "Move closer to the portal" si on n'est pas près d'un portail

    changeMap("town", x, y) fonctionne depuis n'importe où

    changeMap("home_exterior", x, y) redirige vers town

8. Debug et diagnostic
Bouton "📋 Copier diagnostic"

Dans l'onglet MISC, ce bouton copie dans le presse-papier :

    Version du bot

    État du hook (installé, actif)

    Compteurs (__wildpote_enemies_count__, __wildpote_engaged_count__, __wildpote_last_capture_ts__)

    Chasseurs JSON (les 5 plus proches)

    État API (isConnected, localState)

    Stats kiting (Chasseurs, Plus proche, Orbite, Touches, État)

    Config (toggles, KITE_ROOM, touches actives)

    Historique des 200 derniers logs

Utile pour partager l'état du bot quand quelque chose ne marche pas.
Logs [WildPote]

Filtrer la console sur [WildPote] pour voir les logs du bot. Filtrer sur [WildPote-Hook] pour voir les logs du hook (dans la page).
Logs Kiting: (activés par "Logs détaillés")
text

[22:49:04.434] Kiting: 5 chasseurs, gap=30, seuil=160, orbite=r=149
[22:49:04.637] Nouvelle orbite r=149 dir=-1
[22:49:05.054] Kiting: 4 chasseurs, gap=17, seuil=160, orbite=r=149

Erreurs courantes
Message	Cause	Solution
Permission denied to access object	Xray bloque la lecture d'objets de la page	Utiliser JSON (déjà fait)
Chasseurs: 0	Hook pas installé, ou pas en combat	Vérifier Hook visible: ✅ OUI, aller en combat
État: safe permanent	Aucun mob à moins de KITE_ROOM	Attendre que les mobs approchent
Firefox freeze	Hook trop coûteux	Vérifier le throttle (50ms), réduire les méthodes hookées
Hook installé: ❌ NON	pageWindow.eval échoue	Vérifier CSP, @grant unsafeWindow
9. Historique des décisions
Version	Décision	Raison
V1	Interception WebSocket via patch prototype.send	❌ CSP + timing
V2-V5	Injection <script> externe (raw.githack)	❌ CSP
V6	GM_addElement	❌ CSP
V7	unsafeWindow.eval	❌ CSP
V8	@sandbox JavaScript + unsafeWindow.wrappedJSObject	✅ Firefox uniquement
V9	UI 4 onglets, Home global, persistance	✅
V10.0-10.3	Hook Array via eval	✅ mais Xray bloque la lecture
V10.4	Hook écrit JSON cross-context	✅ Xray contourné
V10.5	Throttle 50ms + 4 méthodes + bouton diagnostic	✅ Firefox ne plante plus
V11 (prévu)	FARM + QUEST peuplés	⏳
10. Pistes futures
Court terme

    Peupler FARM : mode campaign/reflect/aggro/soul, build, sliders Move At / Fight At

    Peupler QUEST : tracker de quêtes, bouton GO

    Améliorer KITING : mode circle vs back-off, config KITE_ROOM/KITE_GAP

    Fix anti-stuck : relâcher toutes les touches avant de changer de direction (en cours)

    Fix instabilité orbite : garder l'orbite plus longtemps (en cours)

Moyen terme

    Retour map : mémoriser la map avant Home, proposer un bouton Retour

    Auto-farm : configurer les switches de l'autofarm ingame via l'UI

    Auto-research : lancer des recherches automatiquement

    Auto-upgrade : lancer des upgrades d'items

Long terme

    Chrome : trouver une solution pour Chrome (extension dédiée, ou attendre une API)

    Hooks canvas : intercepter CanvasRenderingContext2D.prototype.arc pour les zones d'attaque (AoE)

    Kiting avancé : mode planEvasion complet (esquive + orbite)

    Auto-prestige : gérer les prestiges automatiquement
