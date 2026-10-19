WildPote — Documentation technique

Bot pour WildStat MMO (wildstatmmo.com), un ARPG idle joué dans le navigateur.
Le bot est injecté via Violentmonkey (userscript) et interagit avec l'API officielle du jeu.

Version actuelle : 19.5 — Kiting, Home, Portails, Auto-quest, Auto-farm quêtes, Prestige
Table des matières

    Contexte du jeu

    Architecture de l'API du jeu

    Le problème du CSP et de l'isolation

    Architecture du bot

    Le hook Array cross-context

    Le kiting

    Home et voyage — mécaniques serveur

    Navigation par portails in-world ⭐

    Auto-quest : routine complète ⭐

    Debug et diagnostic

    Historique des décisions

    Pistes futures

1. Contexte du jeu
Stack

    Frontend : modules ES, bundles coop-client.*.js + game.*.js

    Backend : SpacetimeDB (maincloud.spacetimedb.com, database wildwood-coop)

    Auth : JWT SpacetimeDB stocké dans localStorage

    Communication : WebSocket binaire (BSATN), pas du JSON

    Mobs : 100% simulés côté client. Le serveur valide uniquement la "crédibilité" des kills (position cohérente, arme équipée, etc.)

Maps connues

    town : hub principal, aucun portail vers les zones de jeu. Arrivée à (6120, 5110).

    home_exterior : alias historique qui redirige vers town côté serveur.

    Maps de campagne : tutorial_forest (1) → ion_citadel (15). Voir MAPS_ORDRE dans le bot.

    Maps Endless : endless_1, endless_2, … générées procéduralement côté client ET serveur (même seed).

Mécaniques de déplacement

    Portails in-world : pour passer d'une zone de campagne à une autre, ou d'un endless à un autre.
    Aucun portail ne relie town aux zones de jeu.

    Bouton menu « Home » : seul moyen de rentrer en town depuis une zone.
    Appelle changeMap("town", player.x, player.y).

2. Architecture de l'API du jeu
window.wildstatCoop

Objet global exposé après connexion SpacetimeDB. Figé (Object.freeze) et posé via Object.defineProperty(window, 'wildstatCoop', { writable: false, configurable: false }).

Méthodes utiles :
Méthode	Signature	Usage
isConnected()	() → boolean	Vérifier la connexion
localState()	() → {x, y, facing, speed, moving, mapId}	Position serveur — STALE de ~1-2s ⚠️
localIdentity()	() → string	Identité (hex)
changeMap(mapId, x, y)	(string, number, number) → Promise<boolean>	Valide la position côté serveur
dailyQuests()	() → { quests, guildName, bonus, ... }	Quêtes du jour
prestige() / prestigeAccount()		Prestige
claimDailyGemBonus()		Gemmes
refreshDailyQuests()		Refresh quêtes
useTownDoor(index)	(number) → Promise	Portes de town
sendChatMessage(...), startResearch(id), startItemUpgrade(...), mineNode(x, y)		Autres

⚠️ Ne jamais utiliser les setOn* (setOnItemDrop, etc.) : réservés au jeu, une seule revendication.
Structure d'un mob (EnemyState)

38 clés, capturées via le hook Array :
Clé	Type	Usage
x, y	number	Position
vx, vy	number	Vélocité
r	number	Rayon (hitbox)
hp, maxHp	number	Santé
dead	boolean	Mort
engaged	boolean	En combat
leashing	boolean	En retour (ignore)
aggroTargetId	string	Cible (identity ou "local-player")
aggroRadius, leashRange, speed	number	Config
type, campName	string	Type et camp
generatedBoss	boolean	Boss
Serveur change_map — validation exacte

Source : spacetimedb/src/map-travel.ts (voir changePlayerMap).
typescript

const sourcePortal = sourcePortals
  .filter(p => p.destination === mapId)
  .sort((a, b) => Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y))[0];
if (!sourcePortal) throw new SenderError("Maps are not connected.");
const portalDistance = Math.hypot(x - sourcePortal.x, y - sourcePortal.y);
if (portalDistance > MAP_PORTAL_USE_RANGE) throw new SenderError("Move closer to the portal.");

MAP_PORTAL_USE_RANGE = 125 (rayon euclidien autour du portalUsePoint).

Le portalUsePoint officiel (shared/map-gateways.ts) :
typescript

export function portalUsePoint(portal: MapGatewayPortal) {
  return { x: portal.x, y: portal.y - portal.height * .32, destination: portal.destination };
}

Avec height = 198, le point d'usage est à y - 63.36 (32% de la hauteur depuis le pied).

⚠️ Conséquence majeure : changeMap doit être appelé avec une position dans la sphère de 125px du portalUsePoint. Le bot ne peut pas juste viser le pied du portail.
Deux types de portails serveur

1. Campaign maps (tutorial_forest … ion_citadel) : sourcePortals = MAP_PORTALS[current.mapId] → vient de CAMPAIGN_GATEWAYS (hardcodé dans shared/map-gateways.ts, pas exposé sur window).

2. Endless maps (endless_N) : sourcePortals = generateMap(current.mapId).portals.map(p => ({...p, y: p.y - p.height * 0.32 })) → généré dynamiquement, les portails sont à (2400 ± 110, 2400) avec destination endless_(N-1) / endless_(N+1).

C'est pour ça que les transitions endless marchent sans CAMPAIGN_GATEWAYS : le serveur utilise generateMap(), pas la table campaign.
3. Le problème du CSP et de l'isolation

(inchangé depuis v10.5)
CSP
text

script-src 'self' 'unsafe-eval'

    ❌ Scripts injectés bloqués

    ❌ GM_addElement bloqué

    ❌ unsafeWindow.eval depuis userscript classique bloqué

    ✅ 'unsafe-eval' autorise eval() dans le contexte de la page

Solution finale (Firefox)

    @sandbox JavaScript dans Violentmonkey

    @grant unsafeWindow

    pageWindow = unsafeWindow.wrappedJSObject || unsafeWindow

    pageWindow.eval(code) pour injecter le hook

    Communication cross-context via strings JSON (Xray bloque les objets, pas les strings)

4. Architecture du bot
Fichiers

    WildPote.user.js — userscript unique (Violentmonkey, Firefox)

    docs/ARCHITECTURE.md — cette doc

Structure v19.5
text

┌─ En-tête Violentmonkey ────────────┐
│ @match wildstatmmo.com             │
│ @grant unsafeWindow                │
└────────────────────────────────────┘
              ↓
┌─ pageWindow = unsafeWindow ────────┐
└────────────────────────────────────┘
              ↓
┌─ installerHookArray() ─────────────┐
│ pageWindow.eval(code)              │
│ → hook chasers + hook minimap      │
│ → hook portails (getPortals)       │
│ → hook quêtes (dailyQuests)        │
└────────────────────────────────────┘
              ↓
┌─ boucleKiting() (100ms) ───────────┐
│ Lit __wildpote_chasers_json__      │
│ Calcule orbite                     │
│ Envoie touches via canvas          │
└────────────────────────────────────┘
              ↓
┌─ Moniteur MAP CHANGE (100ms) ──────┐
│ Logge chaque changement de mapId   │
└────────────────────────────────────┘
              ↓
┌─ UI (4 onglets) ───────────────────┐
│ FARM / QUEST / KITING / MISC       │
└────────────────────────────────────┘

Onglets de l'UI
Onglet	Contenu
FARM	Auto-prestige (toggle, bouton, timer)
QUEST	Résumé quêtes, 3 actives, terminées, en attente, TEST PORTAILS (boutons prev/next, diag, debug), AUTO-FARM QUÊTES (toggle, logs copiables)
KITING	Toggle, diag kiting
MISC	État (map, position serveur/minimap, source), logs, bouton HOME
Persistance (localStorage)
Clé	Valeur	Défaut
wildpote_kiting	'true' / 'false'	false
wildpote_antistuck	'true' / 'false'	true
wildpote_logs	'true' / 'false'	false
wildpote_pos	{top, left}	coin haut-droite
wildpote_tab	'kiting' etc.	'kiting'
wildpote_collapsed	'true' / 'false'	false
wildpote_autoprestige	bool	true
wildpote_autologin	bool	true
wildpote_autodailygems	bool	false
wildpote_autofarmquest	bool	false
wildpote_prestige_time	timestamp ms	0
wildpote_prestige_duree	string	null
5. Le hook Array cross-context

(inchangé, mais enrichi)
Trois hooks distincts

1. Hook Array (Array.prototype.forEach/some/map/filter) → détecte les tableaux de mobs, calcule les 5 chasseurs les plus proches, écrit __wildpote_chasers_json__.

Throttle 50ms — sans lui, 18 701 appels en 2s mesurés, Firefox freeze.

2. Hook Canvas minimap (CanvasRenderingContext2D.prototype.fill) → détecte le diamant blanc (joueur sur la minimap, 4 points, fillStyle === '#ffffff', avgDist entre 2 et 15, variance ≤ 2) et écrit __wildpote_minimap_json__.

⚠️ Position minimap = CLIENT, à jour. C'est la seule source fiable pour marcherVersDiag. localState() (serveur) a un lag de 1-2s qui casse la détection d'arrivée.

3. Hook __wildpote_getPortals__() → retourne les portails de la map courante :

    Endless : {x: 2290|2510, y: 2400, useY: 2400 - 63.36, destination: 'endless_(N±1)'} (useY officiel 0.32)

    Campaign : lit MAP_EDITOR_GAMEPLAY_OVERRIDES puis CAMPAIGN_GATEWAYS (les deux ne sont pas exposés sur window en pratique, donc retourne portals: null → le bot fallback sur MAPS_ORDRE + fallbackPortal)

Pourquoi JSON et pas objet ?

Xray Vision (Firefox) bloque la lecture cross-context des objets créés dans la page. Les strings JSON passent.
Canvas focus — découverte v19.4

Le canvas #gameGpu a aria-hidden="true" en permanence. Un élément aria-hidden ne peut pas recevoir le focus via canvas.focus(). Sans focus, les KeyboardEvent ne sont pas traités par les listeners du jeu (même dispatchés sur canvas).

Fix :
javascript

if (canvasEl.getAttribute('aria-hidden') === 'true') {
  canvasEl.setAttribute('data-wp-aria-hidden', 'true');
  canvasEl.removeAttribute('aria-hidden');
}

Le bot retire aria-hidden au premier getCanvas(), ce qui permet canvas.focus() dans envoyerTouches().
6. Le kiting

(inchangé, voir v10.5)

Principe, formules orbitTrail/orbitRadii, sélection d'orbite, envoi des touches.

Complément v19.5 : la boucle tourne à 100ms (au lieu de 50ms). Pendant navigationEnCours === true, la boucle ne fait rien (le bot navigue).
7. Home et voyage — mécaniques serveur
Home (retour town)

changeMap("town", x, y) — fonctionne depuis n'importe où, aucune validation de portail.
Voyage vers une map de campagne

Deux chemins possibles :

    Depuis town : changeMap(mapId, x, y) avec townPortalUsePoints(mapId) → tous les portails de town acceptent n'importe quelle destination débloquée.

    Depuis une map de campagne : utiliser un portail in-world — voir section 8.

Unlock validation serveur
typescript

const campaignIndex = CAMPAIGN_MAPS.findIndex(map => map.id === mapId);
if (campaignIndex > 0 && !campaignMapUnlocked(campaignIndex, currentProgress ?? {})) {
  throw new SenderError(`Defeat ${CAMPAIGN_MAPS[campaignIndex - 1].bossName} before entering ${MAP_DISPLAY_NAMES[mapId]}.`);
}

Impossible d'entrer dans une map de campagne sans avoir battu le boss de la précédente.
8. Navigation par portails in-world ⭐

Le sujet le plus complexe du bot. Trois ans de tentatives pour comprendre pourquoi le bot ne franchissait pas les portails.
Le problème initial

Le bot marchait vers le portail, s'arrêtait "arrivé", mais rien ne se passait. Le serveur ne recevait jamais change_map (ou le recevait avec une position hors zone).
Comprendre le client WildStat

Découverte clé : le client de jeu ne déclenche pas change_map via une touche. Quand le joueur entre dans la zone d'un portail, le client de jeu détecte la collision et appelle change_map automatiquement.

MAIS : la collision doit être réelle (position du joueur dans le rayon de 125px du portalUsePoint). Si le joueur est juste au bord, la collision ne se déclenche pas toujours — soit par timing (frame suivante), soit par flottement de la position.
Trois bugs en cascade

Bug 1 — localState stale dans marcherVersDiag

marcherVersDiag utilisait localState() (serveur) pour calculer la distance. Le serveur met à jour la position toutes les 1-2s. Le bot marchait pendant 4s vers une cible en pensant être à (2290, 2381) alors qu'il était déjà arrivé il y a 2s, ou encore à (2215, 2555).

Symptôme : dist=189px pendant 24s alors que le joueur bougeait côté client. Le bot ne détectait jamais dist < 40.

Fix : utiliser getPositionInterpolee() (minimap client, à jour 60 fps) pour la marche. Garder localState() uniquement pour détecter le changement de mapId.

Bug 2 — Canvas aria-hidden = pas de focus = touches ignorées

Voir section 5. Sans aria-hidden retiré, canvas.focus() échoue, les KeyboardEvent dispatchés ne sont pas traités, le joueur ne bouge pas.

Symptôme : le joueur reste immobile malgré les touches envoyées. Puis téléport au coin (17, 4783) après 25s (anti-AFK serveur).

Fix : retirer aria-hidden dans getCanvas(), forcer canvas.focus() dans envoyerTouches().

Bug 3 — Le bot s'arrête "arrivé" mais hors zone

Avec dist < ARRIVAL_THRESHOLD_PX = 40 de la cible overshootée (2290, 2381), le joueur peut être à (2290, 2420) (au-delà de la cible mais toujours à dist < 40). Distance au portalUsePoint (2290, 2336.64) = sqrt(0² + 83²) = 83px. Dans la zone (125) mais juste au bord. La collision ne se déclenche pas toujours — soit par timing, soit parce que le jeu exige un mouvement continu.

Fix v19.5 — push directionnel court

Après arrived, le bot envoie une seule touche directionnelle (ArrowUp si le portail est au-dessus, ArrowDown sinon) pendant 150ms, puis relâche. Le joueur parcourt ~44px, entre franchement dans la sphère → collision garantie.
javascript

const posY = posArrivee?.y ?? (portal.baseUseY ?? portal.useY);
const pushDir = (portal.baseUseY ?? portal.useY) < posY ? 'ArrowUp' : 'ArrowDown';
await pushDirectionnel(pushDir, 150);

Ce n'est PAS une touche d'interaction — c'est une touche directionnelle qui pousse physiquement le joueur dans la hitbox.
Les fausses pistes explorées
Tentative	Pourquoi ça a échoué
Space, Enter, KeyE, KeyF, KeyR	❌ Ouvrent des panneaux UI (auto-farm, inventaire, quêtes). Space ouvre l'auto-farm — d'où le bug "fenêtre auto-farm à chaque portail".
overshoot = 0	Le bot s'arrête trop tôt, la collision ne prend pas
overshoot = 90 (plier)	Le bot sort de la zone 125px
ARRIVAL_THRESHOLD_PX = 15	Trop précis, le bot n'atteint jamais la cible
useY = y - 63.36 (official)	Fonctionne mais l'arrêt à dist < 40 ramène à 2381 → au bord
Hardcoder CAMPAIGN_GATEWAYS	Pas nécessaire, le fallback MAPS_ORDRE marche
Solution finale v19.5
text

1. marcherVersDiag : position via minimap CLIENT (getPositionInterpolee)
2. Fin de marche : dist < 40 de la cible overshootée (y + 45)
3. Après arrived : push ArrowUp/ArrowDown 150ms
4. Attendre change_map (le client appelle automatiquement quand le joueur entre vraiment dans la zone)
5. Détecter la transition via localState.mapId (polling 200ms, timeout 10s)

Résultat mesuré : 15 portails endless traversés en 26s (1-2s par portail), 6 portails campaign en 12s.
trouverPortailVersCible — le routage
javascript

1. getAllRealPortals(mapActuelle) → essayer via hook
   - Si un portail a destination === mapCible → match direct
   - Sinon → fallback MAPS_ORDRE
2. Si getAllRealPortals échoue (campaign, hook retourne null) →
   fallback MAPS_ORDRE + fallbackPortal

Pour les campaign, getAllRealPortals retourne null (car CAMPAIGN_GATEWAYS n'est pas exposé). Le bot utilise fallbackPortal(mapId, direction) qui calcule (MAP_MIDDLE.x ± 110, MAP_MIDDLE.y - 99). Ça marche parce que les vrais portails campaign sont à (2400 ± 110, 2400) — c'est exactement la position que middleGateways utilise dans le code serveur (shared/map-gateways.ts).

Pour les endless, getAllRealPortals retourne les vrais portails avec destinations endless_(N±1) → match direct garanti.
Constantes clés
Constante	Valeur	Rôle
MAP_PORTAL_USE_RANGE	125	Rayon serveur, repris du code source
PORTAL_USE_RATIO	0.5	Fallback campaign (middle-gateways)
PORTAL_HEIGHT	198	Repris du code source
PORTAL_OVERSHOOT_PX	45	Push vertical après arrived
PUSH_DURATION_MS	150	Durée du push (ArrowUp/ArrowDown)
ARRIVAL_THRESHOLD_PX	40	Tolérance d'arrivée
GATEWAY_SPACING	220	Repris du code source
MAP_MIDDLE	{x: 2400, y: 2400}	Repris du code source
9. Auto-quest : routine complète ⭐
Principe

Le bot parcourt les 3 quêtes actives de la guilde, voyage vers la map de chaque cible, attend la progression (via kiting ou joueur), et passe à la suivante.
Lecture des quêtes
javascript

function exposerQuestsJson() {
  pageWindow.eval(`
    setInterval(() => {
      const data = wildstatCoop.dailyQuests();
      window.__wildpote_quests_json__ = JSON.stringify({
        guildName, bonus, guildPoints,
        quests: data.quests.map(q => ({ mapId, enemy, target, progress, takenBy }))
      });
    }, 3000);
  `);
}

Filtre actives vs en attente
javascript

const open = quests.filter(q => q.progress < q.target && !q.takenBy);
const actives = open.slice(0, 3);      // les 3 slots "actifs" du jeu
const enAttente = open.slice(3);       // slots "en attente" (farmables seulement si un slot se libère)

⚠️ Les quêtes "en attente" ne sont PAS farmables — elles ne peuvent être complétées que si le slot actif correspondant se libère. Le bot ignore enAttente pour éviter de viser une map qui ne fera rien avancer.
Auto-farm quêtes — routine
text

MAX_ITER = 20 itérations
Chaque itération :
  1. Lire les quêtes
  2. Filtrer les 3 actives
  3. Ignorer les quêtes sur endless (quêtes campaign uniquement)
  4. Si sur endless → retour forcé à ion_citadel d'abord
  5. Calculer distance de chaque cible (index maps)
  6. Trier par distance croissante
  7. Voyager vers la cible
  8. Attendre progression (max 60s, tick 3s) :
     - Si progression → log 📈
     - Si terminée → break
     - Si disparue → break (finie par un autre)
  9. Si timeout 60s sans progression → log ⚠️ et itération suivante

Voyage — voyagerVersMap
javascript

while (currentMap !== targetMapId && guard < 30) {
  const resolved = trouverPortailVersCible(currentMap, targetMapId);
  const result = await allerAuPortail({ targetMapId });
  if (!result.ok) return false;
  currentMap = result.newMapId;
  guard++;
}

Boucle jusqu'à atteindre la cible. Chaque appel = un seul portail.
Ignorer les endless

Les quêtes sont uniquement sur les maps campaign. Le bot :

    Ignore les quêtes avec mapId.startsWith('endless_')

    Si le joueur est déjà sur un endless, retour forcé à ion_citadel d'abord (sinon la routine partirait d'une map non-campaign)

Le kiting fait le farm

Le bot ne clique pas sur les mobs. Il surveille la progression. C'est le kiting (ou le joueur) qui tue les mobs. Sans kiting actif, l'auto-farm ferait ⚠️ Aucune progression en 60s en boucle.
Auto-farm quête — exemple de run complet (v19.5)
text

23:56:15 Démarrage auto-farm quêtes
23:56:15 ⚠️ Sur endless_15, retour forcé à ion_citadel
23:56:15 → 23:56:41 : 15 portails endless + 1 ion_citadel = 26s
23:56:41 ✅ Revenu sur ion_citadel
23:56:41 🎯 Cible: Fen Needle sur moonfen (0/55) — distance 6 maps
23:56:41 → 23:56:51 : 6 portails campaign = 10s
23:56:53 ⚔️ Sur place, attente progression quête

10. Debug et diagnostic
Boutons disponibles (UI)
Onglet	Bouton	Action
KITING	📋 Copier diag kiting	Kiting actif, position, chasseurs, orbite, état
QUEST → TEST PORTAILS	← Portail -1 / Portail +1 →	Test manuel d'un portail
QUEST → TEST PORTAILS	📋 Copier diag portail	Dernier diag portail complet
QUEST → TEST PORTAILS	🔍 Debug portails	Log du JSON __wildpote_getPortals__()
QUEST → AUTO-FARM	📋 Copier logs auto-farm	50 derniers logs de la routine
QUEST	🔄 REFRESH QUÊTES	refreshDailyQuests()
Logs [WildPote] en console

Format : [WildPote] 🗺️ MAP CHANGE: endless_45 → endless_44 pos=(...) [DOM="..."] @ 23:56:17

    Moniteur MAP CHANGE (100ms) : logge chaque changement de mapId avec la position serveur et le DOM.

    🧭 getPortalTarget : source du portail (endless / campaign-gateways / map-editor-override / fallback / null).

    🎯 Portail direct trouvé / Pas de match direct : résolution.

    🔎 waitPortail (1 sur 5 ticks) : position serveur à chaque 1s d'attente.

Diag portail — types d'événements
Event	Signification
target	Cible initiale (useX, useY, source)
tick	Position minimap toutes les 5 ticks
arrived	dist < 40 atteint
push-directional	ArrowUp/ArrowDown envoyé
map-changed-during-walk	Transition détectée pendant la marche
transition-during-walk	Transition validée pendant la marche
transition-dom	Transition via DOM #minimapMapName
transition-localstate	Transition via localState.mapId
timeout	Marche timeout (25s)
walk-failed	Impossible d'atteindre
timeout-transition	Attente transition timeout (10s)
success	Transition réussie après attente
timeout-during-walk	Jamais déclenché
Erreurs courantes
Message	Cause	Solution
Chasseurs: 0	Hook pas installé, ou pas en combat	Vérifier hook, aller en combat
État: safe permanent	Aucun mob à moins de KITE_ROOM	Attendre
Permission denied to access object	Xray bloque	Utiliser JSON (déjà fait)
Hook installé: ❌	pageWindow.eval échoue	Vérifier CSP, @grant unsafeWindow
Aucune progression en 60s	Kiting inactif sur la map cible	Activer le kiting, ou jouer manuellement
Aucun portail vers X	getAllRealPortals échoue ET fallbackPortal retourne null	Vérifier MAPS_ORDRE
Touches ignorées (joueur immobile)	Canvas aria-hidden, pas de focus	Fix getCanvas() (v19.4)
Fenêtre auto-farm à chaque portail	Space envoyé par simulerAppuiTouches	Fix v19.5 (pushDirectionnel uniquement)
11. Historique des décisions
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
V18.x	Portails : allerAuPortail retourne {ok, newMapId} + voyagerVersMap utilise le retour	✅ Plus de stale
V19.0	Bonus destination + hardcode CAMPAIGN_GATEWAYS	⚠️ CAMPAIGN_GATEWAYS pas exposé, 0.32 loupe
V19.1	Retour PORTAL_USE_RATIO = 0.5 (validé v18.8)	✅ Retour à la config qui marchait
V19.2	Fix multi-traversée (marcherVersDiag détecte mapId change)	✅ 1 seule transition par appel
V19.3	Fix marcherVersDiag utilise localState	❌ RÉGRESSION — localState stale
V19.4	Retour getPositionInterpolee (minimap) + focus canvas	✅ Position à jour + touches reçues
V19.5	pushDirectionnel (ArrowUp/Down 150ms) remplace les 7 touches d'interaction	✅ Collision déclenchée, plus de fenêtre UI
Décisions notables v18-v19.5

PORTAL_USE_RATIO = 0.5 (v19.1) — Le 0.32 officiel (y - height * 0.32) donne y - 63.36. Le bot, arrêté à dist < 40, finit à y - 63.36 + 40 = y - 23. Trop proche du pied, la collision ne prend pas toujours. Avec 0.5 (milieu de hitbox), le bot vise y - 99 + 45 = y - 54, plus safe. Combiné au push de 150ms en v19.5, ça marche à tous les coups.

Fallback MAPS_ORDRE plutôt que hardcode CAMPAIGN_GATEWAYS (v19.5) — CAMPAIGN_GATEWAYS n'est pas exposé sur window (module ES non pollué). Le hardcode aurait dupliqué une info qui change à chaque update du jeu. Le fallback (2400 ± 110, 2400) est exactement ce que le serveur utilise (via middleGateways), donc pas de risque de désync.

Ignorer les quêtes endless (v19.5) — Les quêtes sont campaign uniquement (règle du jeu). Si le bot acceptait les cibles endless, il ferait des allers-retours sans fin.

Retour forcé ion_citadel si départ sur endless (v19.5) — Si l'utilisateur lance l'auto-farm depuis un endless, la routine doit d'abord descendre jusqu'à ion_citadel (15 portails max) avant de pouvoir rejoindre une campaign map. Sans ça, voyagerVersMap partirait d'un index > 15 et ferait n'importe quoi.

pushDirectionnel 150ms plutôt que 100ms (v19.5) — En dessous de 100ms, parfois la frame d'input n'est pas captée par le client. Au-dessus de 200ms, le joueur dépasse la zone. 150ms = 44px de parcours à vitesse 295 = juste assez pour passer du bord au centre.
12. Pistes futures
Court terme

    Auto-quest plus intelligente : regrouper les 3 quêtes par proximité (éviter les allers-retours), changer de cible si 3 itérations sans progression sur la même map.

    Téléport town : quand ion_citadel est atteint, faire un changeMap("town", ...) puis voyager directement vers la map cible plutôt que de traverser les 6 campaign portails.

    Nettoyage : retirer les logs console.log de debug (garder pushLog UI).

Moyen terme

    Auto-prestige déclenché par condition réelle : actuellement declencherPrestige() est appelé toutes les 2s si autoPrestigeActif, ce qui peut surcharger. Ajouter un check prestigeAvailable() côté API.

    Auto-research : lancer les recherches utiles (Move Speed, Critical Damage) dans l'ordre.

    Auto-gems : réclamer le bonus daily à minuit UTC + les ads si activé.

Long terme

    Mode campaign / reflect / aggro / soul dans FARM : configurer les switches de l'autofarm ingame via l'UI.

    Kiting avancé : mode planEvasion complet (esquive + orbite), pas juste orbite.

    Chrome : trouver une solution (extension dédiée, ou attendre une API).

    Hooks canvas AoE : intercepter CanvasRenderingContext2D.prototype.arc pour lire les zones d'attaque des boss.

Recherche — mécaniques à explorer

    travelFromHome — le bouton "Retour" de town n'est pas exposé, mais il existe un picker de voyage natif au portail de town (4780, 3635). Pourrait être automatisé via le DOM.

    localState stale — comprendre pourquoi le serveur met 1-2s à update. Peut-être un réglage côté client (syncMovementState interval).

    Serveur change_map cooldown — est-ce qu'il y a un cooldown entre deux change_map ? (non observé, mais à vérifier).

    Position (2215, 2555) après arrived sur endless — le joueur est téléporté à cette position. Est-ce un anti-blocage, un respawn, ou une conséquence de la collision ratée ? À creuser.

Annexe — Sources du jeu utilisées

Les mécaniques serveur ont été vérifiées dans le code source du jeu (shared/map-gateways.ts, spacetimedb/src/map-travel.ts) :
typescript

// shared/map-gateways.ts
const PORTAL_SIZE = 198;
export function portalUsePoint(portal) {
  return { x: portal.x, y: portal.y - portal.height * .32, destination: portal.destination };
}
export const GATEWAY_PORTAL_SPACING = 220;
export const GATEWAY_ARRIVAL_DROP = 90;
export const MAP_MIDDLE = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };

// spacetimedb/src/map-travel.ts
export const MAP_PORTAL_USE_RANGE = 125;
if (portalDistance > MAP_PORTAL_USE_RANGE) throw new SenderError("Move closer to the portal.");

typescript

// shared/procedural-maps.ts
export function generateMap(id: ProceduralMapId): GeneratedMap {
  // ...
  portals: [
    { x: PORTAL_CENTER.x - 110, y: PORTAL_CENTER.y, width: 198, height: 198,
      depth: PORTAL_CENTER.y, destination: number === 1 ? PROCEDURAL_ENTRY_MAP : proceduralMapId(number - 1) },
    ...(number < Number.MAX_SAFE_INTEGER ? [{ x: PORTAL_CENTER.x + 110, y: PORTAL_CENTER.y, ...,
      destination: proceduralMapId(number + 1) }] : []),
  ],
}

Ces valeurs sont hardcodées dans le bot (MAP_MIDDLE, GATEWAY_SPACING, PORTAL_HEIGHT, MAP_PORTAL_USE_RANGE) mais recalculées à chaque version du jeu — si le jeu change le spacing ou le usePoint, il faudra mettre à jour le bot.
