📄 WildPote — Documentation technique (v20.3)
markdown

WildPote — Documentation technique

Bot pour WildStat MMO (wildstatmmo.com), un ARPG idle joué dans le navigateur.
Le bot est injecté via Violentmonkey (userscript) et interagit avec l'API officielle du jeu.

Version actuelle : 20.3 — Kiting, Portails, Auto-quest (tracker), Prestige, Gems
Dernière mise à jour : v20.3

## Table des matières

1. Contexte du jeu
2. Architecture de l'API du jeu
3. Le problème du CSP et de l'isolation
4. Architecture du bot (v20.3)
5. Le hook Array cross-context
6. Le kiting
7. Voyage — mécaniques serveur
8. Navigation par portails in-world
9. Auto-farm quêtes v20.3 (tracker DOM)
10. Debug et diagnostic
11. Historique des décisions
12. Pistes futures

---

## 1. Contexte du jeu

### Stack

- **Frontend** : modules ES, bundles `coop-client.*.js` + `game.*.js`
- **Backend** : SpacetimeDB (maincloud.spacetimedb.com, database `wildwood-coop`)
- **Auth** : JWT SpacetimeDB stocké dans localStorage
- **Communication** : WebSocket binaire (BSATN), pas du JSON
- **Mobs** : 100% simulés côté client. Le serveur valide uniquement la "crédibilité" des kills.

### Maps connues

- `town` : hub principal, aucun portail vers les zones de jeu. Arrivée à (6120, 5110).
- `home_exterior` : alias historique qui redirige vers `town` côté serveur.
- Maps de campagne : `tutorial_forest` (1) → `ion_citadel` (15). Voir `MAPS_ORDRE` dans le bot.
- Maps Endless : `endless_1`, `endless_2`, … générées procéduralement côté client ET serveur (même seed).

### Mécaniques de déplacement

- **Portails in-world** : pour passer d'une zone de campagne à une autre, ou d'un endless à un autre.
- **Aucun portail ne relie town aux zones de jeu**.
- **Bouton menu "Home"** (jeu natif, pas le bot) : seul moyen de rentrer en town depuis une zone.
  Appelle `changeMap("town", player.x, player.y)`.

---

## 2. Architecture de l'API du jeu

### `window.wildstatCoop`

Objet global exposé après connexion SpacetimeDB. Figé (`Object.freeze`) et posé via `Object.defineProperty(window, 'wildstatCoop', { writable: false, configurable: false })`.

**Méthodes utiles** :

| Méthode | Signature | Usage |
|---|---|---|
| `isConnected()` | `() → boolean` | Vérifier la connexion |
| `localState()` | `() → {x, y, facing, speed, moving, mapId}` | Position serveur — **STALE de ~1-2s** ⚠️ |
| `localIdentity()` | `() → string` | Identité (hex) |
| `changeMap(mapId, x, y)` | `(string, number, number) → Promise<boolean>` | Valide la position côté serveur |
| `dailyQuests()` | `() → { quests, guildName, bonus, ... }` | Quêtes du jour (UI) |
| `prestige()` / `prestigeAccount()` | | Prestige |
| `claimDailyGemBonus()` | | Gemmes |
| `refreshDailyQuests()` | | Refresh quêtes |
| `useTownDoor(index)` | `(number) → Promise` | Portes de town |

⚠️ **Ne jamais utiliser les `setOn*`** (`setOnItemDrop`, etc.) : réservés au jeu, une seule revendication.

### Structure d'un mob (`EnemyState`)

38 clés, capturées via le hook Array. Utilisées par le bot : `x`, `y`, `r`, `hp`, `maxHp`, `dead`, `engaged`, `leashing`, `aggroTargetId`, `type`, `campName`, `generatedBoss`, `reward.type` (via `ENEMY_TYPES[type]`).

### Serveur `change_map` — validation exacte

Source : `spacetimedb/src/map-travel.ts`.

```typescript
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
Deux types de portails serveur

    Campaign maps (tutorial_forest … ion_citadel) : sourcePortals = MAP_PORTALS[current.mapId] → vient de CAMPAIGN_GATEWAYS (hardcodé dans shared/map-gateways.ts, pas exposé sur window).

    Layout par défaut : middleGateways(gatewayPoint(mapId), previous, next) :

        gatewayPoint(mapId) = GATEWAY_POINT_NUDGES[mapId] ?? MAP_MIDDLE (2400, 2400)

        GATEWAY_POINT_NUDGES['tutorial_forest'] = { x: 2240, y: 2810 }

        GATEWAY_POINT_NUDGES['intermediate_snowlands'] = { x: 2300, y: 2190 }

        half = GATEWAY_PORTAL_SPACING / 2 = 110 si previous && next, sinon 0

        Portail à (point.x ± half, point.y)

        Tutorial Forest n'a pas de portail prev → half = 0, son unique portail next est à (2240, 2810) pile

        Les maps tutorial_forest et beginner_desert ont des overrides map editor (MAP_EDITOR_GAMEPLAY_OVERRIDES) qui priment sur middleGateways

    Endless maps (endless_N) : sourcePortals = generateMap(current.mapId).portals → généré dynamiquement, les portails sont à (2400 ± 110, 2400) avec useY = 2400 - 63.36, destination endless_(N-1) / endless_(N+1).

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

4. Architecture du bot (v20.3)
Structure
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

Onglets de l'UI (v20.3)
Onglet	Contenu
FARM	Auto-prestige (toggle, bouton, timer, niveau)
QUEST	Résumé (Terminées/Actives/Guild/Bonus), Quêtes actives (cartes colorées par stat), Terminées (collapsible), Auto-farm quêtes v20.3 (bouton Lancer/Arrêter dynamique, logs copiables)
KITING	Toggle, diag kiting
MISC	État (map, position serveur/minimap, source), logs

⚠️ v20.3 : suppression du bouton HOME (relique), suppression TEST PORTAILS et TEST TRACKER (remplacés par wildpoteDebug en console).
Persistance (localStorage)
Clé	Valeur	Défaut
wildpote_kiting	'true' / 'false'	false
wildpote_antistuck	'true' / 'false'	true
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

(inchangé, mais voir §5.3 pour la précision portails)
Trois hooks distincts

    Hook Array (Array.prototype.forEach/some/map/filter) → détecte les tableaux de mobs, calcule les 5 chasseurs les plus proches, écrit __wildpote_chasers_json__.

    Throttle 50ms.

    Hook Canvas minimap (CanvasRenderingContext2D.prototype.fill) → détecte le diamant blanc (joueur sur la minimap) et écrit __wildpote_minimap_json__.

    ⚠️ Position minimap = CLIENT, à jour. C'est la seule source fiable pour marcherVersDiag. localState() (serveur) a un lag de 1-2s.

    Hook __wildpote_getPortals__() → retourne les portails de la map courante :

        Endless : {x: 2290|2510, y: 2400, useY: 2400 - 63.36, destination: 'endless_(N±1)'} (useY officiel 0.32)

        Campaign : lit MAP_EDITOR_GAMEPLAY_OVERRIDES puis CAMPAIGN_GATEWAYS (les deux ne sont pas exposés sur window en pratique → retourne portals: null → le bot fallback sur MAPS_ORDRE + fallbackPortal corrigé v20.0.1)

v20.0.1 — correction importante du fallback :

Le fallback fallbackPortal() du bot utilise maintenant GATEWAY_POINT_NUDGES (les mêmes nudges que shared/map-gateways.ts) ET PORTAL_USE_RATIO = 0.32 (au lieu de 0.5) ET half = 0 pour tutorial_forest (pas de prev). Résultat : le bot vise (2240, 2746.64) au lieu de (2510, 2301) sur Tutorial Forest → transition OK.
Pourquoi JSON et pas objet ?

Xray Vision (Firefox) bloque la lecture cross-context des objets créés dans la page. Les strings JSON passent.
Canvas focus — découverte v19.4

Le canvas #gameGpu a aria-hidden="true" en permanence. Un élément aria-hidden ne peut pas recevoir le focus via canvas.focus(). Sans focus, les KeyboardEvent ne sont pas traités par les listeners du jeu.

Fix : retirer aria-hidden au premier getCanvas(), forcer canvas.focus() dans envoyerTouches().
6. Le kiting

(inchangé, voir v10.5)

Principe, formules orbitTrail/orbitRadii, sélection d'orbite, envoi des touches.

Complément v19.5 : la boucle tourne à 100ms. Pendant navigationEnCours === true, la boucle ne fait rien (le bot navigue).
7. Voyage — mécaniques serveur
Home (retour town)

changeMap("town", x, y) — fonctionne depuis n'importe où, aucune validation de portail.

⚠️ v20.3 : le bouton HOME du bot a été supprimé (relique). Utiliser le bouton HOME natif du jeu.
Voyage vers une map de campagne

Depuis town : changeMap(mapId, x, y) avec townPortalUsePoints(mapId) — tous les portails de town acceptent n'importe quelle destination débloquée.

Depuis une map de campagne : utiliser un portail in-world (voir §8).
Unlock validation serveur
typescript

const campaignIndex = CAMPAIGN_MAPS.findIndex(map => map.id === mapId);
if (campaignIndex > 0 && !campaignMapUnlocked(campaignIndex, currentProgress ?? {})) {
  throw new SenderError(`Defeat ${CAMPAIGN_MAPS[campaignIndex - 1].bossName} before entering ${MAP_DISPLAY_NAMES[mapId]}.`);
}

Impossible d'entrer dans une map de campagne sans avoir battu le boss de la précédente.
8. Navigation par portails in-world
Le problème initial

Le bot marchait vers le portail, s'arrêtait "arrivé", mais rien ne se passait.
Comprendre le client WildStat

Le client de jeu ne déclenche pas change_map via une touche. Quand le joueur entre dans la zone d'un portail, le client détecte la collision et appelle change_map automatiquement. La collision doit être réelle (position du joueur dans le rayon de 125px du portalUsePoint).
Trois bugs en cascade (résolus v19.x)

    localState stale → utiliser getPositionInterpolee() (minimap client) pour la marche.

    Canvas aria-hidden = pas de focus = touches ignorées → retirer aria-hidden dans getCanvas().

    Bot s'arrête "arrivé" mais hors zone → pushDirectionnel court (150ms) après arrived.

Solution finale (v19.5 + v20.0.1)
text

1. marcherVersDiag : position via minimap CLIENT (getPositionInterpolee)
2. Fin de marche : dist < 40 de la cible overshootée (y + 45)
3. Après arrived : push ArrowUp/ArrowDown 150ms
4. Attendre change_map (le client appelle automatiquement)
5. Détecter la transition via localState.mapId (polling 200ms, timeout 10s)

⚠️ v20.0.1 — Fix fallback (Tutorial Forest)

Avant v20.0.1 : fallbackPortal('tutorial_forest', 'next') retournait (2510, 2301) (basé sur MAP_MIDDLE + half=110, useY = y - 0.5*198). Résultat : 570px à côté du vrai portail → transition échouée.

Après v20.0.1 : fallbackPortal reproduit middleGateways() :

    GATEWAY_POINT_NUDGES['tutorial_forest'] = { x: 2240, y: 2810 }

    half = 0 (pas de prev)

    PORTAL_USE_RATIO = 0.32 (au lieu de 0.5)

    Résultat : (2240, 2746.64) + overshoot 45 = (2240, 2791.64) → ~18px du vrai portail → transition OK.

trouverPortailVersCible — le routage
javascript

1. getAllRealPortals(mapActuelle) → essayer via hook
   - Si un portail a destination === mapCible → match direct
   - Sinon → fallback MAPS_ORDRE
2. Si getAllRealPortals échoue (campaign, hook retourne null) →
   fallback MAPS_ORDRE + fallbackPortal v20.0.1

Constantes clés
Constante	Valeur	Rôle
MAP_PORTAL_USE_RANGE	125	Rayon serveur
PORTAL_USE_RATIO	0.32 (v20.0.1)	portalUsePoint officiel
PORTAL_HEIGHT	198	Repris du code source
PORTAL_OVERSHOOT_PX	45	Push vertical après arrived
PUSH_DURATION_MS	150	Durée du push
ARRIVAL_THRESHOLD_PX	40	Tolérance d'arrivée
GATEWAY_SPACING	220	Repris du code source
MAP_MIDDLE	{x: 2400, y: 2400}	Repris du code source
GATEWAY_POINT_NUDGES	{tutorial_forest: {2240, 2810}, intermediate_snowlands: {2300, 2190}}	v20.0.1
9. Auto-farm quêtes v20.3 (tracker DOM)

⚠️ Refonte complète en v20.0 : la routine n'utilise plus coop.dailyQuests(), mais le tracker DOM du jeu (.quest-tracker-item).
Pourquoi le tracker DOM ?

coop.dailyQuests() retourne DailyQuest sans le stat (reward type). Or le panneau Auto Farm utilise des data-group="stat:X". Il faut mapper enemy → stat pour activer le bon camp.

Le tracker DOM expose déjà stat via :

    .quest-tracker-stat → couleur (REWARD_DATA[stat].color de src/game/enemies.ts)

    .quest-tracker-stat → label (rewardStatLabel : "Damage", "Max Health", "Attack Speed", "Armor", "HP/sec", "Crit Damage")

Table couleur → stat (fixée) :
javascript

const REWARD_COLOR_TO_STAT = {
  'rgb(255, 101, 90)':  'damage',   // #ff655a
  'rgb(102, 237, 121)': 'health',   // #66ed79
  'rgb(255, 224, 93)':  'speed',    // #ffe05d
  'rgb(116, 216, 255)': 'armor',    // #74d8ff
  'rgb(255, 124, 203)': 'regen',    // #ff7ccb
  'rgb(255, 154, 77)':  'crit',     // #ff9a4d
};

Lecture du tracker
javascript

function lireQuetesDepuisTracker() {
  const items = document.querySelectorAll('.quest-tracker .quest-tracker-item');
  // Pour chaque item :
  //   - enemy : .quest-tracker-enemy
  //   - count : .quest-tracker-count → "X/Y"
  //   - stat : statDepuisTracker() → couleur prioritaire, label fallback
  //   - mapName : .quest-tracker-where → "Moonfen" ou ""
  //   - onMap : class 'is-here'
  // Retourne { enemy, stat, progress, target, mapName, onMap, groupe: `stat:${stat}` }
}

Activation Aggro

Le panneau Auto Farm a des groupes [data-group="stat:X"] et des boutons [data-mode="off|farm|aggro"].

⚠️ Problème v20.0 : le panneau #autoFarmSheet est dans le DOM mais son contenu #autoFarmContent est hidden tant que l'utilisateur n'a pas ouvert le panneau. Les [data-group] ne sont pas rendus (via renderChoices()) tant que content.hidden = true.

Fix v20.0.1 : activerAggroSurGroupe ouvre le panneau via .farm-toggle si content.hidden, attend 400ms (le refresh() à 250ms appelle renderChoices()), puis interagit.
Routine complète (v20.3)
text

MAX_ITER = 20 itérations
Chaque itération :
  1. lireQuetesDepuisTracker() → 3 quêtes
  2. Filtrer : progress < target ET groupe défini (stat connue)
  3. Trier : onMap d'abord
  4. Prendre la première cible
  5. Si !onMap && mapName → voyagerVersMap(targetMapId)
  6. activerAggroSurGroupe(cible.groupe)
  7. Attendre progression (max 60s, tick 3s) :
     - 📈 X/Y à chaque progression
     - ✅ terminée → break
     - ✅ disparue → break
     - ⚠️ 60s sans progrès → itération suivante
  8. Itération suivante (relecture tracker)

⚠️ Le tracker DOM lit déjà la progression en temps réel (poll serveur via coop.dailyQuests() + optimistic counting local). Pas besoin d'attendre le serveur.
UI temps réel

L'onglet QUEST utilise deux sources :

    Actives : mettreAJourQuestsDepuisTracker() (1s) → lit le tracker DOM

    Terminées/Guild/Bonus : mettreAJourQuests() (1s) → lit __wildpote_quests_json__

Les cartes actives sont colorées par stat (via REWARD_COLOR_TO_STAT_REVERSE) : damage=rouge, health=vert, speed=jaune, armor=cyan, regen=rose, crit=orange.
10. Debug et diagnostic
Console F12 (wildpoteDebug)

⚠️ v20.3 : les boutons TEST PORTAILS et TEST TRACKER ont été supprimés de l'UI et remplacés par window.wildpoteDebug :
Méthode	Action
wildpoteDebug.dumpTracker()	Console.table des quêtes du tracker
wildpoteDebug.dumpPanel()	Console.table des [data-group] du panneau Auto Farm
wildpoteDebug.getPortals(mapId?)	JSON brut de __wildpote_getPortals__
wildpoteDebug.diagPortail()	Texte du dernier diag portail
wildpoteDebug.version	"20.3"
Logs [WildPote] en console

Format : [WildPote] 🗺️ MAP CHANGE: endless_45 → endless_44 pos=(...) [DOM="..."] @ 23:56:17

    Moniteur MAP CHANGE (100ms) : logge chaque changement de mapId

    🧭 getPortalTarget : source du portail (endless / campaign-gateways / map-editor-override / fallback / null)

    🎯 Portail direct trouvé / Pas de match direct : résolution

    🔎 waitPortail (1 sur 5 ticks) : position serveur à chaque 1s d'attente

    🤖 Auto-farm quêtes : logs de la routine (logAutoFarm)

Diag portail — types d'événements

(inchangé, voir v19.5)
Erreurs courantes
Message	Cause	Solution
Chasseurs: 0	Hook pas installé, ou pas en combat	Vérifier hook, aller en combat
Permission denied to access object	Xray bloque	Utiliser JSON (déjà fait)
Hook installé: ❌	pageWindow.eval échoue	Vérifier CSP, @grant unsafeWindow
Aucune progression en 60s	Kiting inactif, ou mauvais groupe	Vérifier que le bon camp est Aggro
Aucun groupe dans le panneau	Contenu non rendu (jamais ouvert)	v20.0.1 ouvre le panneau automatiquement
Groupe "stat:X" introuvable	Le groupe n'existe pas sur cette map	Vérifier dispo via wildpoteDebug.dumpPanel()
❌ Portail échoué (Tutorial Forest)	Fallback wrong (v20.0)	v20.0.1 corrige avec GATEWAY_POINT_NUDGES
11. Historique des décisions
Version	Décision	Raison
V1	Interception WebSocket	❌ CSP + timing
V2-V7	Injection externe, GM_addElement, eval	❌ CSP
V8	@sandbox JavaScript + unsafeWindow.wrappedJSObject	✅ Firefox uniquement
V10.0-10.4	Hook Array via eval + JSON cross-context	✅
V10.5	Throttle 50ms	✅ Firefox ne plante plus
V18.x	Portails : {ok, newMapId}	✅ Plus de stale
V19.0	Hardcode CAMPAIGN_GATEWAYS	⚠️ Pas exposé
V19.1	PORTAL_USE_RATIO = 0.5	✅
V19.2	Fix multi-traversée	✅
V19.3	Fix localState	❌ Régression
V19.4	Retour getPositionInterpolee + focus canvas	✅
V19.5	pushDirectionnel remplace les 7 touches	✅
V20.0	Refonte auto-farm quêtes : tracker DOM	✅ item.stat fourni, plus de table ENEMY_REWARD_TYPES
V20.0.1	Fix fallbackPortal (nudges + ratio 0.32 + half=0)	✅ Tutorial Forest OK
V20.0.1	Fix activerAggroSurGroupe (ouverture panneau)	✅ Groupes visibles
V20.2	Nettoyage : 7 fonctions orphelines supprimées	✅ Code plus propre
V20.3	Suppression bouton HOME + TEST PORTAILS/TRACKER	✅ UI plus simple, debug en console
V20.3	Quêtes actives colorées par stat	✅ Feedback visuel immédiat
V20.3	Fix collapse section (append + appendChild)	✅ RÉSUMÉ collapse OK
12. Pistes futures
Court terme

    Nettoyage getAllRealPortals / getRealPortal : tester sur plusieurs maps si __wildpote_getPortals__ retourne vraiment des données. Si toujours null, supprimer.

    voyagerViaMoveOn en fallback : utiliser le bouton Move On natif du jeu quand marcherVersDiag échoue (activé via Move At = 0.1x temporaire).

    Retry portails : si allerAuPortail échoue, retry une fois avant d'abandonner.

Moyen terme

    Auto-prestige condition réelle : declencherPrestige() est appelé toutes les 2s si autoPrestigeActif, ce qui peut surcharger. Ajouter un check prestigeAvailable() côté API.

    Auto-research : lancer les recherches utiles dans l'ordre.

    Auto-gems : réclamer le bonus daily à minuit UTC + les ads.

Long terme

    Mode campaign / reflect / aggro / soul dans FARM : configurer les switches de l'autofarm ingame via l'UI.

    Kiting avancé : mode planEvasion complet.

    Chrome : trouver une solution (extension dédiée).

Recherche — mécaniques à explorer

    travelFromHome : le bouton "Retour" de town n'est pas exposé, mais il existe un picker de voyage natif au portail de town (4780, 3635).

    localState stale : comprendre pourquoi 1-2s de lag.

    Serveur change_map cooldown : à vérifier.

Annexe — Sources du jeu utilisées
typescript

// shared/map-gateways.ts
const PORTAL_SIZE = 198;
export function portalUsePoint(portal) {
  return { x: portal.x, y: portal.y - portal.height * .32, destination: portal.destination };
}
export const GATEWAY_PORTAL_SPACING = 220;
export const GATEWAY_ARRIVAL_DROP = 90;
export const MAP_MIDDLE = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
export const GATEWAY_POINT_NUDGES = {
  [TUTORIAL_FOREST_MAP_ID]: { x: 2240, y: 2810 },
  intermediate_snowlands: { x: 2300, y: 2190 },
};

// spacetimedb/src/map-travel.ts
export const MAP_PORTAL_USE_RANGE = 125;

// src/game/enemies.ts
export const REWARD_DATA: Record<RewardType, { color: string }> = {
  damage: { color: "#ff655a" }, health: { color: "#66ed79" },
  speed: { color: "#ffe05d" }, armor: { color: "#74d8ff" },
  regen: { color: "#ff7ccb" }, crit: { color: "#ff9a4d" },
};
export function rewardStatLabel(reward) {
  if (reward.type === "damage") return "Damage";
  if (reward.type === "health") return "Max Health";
  if (reward.type === "speed") return "Attack Speed";
  if (reward.type === "crit") return "Crit Damage";
  if (reward.type === "armor") return "Armor";
  return "HP/sec";
}

// src/ui/quest-board-controller.ts (item.stat du QuestTrackerView)
const stat: RewardType | null = ENEMY_TYPES[quest.enemy as EnemyKind]?.reward.type ?? null;

Ces valeurs sont hardcodées dans le bot mais recalculées à chaque version du jeu. Si le jeu change le spacing ou le usePoint, il faudra mettre à jour.
text


---

## 🎯 Ce qui a changé en résumé

| Section | Avant (v19.5) | Après (v20.3) |
|---|---|---|
| §4 UI | TEST PORTAILS + toggle auto-farm | Supprimés, bouton dynamique Lancer/Arrêter |
| §4 Footer | Bouton HOME | Supprimé |
| §5 Portails | `PORTAL_USE_RATIO = 0.5` | **0.32 + nudges** |
| §8 Navigation | Fallback générique | **`GATEWAY_POINT_NUDGES`** (Tutorial Forest OK) |
| §9 Auto-quest | `coop.dailyQuests()` + `takesBy` | **Tracker DOM** (`item.stat` + couleur) |
| §10 Debug | Boutons UI | **`wildpoteDebug.*` console** |
| §11 Historique | V19.5 | + v20.0 / v20.0.1 / v20.2 / v20.3 |

## 📌 Points optionnels à décider

1. **Section §2** : j'ai retiré `home_exterior` de "Maps connues" ? Non, je l'ai laissé. Tu veux le retirer ?
2. **Section §3 CSP** : toujours d'actualité ? Tu es toujours sur Firefox + Violentmonkey ?
3. **Section §12 Pistes** : j'ai retiré les items v19.5 déjà faits (auto-quest plus intelligente = fait, téléport town = à faire, nettoyage logs = fait). Tu veux ajouter d'autres pistes ?

Si tout te va, tu peux coller ce document à la place de l'ancien. Sinon dis-moi ce qu'il faut ajuster. 🚀

