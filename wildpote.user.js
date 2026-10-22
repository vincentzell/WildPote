// ==UserScript==
// @name         WildPote - n++
// @namespace    Violentmonkey
// @version      20.7.0
// @description  Bot WildStat 100% API (Kiting, Quests + guild pool, Target/All Cards farming + multi-aggro + boss parallèle, Prestige, Gems, Ads)
// @author       Vincent
// @match        https://www.wildstatmmo.com/*
// @match        https://wildstatmmo.com/*
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow)
    ? (unsafeWindow.wrappedJSObject || unsafeWindow)
    : window;

  const getCoop = () => pageWindow.wildstatCoop || pageWindow.wildwoodCoop || null;
  const log = (...args) => console.log('[WildPote]', ...args);

  const VERSION = '20.7.0';

  console.log(`[WildPote] Démarrage v${VERSION}`);

  // ═════════════════════════════════════════════════════════════════
  //  1. CONSTANTES
  // ═════════════════════════════════════════════════════════════════
  const KITE_GAP = 60;
  const KITE_ROOM = 160;
  const ENEMY_CHASE_TURN_RATE = 6;
  const ORBIT_CLEARANCE = 6;
  const ORBIT_CROWDING = 0.55;
  const ORBIT_BAND_SHARE = 0.7;
  const WIDE_LOOPS = [220, 170, 130];
  const MIN_LOOP = 40;
  const NOT_HOLDING = 150;
  const ENTRY_COST = 15;
  const ORBIT_LEAD = 0.15;
  const CHASE_SPEED_BONUS = 25;
  const PLAYER_RADIUS = 20;
  const ARRIVAL_THRESHOLD_PX = 40;
  const PORTAL_OVERSHOOT_PX = 45;
  const PORTAL_HEIGHT = 198;
  const PORTAL_USE_RATIO = 0.32;
  const PUSH_DURATION_MS = 150;
  const PRESTIGE_FIRST_MAP = 15;
  const CAMPAIGN_LENGTH = 15;
  const KEYCODES = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };

  const AD_CHECK_INTERVAL_MS = 30_000;

  const GATEWAY_POINT_NUDGES = {
    'tutorial_forest': { x: 2240, y: 2810 },
    'intermediate_snowlands': { x: 2300, y: 2190 },
  };

    // ── Card pity (shared/cards.ts + spacetimedb/src/card-drops.ts) ──
  // outcomes = kills par chance ; meter garanti à outcomes × CARD_METER_MULTIPLE.
  // Le meter avance de `1 + cardHunter` par kill (cardLuck n'affecte PAS le meter).
  const CARD_DROP_OUTCOMES = Object.freeze({ regular: 1000, elite: 2000, boss: 100 });
  const CARD_METER_MULTIPLE = 2;
  const BOSS_CONTACT_RADIUS = 250;
  const BOSS_FAR_RADIUS = 600;
  const BOSS_PROGRESS_MIN_PX = 100;
  const BOSS_MAX_STAGNATION = 3;
  const MINIMAP_FROZEN_MS = 2000;
  const MINIMAP_FROZEN_ABANDON_MS = 30000;

  // ═════════════════════════════════════════════════════════════════
  //  2. ÉTAT GLOBAL
  // ═════════════════════════════════════════════════════════════════
  let kitingActif = localStorage.getItem('wildpote_kiting') === 'true';
  let orbitActuelle = null;
  let touchesActives = new Set();
  let dernierePos = null;
  let dernierBlocageTs = 0;
  let antiStuckActif = localStorage.getItem('wildpote_antistuck') !== 'false';
  let dernierInputJoueur = 0;
  let ongletActif = localStorage.getItem('wildpote_tab') || 'kiting';
  let navigationEnCours = false;
  /** Set by any routine's STOP (card target, mining, woodcutting). Cleared at each routine's start.
      marcherVersDiag and voyagerVersMap read THIS, not cardTargetAbort, so stopping one routine
      doesn't block navigation in another (e.g. Auto WC after Target Cards was stopped). */
  let navAbort = false;
  let autoPrestigeActif = localStorage.getItem('wildpote_autoprestige') !== 'false';
  let prestigeEnCours = false;
  let dernierPrestigeTs = 0;
  let derniereErreurPrestige = null;
  let dernierPrestigePerf = parseInt(localStorage.getItem('wildpote_prestige_time') || '0', 10);
  let dernierPrestigeDuree = localStorage.getItem('wildpote_prestige_duree') || null;
  let prestigeEnAttente = false;
  let prestigeMapAttente = null;
  let autoLoginActif = localStorage.getItem('wildpote_autologin') !== 'false';
  let authConnexionEnCours = false;
  let dernierAuthTs = 0;
  let autoDailyGemsActif = localStorage.getItem('wildpote_autodailygems') === 'true';
  let gemClaimEnCours = false;
  let autoAdActif = localStorage.getItem('wildpote_autoad') === 'true';
  let _autoAdEnCours = false;
  let autoFarmQuestActif = localStorage.getItem('wildpote_autofarmquest') === 'true';
  let autoFarmQuestEnCours = false;
  let autoFarmQuestLogs = [];

  // ═════════════════════════════════════════════════════════════════
  //  2.5. POSITION MINIMAP + PRESTIGE GOAL + MAP NAME
  // ═════════════════════════════════════════════════════════════════
  // Town minimap frames (mirrors world-renderer.ts townMinimapFrame).
  // The minimap in Town is a fixed square per zone, NOT player-centered.
  // We inverse-project the white diamond for each candidate frame, then pick
  // the candidate most consistent with the last known position.
  let _lastTownPos = null;
  const TOWN_MINIMAP_FRAMES = [
    { tag: 'v', cx: 3120, cy: 2645, span: 5320 }, // village walk area (arrival by default)
    { tag: 'g', cx:  230, cy: 3605, span: 3190 }, // grove (Timberwood)
    { tag: 'h', cx: 8140, cy: 2515, span: 5580 }, // hills (Copper Hills)
  ];

  function getPositionInterpolee(coop) {
    if (!coop) return null;
    try {
      const json = pageWindow.__wildpote_minimap_json__;
      if (json && json !== 'null') {
        const d = JSON.parse(json);
        const sizeMatch = d.canvas && d.canvas.match(/^(\d+)×(\d+)$/);
        if (sizeMatch) {
          const size = parseInt(sizeMatch[1], 10);
          const mapId = getMapIdActuel();

          if (mapId === 'town') {
            const candidates = TOWN_MINIMAP_FRAMES.map(f => ({
              x: f.cx + (d.cx / size) * f.span,
              y: f.cy + (d.cy / size) * f.span,
              src: `minimap-town-${f.tag}`,
              ts: d.ts,
            }));
            // Pick the candidate closest to the last known position.
            // On first read (teleport just landed), default to village (arrival).
            let best = candidates[0];
            if (_lastTownPos) {
              let bestD = Infinity;
              for (const cand of candidates) {
                const dist = Math.hypot(cand.x - _lastTownPos.x, cand.y - _lastTownPos.y);
                if (dist < bestD) { bestD = dist; best = cand; }
              }
            }
            _lastTownPos = { x: best.x, y: best.y };
            return best;
          }
          _lastTownPos = null;

          // Campaign maps: world-anchored, 4800 square
          const WORLD_SIZE = 4800;
          return {
            x: (d.cx / size) * WORLD_SIZE,
            y: (d.cy / size) * WORLD_SIZE,
            src: 'minimap-diamond',
            ts: d.ts,
          };
        }
      }
    } catch (e) {}
    return null;
  }

  function minimapEstFigee(pos) {
    return !pos || !pos.ts || (Date.now() - pos.ts > MINIMAP_FROZEN_MS);
  }

    // ─────────────────────────────────────────────────────────────────
  //  PITY LOCAL — miroir de spacetimedb/src/card-drops.ts
  //  player_card_meter est `public: false` → illisible depuis le client.
  //  On tient un miroir localStorage. Exact tant que tous les kills mobs
  //  passent par le bot et que cardHunter ne change pas en cours de route.
  //  Les cartes BOSS retournent null (état boss non hookable).
  // ─────────────────────────────────────────────────────────────────
  const PITY_KEY = 'wildpote_card_pity';

  function _loadPity() {
    try { return JSON.parse(localStorage.getItem(PITY_KEY) || '{}'); } catch (e) { return {}; }
  }
  function _savePity(m) {
    try { localStorage.setItem(PITY_KEY, JSON.stringify(m)); } catch (e) {}
  }
  function getCardHunterBonus() {
    try {
      const s = getCoop()?.activeCardStats?.();
      return (s && typeof s.cardHunter === 'number') ? Math.max(0, s.cardHunter) : 0;
    } catch (e) { return 0; }
  }
  function bumpPity(cardId, killed = 1) {
    if (!CARD_DB[cardId]) return;
    const odds = 1 + getCardHunterBonus();
    const m = _loadPity();
    m[cardId] = (m[cardId] || 0) + killed * odds;
    _savePity(m);
  }
  function resetPity(cardId) {
    const m = _loadPity();
    if (m[cardId]) { m[cardId] = 0; _savePity(m); }
  }
      function pityPct(cardId) {
    const def = CARD_DB[cardId];
    if (!def) return null;
    if (def.tree) return null;  // Timberwood : pas de hook côté userscript
    const outcomes = CARD_DROP_OUTCOMES[def.rarity];
    if (!outcomes) return null;
    return Math.min(100, ((_loadPity()[cardId] || 0) / (outcomes * CARD_METER_MULTIPLE)) * 100);
  }
    // Résout le cardId à partir du `type` d'une entité runtime (nom exact de l'ennemi).
  function cardIdForEnemy(enemyName) {
    for (const [id, def] of Object.entries(CARD_DB)) {
      if (def.enemy === enemyName && def.rarity !== 'boss' && !def.tree) return id;
    }
    return null;
  }

  // Résout la carte boss pour une map donnée. Gère :
  //  - campagne : match direct par `map`
  //  - endless_N : renvoie la Warden de la bande (1-10, 11-20, …, 51+)
  function resolveBossCardId(mapId) {
    if (!mapId) return null;
    const endlessMatch = mapId.match(/^endless_(\d+)$/);
    if (endlessMatch) {
      const n = parseInt(endlessMatch[1], 10);
      if (n >= 1 && n <= 10) return 'warden_i_card';
      if (n >= 11 && n <= 20) return 'warden_ii_card';
      if (n >= 21 && n <= 30) return 'warden_iii_card';
      if (n >= 31 && n <= 40) return 'warden_iv_card';
      if (n >= 41 && n <= 50) return 'warden_v_card';
      if (n >= 51) return 'warden_vi_card';
      return null;
    }
    return Object.entries(CARD_DB)
      .find(([id, def]) => def.rarity === 'boss' && def.map === mapId && !def.tree)?.[0] || null;
  }

  // Bandes Endless de chaque Warden (début de la bande, inclusif)
  const WARDEN_BAND_START = Object.freeze({
    warden_i_card: 1, warden_ii_card: 11, warden_iii_card: 21,
    warden_iv_card: 31, warden_v_card: 41, warden_vi_card: 51,
  });

  /**
   * Résout la map cible réelle d'une carte pour la navigation.
   *  - Cartes campagne → def.map
   *  - Warden → map endless_N courante si le joueur est déjà dans la bonne bande,
   *             sinon la 1ʳᵉ map de la bande (voyagerVersMap fera le chemin)
   *  - Arbres Timberwood → null (non navigable par portails, farm manuel)
   */
  function resolveTargetMapId(cardId) {
    const def = CARD_DB[cardId];
    if (!def) return null;
    if (def.tree) return 'town';  // Timberwood is a region of the Town map
    if (def.map !== 'endless') return def.map;

    const bandStart = WARDEN_BAND_START[cardId];
    if (!bandStart) return null;

    const cur = getMapIdActuel();
    const m = cur && cur.match(/^endless_(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const bandEnd = cardId === 'warden_vi_card' ? Infinity : bandStart + 9;
      if (n >= bandStart && n <= bandEnd) return cur;
    }
    return `endless_${bandStart}`;
  }

  function getPrestigeGoal(level) {
    const nextLevel = (level ?? 0) + 1;
    const requiredMap = PRESTIGE_FIRST_MAP + Math.max(1, nextLevel) - 1;
    const endlessStage = Math.max(0, requiredMap - CAMPAIGN_LENGTH);
    if (endlessStage > 0) return `Clear Endless ${endlessStage} boss`;
    return 'Defeat Aegis Prime';
  }

  function mapNameToMapId(name) {
    if (!name) return null;
    const lower = name.toLowerCase().trim();
    const endlessMatch = lower.match(/endless\s*-\s*(\d+)/);
    if (endlessMatch) return `endless_${endlessMatch[1]}`;
    const MAP_NAME_TO_ID = {
      'tutorial forest': 'tutorial_forest',
      'desert': 'beginner_desert',
      'beginner desert': 'beginner_desert',
      'snowlands': 'intermediate_snowlands',
      'intermediate snowlands': 'intermediate_snowlands',
      'lava wastes': 'advanced_lava_wastes',
      'advanced lava lake': 'advanced_lava_wastes',
      'infernal depths': 'infernal_depths',
      'night forest': 'infernal_depths',
      'water reach': 'water_reach',
      'samurai garden': 'samurai_garden',
      'cloudspire': 'cloudspire',
      'moonfen': 'moonfen',
      'crystal hollows': 'crystal_hollows',
      'clockwork ruins': 'clockwork_ruins',
      'duskfall orchard': 'duskfall_orchard',
      'neon bastion': 'neon_bastion',
      'verdant catacombs': 'verdant_catacombs',
      'ion citadel': 'ion_citadel',
      'town': 'town',
    };
    for (const [key, id] of Object.entries(MAP_NAME_TO_ID)) {
      if (lower.includes(key)) return id;
    }
    return name;
  }

  function getMapIdActuel() {
    const c = getCoop();
    const domName = document.getElementById('minimapMapName')?.textContent?.trim();
    if (domName) {
      const id = mapNameToMapId(domName);
      if (id) return id;
    }
    return c?.localState?.()?.mapId || null;
  }

  // ═════════════════════════════════════════════════════════════════
  //  3. HOOK ARRAY + MINIMAP + PORTAILS
  // ═════════════════════════════════════════════════════════════════
  let hookActif = false;

  function installerHookArray() {
    if (hookActif) return;
    hookActif = true;

    const code = `
      (function() {
        if (window.__wildpote_hook_installed__) return;
                window.__wildpote_hook_installed__ = true;

        // ── Hook boss kills via localStorage (wildstat-enemy-defeats-v2) ──
        // Intercepte chaque write de la queue de loot côté jeu pour compter
        // les boss kills. Voir wildstat-enemy-defeats-v2:<identity>:<tabId>.
        // Isolé dans son try/catch : un échec ici n'empêche pas le hook Array.
        try {
          if (!window.__wp_loot_hook__) {
            window.__wp_loot_hook__ = true;
            const origSetItem = Storage.prototype.setItem;
            const seen = new Map();
                        Storage.prototype.setItem = function(key, value) {
              try {
                if (typeof key === 'string' && key.indexOf('wildstat-enemy-defeats-v2:') === 0 && typeof value === 'string') {
                  const state = JSON.parse(value);
                  if (state && typeof state.streamId === 'string' && Array.isArray(state.batches)) {
                    if (!window.__wildpote_kills_pending__) window.__wildpote_kills_pending__ = [];
                    for (let bi = 0; bi < state.batches.length; bi++) {
                      const batch = state.batches[bi];
                      if (!batch || !Array.isArray(batch.enemies)) continue;
                      const sig = state.streamId + ':' + batch.sequence;
                      const prev = seen.get(sig) || {};
                      const next = {};
                      for (let ei = 0; ei < batch.enemies.length; ei++) {
                        const e = batch.enemies[ei];
                        if (!e || typeof e.enemy !== 'string') continue;
                        const count = e.count || 0;
                        next[e.enemy] = count;
                        const prevCount = prev[e.enemy] || 0;
                        if (count > prevCount) {
                          window.__wildpote_kills_pending__.push({
                            mapId: batch.mapId, enemy: e.enemy, count: count - prevCount, ts: Date.now()
                          });
                        }
                      }
                      seen.set(sig, next);
                    }
                    if (seen.size > 500) {
                      const entries = Array.from(seen.entries()).slice(-200);
                      seen.clear();
                      for (let i = 0; i < entries.length; i++) seen.set(entries[i][0], entries[i][1]);
                    }
                  }
                }
              } catch (e) {}
              return origSetItem.call(this, key, value);
            };
            console.log('[WildPote] ✅ Hook boss kills installé');
          }
        } catch (e) { console.log('[WildPote] ❌ Hook boss échec:', e.message); }

        const origForEach = Array.prototype.forEach;
        const origSome = Array.prototype.some;
        const origMap = Array.prototype.map;
        const origFilter = Array.prototype.filter;
        let derniereCaptureTs = 0;

        function tryCapture(arr) {
          const now = performance.now();
          if (now - derniereCaptureTs < 50) return;
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
            for (let i = 0; i < arr.length; i++) {
              const e = arr[i];
              const dist = Math.hypot(e.x - player.x, e.y - player.y);
              if (e.dead) continue;
              if (!e.engaged || e.leashing) continue;
              if (identity && e.aggroTargetId !== identity) continue;
              if (dist < 600) chasers.push({ x: e.x, y: e.y, r: e.r || 20, dist });
            }
            chasers.sort((a, b) => a.dist - b.dist);
            if (chasers.length > 0) {
              window.__wildpote_chasers_json__ = JSON.stringify(chasers.slice(0, 5));
              window.__wildpote_last_nonempty_ts__ = Date.now();
            }
          } catch (err) {}
        }
        Array.prototype.forEach = function(...args) { if (this.length > 0 && this.length < 300) tryCapture(this); return origForEach.apply(this, args); };
        Array.prototype.some = function(...args) { if (this.length > 0 && this.length < 300) tryCapture(this); return origSome.apply(this, args); };
        Array.prototype.map = function(...args) { if (this.length > 0 && this.length < 300) tryCapture(this); return origMap.apply(this, args); };
        Array.prototype.filter = function(...args) { if (this.length > 0 && this.length < 300) tryCapture(this); return origFilter.apply(this, args); };

        const origMoveTo = CanvasRenderingContext2D.prototype.moveTo;
        const origLineTo = CanvasRenderingContext2D.prototype.lineTo;
        const origFill = CanvasRenderingContext2D.prototype.fill;
        const origBeginPath = CanvasRenderingContext2D.prototype.beginPath;
        let minimapPath = [];
        CanvasRenderingContext2D.prototype.beginPath = function() { try { minimapPath = []; } catch (e) {} return origBeginPath.call(this); };
        CanvasRenderingContext2D.prototype.moveTo = function(x, y) { try { if (Number.isFinite(x) && Number.isFinite(y)) minimapPath.push({ op: 'moveTo', x, y }); } catch (e) {} return origMoveTo.call(this, x, y); };
        CanvasRenderingContext2D.prototype.lineTo = function(x, y) { try { if (Number.isFinite(x) && Number.isFinite(y)) minimapPath.push({ op: 'lineTo', x, y }); } catch (e) {} return origLineTo.call(this, x, y); };
        CanvasRenderingContext2D.prototype.fill = function(...args) {
          try {
            if (minimapPath.length === 4) {
              const fillStyle = this.fillStyle;
              const isWhite = fillStyle === '#ffffff' || fillStyle === 'rgb(255, 255, 255)';
              if (isWhite) {
                const ops = minimapPath.map(p => p.op);
                if (ops[0] === 'moveTo' && ops.slice(1).every(o => o === 'lineTo')) {
                  const pts = minimapPath.map(p => ({ x: p.x, y: p.y }));
                  const cx = (pts[0].x + pts[2].x) / 2;
                  const cy = (pts[0].y + pts[2].y) / 2;
                  const d0 = Math.hypot(pts[0].x - cx, pts[0].y - cy);
                  const d1 = Math.hypot(pts[1].x - cx, pts[1].y - cy);
                  const d2 = Math.hypot(pts[2].x - cx, pts[2].y - cy);
                  const d3 = Math.hypot(pts[3].x - cx, pts[3].y - cy);
                  const avgDist = (d0 + d1 + d2 + d3) / 4;
                  const variance = (Math.abs(d0 - avgDist) + Math.abs(d1 - avgDist) + Math.abs(d2 - avgDist) + Math.abs(d3 - avgDist)) / 4;
                  if (avgDist >= 2 && avgDist <= 15 && variance <= 2) {
                    const canvas = this.canvas;
                    window.__wildpote_minimap_json__ = JSON.stringify({ cx, cy, r: avgDist, canvas: canvas ? (canvas.width + '×' + canvas.height) : '?', ts: Date.now() });
                  }
                }
              }
            }
          } catch (e) {}
          return origFill.apply(this, args);
        };

        window.__wildpote_getPortals__ = function() {
          try {
            const coop = window.wildstatCoop;
            if (!coop || !coop.isConnected()) return 'null';
            const state = coop.localState();
            if (!state) return 'null';
            const mapId = state.mapId;
            const useYFor = (p) => p.y - (p.height ?? 198) * 0.5;
            const endlessUseYFor = (p) => p.y - (p.height ?? 198) * 0.32;

            if (/^endless_\\d+$/.test(mapId)) {
              const baseY = 2400;
              const endlessNum = parseInt(mapId.replace('endless_', ''), 10);
              const destPrev = endlessNum > 1 ? 'endless_' + (endlessNum - 1) : 'ion_citadel';
              const destNext = 'endless_' + (endlessNum + 1);
              return JSON.stringify({ source: 'endless', mapId, portals: [
                { x: 2290, y: baseY, useY: endlessUseYFor({ y: baseY, height: 198 }), destination: destPrev },
                { x: 2510, y: baseY, useY: endlessUseYFor({ y: baseY, height: 198 }), destination: destNext },
              ] });
            }

            let portals = null, source = 'unknown', debug = {};
            try {
              const overrides = window.MAP_EDITOR_GAMEPLAY_OVERRIDES;
              if (overrides && overrides[mapId]?.portals?.length) {
                portals = overrides[mapId].portals.map(p => ({ x: p.x, y: p.y, useY: useYFor(p), destination: p.destination }));
                source = 'map-editor-override';
              }
            } catch (e) { debug.overrideErr = String(e); }
            if (!portals) {
              try {
                const gws = window.CAMPAIGN_GATEWAYS;
                if (gws && gws[mapId]?.portals?.length) {
                  portals = gws[mapId].portals.map(p => ({ x: p.x, y: p.y, useY: useYFor(p), destination: p.destination }));
                  source = 'campaign-gateways';
                }
              } catch (e) { debug.gwErr = String(e); }
            }
            return JSON.stringify({ source, mapId, portals, debug });
          } catch (e) { return JSON.stringify({ error: String(e) }); }
        };
      })();
    `;
    try { pageWindow.eval(code); log('✅ Hooks installés'); }
    catch (e) { log('❌ Échec hook:', e.message); }
  }

  function getRealPortal(mapId, direction) {
    try {
      const fn = pageWindow.__wildpote_getPortals__;
      if (typeof fn !== 'function') return null;
      const json = fn();
      if (!json || json === 'null') return null;
      const data = JSON.parse(json);
      if (!data.portals || data.portals.length === 0) return null;
      const target = direction === 'prev' ? data.portals[0] : data.portals[data.portals.length - 1];
      if (!target) return null;
      const useY = target.useY ?? (target.y - (target.height ?? PORTAL_HEIGHT) * PORTAL_USE_RATIO);
      return { x: target.x, useX: target.x, useY, source: data.source, destination: target.destination };
    } catch (e) { pushLog(`⚠️ getRealPortal: ${e.message}`); return null; }
  }

  function getAllRealPortals(mapId) {
    try {
      const fn = pageWindow.__wildpote_getPortals__;
      if (typeof fn !== 'function') return null;
      const json = fn();
      if (!json || json === 'null') return null;
      const data = JSON.parse(json);
      if (!data.portals || data.portals.length === 0) return null;
      return data.portals.map(p => ({
        x: p.x,
        useX: p.x,
        useY: p.useY ?? (p.y - (p.height ?? PORTAL_HEIGHT) * PORTAL_USE_RATIO),
        destination: p.destination,
        source: data.source,
      }));
    } catch (e) { return null; }
  }

  // ═════════════════════════════════════════════════════════════════
  //  5. TOUCHES CLAVIER + FOCUS CANVAS
  // ═════════════════════════════════════════════════════════════════
  let canvasEl = null;
  function getCanvas() {
    if (!canvasEl || !canvasEl.isConnected) {
      canvasEl = document.querySelector('#gameGpu') || document.querySelector('canvas');
      if (canvasEl && !canvasEl.hasAttribute('tabindex')) canvasEl.setAttribute('tabindex', '0');
      if (canvasEl && canvasEl.getAttribute('aria-hidden') === 'true') {
        canvasEl.setAttribute('data-wp-aria-hidden', 'true');
        canvasEl.removeAttribute('aria-hidden');
      }
    }
    return canvasEl;
  }

  function forcerFocusCanvas() {
    const canvas = getCanvas();
    if (!canvas) return false;
    if (document.activeElement === canvas) return true;
    try { canvas.focus({ preventScroll: true }); } catch (e) {}
    return document.activeElement === canvas;
  }

  function envoyerTouches(touchesVoulues) {
    const canvas = getCanvas();
    if (!canvas) return;
    forcerFocusCanvas();
    const relachees = Array.from(touchesActives).filter(t => !touchesVoulues.includes(t));
    for (const t of relachees) {
      const evt = new KeyboardEvent('keyup', { key: t, code: t, keyCode: KEYCODES[t], which: KEYCODES[t], bubbles: true, cancelable: true, composed: true });
      window.dispatchEvent(evt);
      try { canvas.dispatchEvent(evt); } catch (e) {}
    }
    const nouvelles = touchesVoulues.filter(t => !touchesActives.has(t));
    for (const t of nouvelles) {
      const evt = new KeyboardEvent('keydown', { key: t, code: t, keyCode: KEYCODES[t], which: KEYCODES[t], bubbles: true, cancelable: true, composed: true });
      window.dispatchEvent(evt);
      try { canvas.dispatchEvent(evt); } catch (e) {}
    }
    touchesActives = new Set(touchesVoulues);
  }

  function relacherToutes() {
    const canvas = getCanvas();
    for (const t of touchesActives) {
      const evt = new KeyboardEvent('keyup', { key: t, code: t, keyCode: KEYCODES[t], which: KEYCODES[t], bubbles: true, cancelable: true, composed: true });
      window.dispatchEvent(evt);
      if (canvas) try { canvas.dispatchEvent(evt); } catch (e) {}
    }
    touchesActives.clear();
  }

  async function pushDirectionnel(dir, durationMs = PUSH_DURATION_MS) {
    const canvas = getCanvas();
    if (!canvas) return;
    forcerFocusCanvas();
    const down = new KeyboardEvent('keydown', { key: dir, code: dir, keyCode: KEYCODES[dir], which: KEYCODES[dir], bubbles: true, cancelable: true, composed: true });
    window.dispatchEvent(down);
    try { canvas.dispatchEvent(down); } catch (e) {}
    await new Promise(r => setTimeout(r, durationMs));
    const up = new KeyboardEvent('keyup', { key: dir, code: dir, keyCode: KEYCODES[dir], which: KEYCODES[dir], bubbles: true, cancelable: true, composed: true });
    window.dispatchEvent(up);
    try { canvas.dispatchEvent(up); } catch (e) {}
  }

  function directionVersTouches(angleRad) {
    const deg = (angleRad * 180 / Math.PI + 360) % 360;
    const secteurs = [
      { min: 337.5, max: 22.5, touches: ['ArrowRight'] }, { min: 22.5, max: 67.5, touches: ['ArrowDown', 'ArrowRight'] },
      { min: 67.5, max: 112.5, touches: ['ArrowDown'] }, { min: 112.5, max: 157.5, touches: ['ArrowDown', 'ArrowLeft'] },
      { min: 157.5, max: 202.5, touches: ['ArrowLeft'] }, { min: 202.5, max: 247.5, touches: ['ArrowUp', 'ArrowLeft'] },
      { min: 247.5, max: 292.5, touches: ['ArrowUp'] }, { min: 292.5, max: 337.5, touches: ['ArrowUp', 'ArrowRight'] },
    ];
    for (const s of secteurs) {
      if (s.min > s.max) { if (deg >= s.min || deg < s.max) return s.touches; }
      else if (deg >= s.min && deg < s.max) return s.touches;
    }
    return ['ArrowRight'];
  }

  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) dernierInputJoueur = Date.now();
  }, true);

  // ═════════════════════════════════════════════════════════════════
  //  5.5. UTILS ASYNC + CLIC
  // ═════════════════════════════════════════════════════════════════
  function attendre(ms) { return new Promise(r => setTimeout(r, ms)); }

  function simulerClic(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) {}
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      }
      return true;
    } catch (e) { return false; }
  }

  // ═════════════════════════════════════════════════════════════════
  //  6. MORT
  // ═════════════════════════════════════════════════════════════════
  function estMort() {
    const ds = document.querySelector('div.death-screen');
    if (!ds) return false;
    const style = window.getComputedStyle(ds);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = ds.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  // ═════════════════════════════════════════════════════════════════
  //  7. ORBIT
  // ═════════════════════════════════════════════════════════════════
  function orbitTrail(radius, speed, chaseSpeed, turnRate = ENEMY_CHASE_TURN_RATE) {
    const spin = speed / radius;
    const lag = Math.atan(spin / turnRate);
    const inner = chaseSpeed / (spin * Math.sqrt(1 + (spin / turnRate) ** 2));
    const square = radius * radius - (inner * Math.cos(lag)) ** 2;
    return square < 0 ? null : inner * Math.sin(lag) + Math.sqrt(square);
  }

  function orbitRadii(speed, chaseSpeed, r, chasers, maxRadius) {
    if (!chasers.length) return { radii: [], band: null, preferred: MIN_LOOP };
    const widest = Math.max(...chasers.map(c => c.r || 20));
    const mean = chasers.reduce((s, c) => s + (c.r || 20), 0) / chasers.length;
    const needed = r + widest + ORBIT_CLEARANCE + ORBIT_CROWDING * mean * Math.sqrt(Math.max(0, chasers.length - 1));
    let low = Infinity, high = -Infinity;
    for (let radius = MIN_LOOP; radius <= maxRadius; radius += 2) {
      const trail = orbitTrail(radius, speed, Math.max(speed, chaseSpeed));
      if (trail === null) break;
      if (trail >= needed) { low = Math.min(low, radius); high = radius; }
    }
    const band = Number.isFinite(low) ? [low, high] : null;
    const span = band ? band[1] - band[0] : 0;
    const radii = [...(band ? [band[0] + span * ORBIT_BAND_SHARE, band[0] + span * 0.4, band[0] + span * 0.95] : []), ...WIDE_LOOPS, 100, 70]
      .filter(r => r >= MIN_LOOP && r <= maxRadius);
    const unique = [...new Set(radii)];
    return { radii: unique, band, preferred: unique[0] ?? MIN_LOOP };
  }

  function chooseOrbit(from, chasers, speed, chaseSpeed, maxRadius, currentOrbit) {
    if (!chasers.length) return null;
    const { radii, band, preferred } = orbitRadii(speed, chaseSpeed, PLAYER_RADIUS, chasers, maxRadius);
    const holds = (r) => band !== null && r >= band[0] - 1 && r <= band[1] + 1;
    const cx = chasers.reduce((s, c) => s + c.x, 0) / chasers.length;
    const cy = chasers.reduce((s, c) => s + c.y, 0) / chasers.length;
    const toward = Math.atan2(cy - from.y, cx - from.x);
    const candidates = [];
    const add = (orbit, cost) => candidates.push({ orbit, cost: cost + Math.abs(orbit.r - preferred) + (holds(orbit.r) ? 0 : NOT_HOLDING) });
    if (currentOrbit) { add(currentOrbit, -40); add({ x: 2 * from.x - currentOrbit.x, y: 2 * from.y - currentOrbit.y, r: currentOrbit.r, dir: currentOrbit.dir === 1 ? -1 : 1 }, -20); }
    const tangentGauche = toward + Math.PI / 2;
    const tangentDroite = toward - Math.PI / 2;
    for (const radius of radii) {
      for (let turn = 0; turn < 8; turn++) {
        for (const dir of [1, -1]) {
          const angle = toward + turn * 2 * Math.PI / 8;
          const heading = angle + Math.PI + dir * Math.PI / 2;
          const ecartG = Math.abs(Math.atan2(Math.sin(heading - tangentGauche), Math.cos(heading - tangentGauche)));
          const ecartD = Math.abs(Math.atan2(Math.sin(heading - tangentDroite), Math.cos(heading - tangentDroite)));
          add({ x: from.x + Math.cos(angle) * radius, y: from.y + Math.sin(angle) * radius, r: radius, dir }, Math.min(ecartG, ecartD) * ENTRY_COST);
        }
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const meilleur = candidates[0]?.orbit ?? null;
    if (meilleur && currentOrbit) {
      const memesDir = candidates.filter(c => c.orbit.dir === currentOrbit.dir);
      if (memesDir.length > 0 && memesDir[0].cost < meilleur.cost * 1.3) { memesDir[0].orbit.createdAt = Date.now(); return memesDir[0].orbit; }
    }
    if (meilleur) meilleur.createdAt = Date.now();
    return meilleur;
  }

  function orbitStep(orbit, from, speed) {
    const angleActuel = Math.atan2(from.y - orbit.y, from.x - orbit.x);
    const distActuelle = Math.hypot(from.x - orbit.x, from.y - orbit.y);
    const ecartRayon = distActuelle - orbit.r;
    if (Math.abs(ecartRayon) > orbit.r * 0.3) return { x: orbit.x + Math.cos(angleActuel) * orbit.r, y: orbit.y + Math.sin(angleActuel) * orbit.r };
    const avance = orbit.dir * Math.min(Math.PI / 18, Math.max(0.1, speed * ORBIT_LEAD / orbit.r));
    const angleVise = angleActuel + avance;
    return { x: orbit.x + Math.cos(angleVise) * orbit.r, y: orbit.y + Math.sin(angleVise) * orbit.r };
  }

  // ═════════════════════════════════════════════════════════════════
  //  8. KITING
  // ═════════════════════════════════════════════════════════════════
  let statsKiting = { chasseurs: 0, plusProche: 0, orbite: '—', touches: '—', etat: 'idle' };

  function boucleKiting() {
    if (!kitingActif) { if (touchesActives.size > 0 && !navigationEnCours) relacherToutes(); statsKiting.etat = 'off'; return; }
    if (estMort()) { relacherToutes(); orbitActuelle = null; statsKiting.etat = 'mort'; return; }
    if (Date.now() - dernierInputJoueur < 1500) { relacherToutes(); statsKiting.etat = 'pause'; return; }
    const coop = getCoop();
    if (!coop || !coop.isConnected || !coop.isConnected()) { relacherToutes(); statsKiting.etat = 'déconnecté'; return; }
    const clientPos = getPositionInterpolee(coop);
    if (!clientPos) { relacherToutes(); statsKiting.etat = 'pas de position'; return; }
    const pos = { x: clientPos.x, y: clientPos.y };
    let chasers = [];
    try { const json = pageWindow.__wildpote_chasers_json__; if (json) chasers = JSON.parse(json); } catch (e) {}
    statsKiting.chasseurs = chasers.length;
    if (chasers.length === 0) {
      const lastNonEmpty = pageWindow.__wildpote_last_nonempty_ts__ || 0;
      if (Date.now() - lastNonEmpty < 1000 && orbitActuelle) { statsKiting.etat = 'orbite (cache)'; return; }
      relacherToutes(); orbitActuelle = null; dernierBlocageTs = 0; dernierePos = null;
      statsKiting.plusProche = 0; statsKiting.orbite = '—'; statsKiting.touches = '—'; statsKiting.etat = 'attente';
      return;
    }
    const plusProche = Math.min(...chasers.map(c => c.dist - c.r - PLAYER_RADIUS));
    statsKiting.plusProche = Math.round(plusProche);
    if (plusProche >= KITE_ROOM) { relacherToutes(); orbitActuelle = null; dernierBlocageTs = 0; dernierePos = null; statsKiting.orbite = '—'; statsKiting.touches = '—'; statsKiting.etat = 'safe'; return; }
    if (antiStuckActif && touchesActives.size > 0) {
      const posKey = `${pos.x.toFixed(1)},${pos.y.toFixed(1)}`;
      if (dernierePos === posKey) {
        if (dernierBlocageTs === 0) dernierBlocageTs = Date.now();
        else if (Date.now() - dernierBlocageTs > 2000) {
          relacherToutes();
          const perpendiculaire = { 'ArrowUp': 'ArrowRight', 'ArrowRight': 'ArrowDown', 'ArrowDown': 'ArrowLeft', 'ArrowLeft': 'ArrowUp' };
          const touchesActuelles = Array.from(touchesActives);
          envoyerTouches(touchesActuelles.length > 0 ? [perpendiculaire[touchesActuelles[0]] || 'ArrowRight'] : ['ArrowRight']);
          orbitActuelle = null; dernierBlocageTs = Date.now(); statsKiting.etat = 'anti-stuck';
          return;
        }
      } else { dernierePos = posKey; dernierBlocageTs = 0; }
    }
    const speed = 295;
    const chaseSpeed = speed + CHASE_SPEED_BONUS;
    const maxRadius = Math.min(300, 200);
    if (orbitActuelle) {
      const distOrbite = Math.hypot(orbitActuelle.x - pos.x, orbitActuelle.y - pos.y);
      if (Math.abs(distOrbite - orbitActuelle.r) > orbitActuelle.r * 0.8 || (orbitActuelle.createdAt && Date.now() - orbitActuelle.createdAt > 5000)) orbitActuelle = null;
    }
    if (!orbitActuelle) orbitActuelle = chooseOrbit({ x: pos.x, y: pos.y }, chasers, speed, chaseSpeed, maxRadius, null);
    if (orbitActuelle) {
      const cible = orbitStep(orbitActuelle, { x: pos.x, y: pos.y }, speed);
      const angle = Math.atan2(cible.y - pos.y, cible.x - pos.x);
      const touches = directionVersTouches(angle);
      envoyerTouches(touches);
      statsKiting.orbite = `r=${Math.round(orbitActuelle.r)} dir=${orbitActuelle.dir > 0 ? '+' : '-'}`;
      statsKiting.touches = touches.map(t => t.replace('Arrow', '')).join(' ');
      statsKiting.etat = 'orbite'; return;
    }
    relacherToutes(); orbitActuelle = null; statsKiting.etat = 'pas d\'orbite';
  }

  setInterval(boucleKiting, 100);

  // ═════════════════════════════════════════════════════════════════
  //  8.5. MONITEUR GLOBAL MAPID
  // ═════════════════════════════════════════════════════════════════
  let _derniereMapVue = null;
  setInterval(() => {
    try {
      const c = getCoop();
      if (!c?.isConnected?.()) return;
      const mapId = getMapIdActuel();
      if (!mapId) return;
      if (mapId !== _derniereMapVue) {
        const ts = new Date().toLocaleTimeString('fr-FR', { hour12: false });
        const domName = document.getElementById('minimapMapName')?.textContent?.trim() || '';
        console.log(`[WildPote] 🗺️ MAP CHANGE: ${_derniereMapVue ?? '(init)'} → ${mapId} [DOM="${domName}"] @ ${ts}`);
        _derniereMapVue = mapId;
      }
    } catch (e) {}
  }, 100);

  // ═════════════════════════════════════════════════════════════════
  //  9. UI HELPERS
  // ═════════════════════════════════════════════════════════════════
  /**
   * h() — hyperscript minimal : crée un élément DOM déclaratif.
   *   h('div', { class: 'x', onclick: fn, style: { flex: 1 } }, 'txt', h('span'))
   * Props supportées : class/className, text, style (objet), dataset, on* (events),
   * tout le reste via el[k] = v (checked, disabled, value, type…) ou setAttribute.
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
        else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        }
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
    }
    return el;
  }

  const logsBuffer = [];
  const logsPre = document.createElement('pre');
  logsPre.style.cssText = 'font-size:9px;color:#888;margin:0;white-space:pre-wrap;max-height:150px;overflow-y:auto;';

  const pushLog = (msg) => {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    logsBuffer.push(`[${ts}] ${msg}`); if (logsBuffer.length > 100) logsBuffer.shift();
    logsPre.textContent = logsBuffer.join('\n') || '(aucun)';
  };

  const setVal = (el, text, cls) => { if (el && el.textContent !== text) { el.textContent = text; el.className = 'wp-status-value' + (cls ? ' ' + cls : ''); } };

  function estVisible(el) {
    if (!el) return false;
    if (el.hasAttribute('hidden')) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    return el.getClientRects().length > 0;
  }

  function construireStatusRow(label, initialValue, initialClass = '') {
    const val = h('span', {
      class: 'wp-status-value' + (initialClass ? ' ' + initialClass : ''),
      text: initialValue,
    });
    const row = h('div', { class: 'wp-status-row' },
      h('span', { class: 'wp-status-label', text: label }),
      val
    );
    return { row, val };
  }

  function construireSection(titre, couleurBorder = '#444', defaultCollapsed = false) {
    const chevron = h('span', {
      class: 'wp-section-chevron',
      style: { display: 'inline-block', transition: 'transform .15s', fontSize: '9px', color: '#888' },
      text: '▸',
    });
    const labelSpan = h('span', { text: titre });
    const title = h('div', {
      class: 'wp-section-title',
      style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', userSelect: 'none' },
    }, chevron, labelSpan);

    const content = h('div', {
      class: 'wp-section-content',
      style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '4px' },
    });

    const section = h('div', {
      class: 'wp-section',
      style: { borderLeftColor: couleurBorder },
    }, title, content);

    // Refs exposées pour les sections qui doivent réorganiser leur titre
    // (ex: AUTO-PRESTIGE ajoute un toggle inline à droite du label).
    section._wpTitle = title;
    section._wpContent = content;
    section._wpChevron = chevron;
    section._wpLabel = labelSpan;

    const storageKey = `wildpote_section_${titre.replace(/[^a-zA-Z0-9]/g, '_')}_collapsed`;
    const savedState = localStorage.getItem(storageKey);
    let collapsed = savedState !== null ? (savedState === 'true') : defaultCollapsed;

    if (collapsed) {
      content.style.display = 'none';
      chevron.style.transform = 'rotate(-90deg)';
    }
    title.onclick = () => {
      collapsed = !collapsed;
      content.style.display = collapsed ? 'none' : 'flex';
      chevron.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
      localStorage.setItem(storageKey, String(collapsed));
    };

    const originalAppendChild = section.appendChild.bind(section);
    section.appendChild = function(child) {
      if (child === title || child === content) return originalAppendChild(child);
      return content.appendChild(child);
    };
    const originalAppend = section.append.bind(section);
    section.append = function(...children) {
      const toContent = children.filter(c => c !== title && c !== content);
      const toSection = children.filter(c => c === title || c === content);
      if (toSection.length) originalAppend(...toSection);
      if (toContent.length) content.append(...toContent);
    };

    return section;
  }

  function construireToggle(labelTxt, checked, onChange) {
    const input = h('input', {
      type: 'checkbox',
      checked,
      onchange: (e) => onChange(e.target.checked),
    });
    const toggle = h('label', null, input, h('span', { class: 'wp-knob' }));
    const row = h('div', { class: 'wp-toggle-row' },
      h('span', { style: { flex: '1' }, text: labelTxt }),
      toggle
    );
    return { row, input };
  }

  function construireToggleInline(checked, onChange, titleAttr = '') {
    const input = h('input', {
      type: 'checkbox',
      checked,
      style: { opacity: '0', width: '0', height: '0', position: 'absolute' },
      onchange: (e) => {
        e.stopPropagation();
        onChange(e.target.checked);
      },
    });
    const knob = h('span', {
      class: 'wp-knob',
      style: { position: 'absolute', inset: '0', background: '#333', borderRadius: '16px', transition: '.15s' },
    });
    const toggle = h('label', {
      title: titleAttr || undefined,
      style: { display: 'inline-block', position: 'relative', width: '32px', height: '16px', cursor: 'pointer', verticalAlign: 'middle' },
      onclick: (e) => e.stopPropagation(),
    }, input, knob);
    return { toggle, input };
  }

  function injecterStyle() {
    if (document.getElementById('wildpote-style')) return;
    const style = document.createElement('style'); style.id = 'wildpote-style';
    style.textContent = `
      #wildpote-ui { position: fixed; z-index: 9999998; width: 280px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); overflow: hidden auto; pointer-events: auto; background: rgba(24, 24, 24, var(--wp-bg, .85)); color: #f5f5e9; border: 2px solid #050a06; border-radius: 9px; box-shadow: 0 2px 0 rgba(0,0,0,.42); font: 12px/1.3 "Arial Rounded MT Bold", Arial, sans-serif; font-variant-numeric: tabular-nums; -webkit-user-select: none; user-select: none; }
      #wildpote-ui header { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 8px; border-bottom: 1px solid rgba(255,255,255,.14); }
      #wildpote-ui .wp-handle { flex: 1; text-align: left; white-space: nowrap; font-weight: 900; letter-spacing: .03em; cursor: grab; touch-action: none; background: transparent; border: 0; margin: 0; padding: 4px 6px; min-height: 32px; color: inherit; font: inherit; text-shadow: .06em .10em 0 #000; }
      #wildpote-ui .wp-chevron { display: inline-block; margin-left: 4px; opacity: .8; transition: transform .15s; }
      #wildpote-ui.is-collapsed .wp-chevron { transform: rotate(-90deg); }
      #wildpote-ui.is-collapsed .wp-tabs, #wildpote-ui.is-collapsed .wp-content { display: none; }
      #wildpote-ui .wp-tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,.14); }
      #wildpote-ui .wp-tab { flex: 1; padding: 8px 4px; background: transparent; border: 0; border-bottom: 3px solid transparent; color: #b7c5b7; font: 900 10px Arial, sans-serif; cursor: pointer; text-transform: uppercase; letter-spacing: .03em; text-shadow: .06em .10em 0 #000; transition: color .12s, border-color .12s; }
      #wildpote-ui .wp-tab.is-active { color: #f5f5e9; border-bottom-color: #69e56f; }
      #wildpote-ui .wp-content { display: flex; flex-direction: column; gap: 6px; padding: 8px; max-height: calc(100dvh - 260px); overflow-y: auto; }
      #wildpote-ui .wp-tab-panel { display: flex; flex-direction: column; gap: 6px; }
      #wildpote-ui .wp-btn { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 6px 10px; min-height: 32px; background: rgba(255,255,255,.06); color: #f5f5e9; border: 0; border-radius: 6px; font: 900 11px Arial, sans-serif; cursor: pointer; text-shadow: .06em .10em 0 #000; transition: background-color .12s; }
      #wildpote-ui .wp-btn:hover:not(:disabled) { background: rgba(255,255,255,.14); }
      #wildpote-ui .wp-btn:disabled { background: rgba(255,255,255,.03); color: #666; cursor: not-allowed; text-shadow: none; }
      #wildpote-ui .wp-btn.wp-primary { background: rgba(105,229,111,.22); }
      #wildpote-ui .wp-btn.wp-primary:hover:not(:disabled) { background: rgba(105,229,111,.35); }
      #wildpote-ui .wp-btn.wp-info { background: rgba(116,216,255,.22); }
      #wildpote-ui .wp-btn.wp-info:hover:not(:disabled) { background: rgba(116,216,255,.35); }
      #wildpote-ui .wp-btn.wp-danger { background: rgba(255,103,103,.22); }
      #wildpote-ui .wp-btn.wp-danger:hover:not(:disabled) { background: rgba(255,103,103,.35); }
      #wildpote-ui .wp-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; min-height: 26px; }
      #wildpote-ui .wp-toggle-row label { display: inline-block; position: relative; width: 32px; height: 16px; cursor: pointer; }
      #wildpote-ui .wp-toggle-row input[type=checkbox] { opacity: 0; width: 0; height: 0; position: absolute; }
      #wildpote-ui .wp-toggle-row .wp-knob { position: absolute; inset: 0; background: #333; border-radius: 16px; transition: .15s; }
      #wildpote-ui .wp-toggle-row .wp-knob::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #ccc; transition: .15s; }
      #wildpote-ui .wp-toggle-row input:checked + .wp-knob { background: #69e56f; }
      #wildpote-ui .wp-toggle-row input:checked + .wp-knob::after { left: 18px; background: #0f0f0f; }
      #wildpote-ui .wp-knob::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #ccc; transition: .15s; }
      #wildpote-ui label > input[type=checkbox]:checked + .wp-knob { background: #69e56f; }
      #wildpote-ui label > input[type=checkbox]:checked + .wp-knob::after { left: 18px; background: #0f0f0f; }
      #wildpote-ui .wp-status-row { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
      #wildpote-ui .wp-status-label { color: #888; font-weight: 900; text-transform: uppercase; font-size: 10px; }
      #wildpote-ui .wp-status-value { color: #f5f5e9; font-weight: 900; text-align: right; font-variant-numeric: tabular-nums; }
      #wildpote-ui .wp-status-value.wp-ok { color: #69e56f; } .wp-status-value.wp-bad { color: #ff6767; } .wp-status-value.wp-warn { color: #ffd85b; } .wp-status-value.wp-info { color: #74d8ff; }
      #wildpote-ui .wp-section { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; background: rgba(255,255,255,.03); border-radius: 6px; border-left: 3px solid #444; }
      #wildpote-ui .wp-section-title { font-size: 10px; color: #b7c5b7; font-weight: 900; text-transform: uppercase; }
      #wildpote-ui .wp-section-content { display: flex; flex-direction: column; gap: 4px; }
      #wildpote-ui summary::-webkit-details-marker { display: none; }
      #wildpote-ui summary::marker { content: ''; }
      #wildpote-ui details.wp-collapse summary { list-style: none; }
      /* Target Cards UI */
      #wildpote-ui .cf-map-group { margin-bottom: 4px; }
      #wildpote-ui .cf-map-header { display: flex; align-items: center; gap: 4px; padding: 4px 6px; background: rgba(255,255,255,.05); border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 900; color: #74d8ff; }
      #wildpote-ui .cf-map-header:hover { background: rgba(255,255,255,.1); }
      #wildpote-ui .cf-map-chevron { font-size: 9px; color: #888; transition: transform .15s; display: inline-block; }
      #wildpote-ui .cf-map-count { color: #888; font-weight: 400; font-size: 9px; margin-left: auto; }
      #wildpote-ui .cf-map-list { display: none; flex-direction: column; gap: 1px; padding: 2px 0 4px 8px; }
      #wildpote-ui .cf-map-group.is-open .cf-map-list { display: flex; }
      #wildpote-ui .cf-map-group.is-open .cf-map-chevron { transform: rotate(90deg); }
      #wildpote-ui .cf-mob-row { display: flex; align-items: center; gap: 4px; padding: 2px 4px; font-size: 10px; border-radius: 3px; }
      #wildpote-ui .cf-mob-row:hover { background: rgba(255,255,255,.05); }
      #wildpote-ui .cf-mob-row input[type=checkbox] { margin: 0; width: 12px; height: 12px; cursor: pointer; flex-shrink: 0; }
      #wildpote-ui .cf-mob-name { color: #f5f5e9; white-space: nowrap; flex-shrink: 0; }
      #wildpote-ui .cf-mob-desc { color: #b7c5b7; font-style: italic; font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; min-width: 0; flex-grow: 1; }
      #wildpote-ui .cf-mob-rarity { font-size: 8px; padding: 1px 4px; border-radius: 2px; font-weight: 900; margin-left: auto; flex-shrink: 0; }
      #wildpote-ui .cf-mob-rarity.regular { background: rgba(120,120,120,.3); color: #b7c5b7; }
      #wildpote-ui .cf-mob-rarity.elite { background: rgba(180,127,255,.3); color: #b47fff; }
      #wildpote-ui .cf-mob-rarity.boss { background: rgba(255,101,90,.3); color: #ff655a; }
      #wildpote-ui .cf-mob-owned { font-size: 8px; color: #69e56f; font-weight: 900; flex-shrink: 0; }
      #wildpote-ui .cf-target-list { display: flex; flex-direction: column; gap: 2px; min-height: 30px; padding: 4px; background: rgba(0,0,0,.2); border-radius: 4px; max-height: 200px; overflow-y: auto; }
      #wildpote-ui .cf-target-item { display: flex; align-items: center; gap: 4px; padding: 4px 6px; background: rgba(255,255,255,.06); border-radius: 3px; font-size: 10px; cursor: grab; user-select: none; }
      #wildpote-ui .cf-target-item:hover { background: rgba(255,255,255,.1); }
      #wildpote-ui .cf-target-item.is-dragging { opacity: .4; }
      #wildpote-ui .cf-target-item.is-drop-target { border-top: 2px solid #69e56f; }
      #wildpote-ui .cf-target-grip { color: #666; font-size: 12px; cursor: grab; }
      #wildpote-ui .cf-target-name { flex: 1; }
      #wildpote-ui .cf-target-count { color: #69e56f; font-weight: 900; font-size: 9px; }
      #wildpote-ui .cf-target-remove { background: transparent; border: 0; color: #666; cursor: pointer; font-size: 12px; padding: 0 2px; }
      #wildpote-ui .cf-target-remove:hover { color: #ff6767; }
      #wildpote-ui .cf-empty-hint { color: #666; font-size: 9px; text-align: center; padding: 8px; font-style: italic; }
      #wildpote-ui .cf-copies-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
      #wildpote-ui .cf-copies-row label { flex: 1; font-size: 10px; color: #b7c5b7; }
      #wildpote-ui .cf-copies-row input { width: 50px; padding: 3px 6px; background: #2a2a2a; color: #f5f5e9; border: 1px solid #444; border-radius: 3px; font-size: 11px; text-align: center; font-family: inherit; }
      #wildpote-ui .cf-actions { display: flex; gap: 4px; }
      #wildpote-ui .cf-actions .wp-btn { flex: 1; }
      #wildpote-ui .cf-status { font-size: 10px; padding: 3px 0; }
      #wildpote-ui .cf-logs { font-size: 9px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; color: #8aa8c8; background: rgba(0,0,0,.3); padding: 4px; border-radius: 4px; margin-top: 4px; }
    `;
    document.head.appendChild(style);
  }

  // ═════════════════════════════════════════════════════════════════
  //  10. PRESTIGE
  // ═════════════════════════════════════════════════════════════════
  async function declencherPrestige(manuel = false) {
    if (prestigeEnCours) return;
    if (!manuel && Date.now() - dernierPrestigeTs < 3000) return;
    const c = getCoop();
    if (!c?.prestigeAccount) throw new Error('prestigeAccount indisponible');
    prestigeEnCours = true;
    const debutPrestige = Date.now();
    pushLog((manuel ? '👑 Manuel' : '👑 Auto-prestige') + '...');
    try {
      const result = await c.prestigeAccount();
      if (result?.ok) {
        pushLog('✅ Prestige OK ! Niveau ' + (result.level ?? '?'));
        derniereErreurPrestige = null;
        prestigeEnAttente = false;
        prestigeMapAttente = null;
        dernierPrestigePerf = Date.now();
        localStorage.setItem('wildpote_prestige_time', String(dernierPrestigePerf));
        const dureeSec = Math.floor((dernierPrestigePerf - debutPrestige) / 1000);
        const h = Math.floor(dureeSec / 3600), m = Math.floor((dureeSec % 3600) / 60), s = dureeSec % 60;
        dernierPrestigeDuree = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
        localStorage.setItem('wildpote_prestige_duree', dernierPrestigeDuree);
      } else {
        derniereErreurPrestige = result?.error ?? 'inconnue';
        pushLog('❌ Refus : ' + derniereErreurPrestige);
        if (/clear\s+endless|defeat.*prime|before\s+prestiging/i.test(derniereErreurPrestige)) {
          prestigeEnAttente = true;
          prestigeMapAttente = getMapIdActuel();
          pushLog(`⏸️ Auto-prestige en pause — reprise au prochain changement de map (actuellement: ${prestigeMapAttente ?? '?'})`, 'warn');
        }
      }
      dernierPrestigeTs = Date.now();
      return result;
    } catch (e) {
      pushLog('❌ Erreur API : ' + e.message);
      derniereErreurPrestige = e.message;
      dernierPrestigeTs = Date.now();
      throw e;
    } finally {
      prestigeEnCours = false;
    }
  }

  function verifierConditionsPrestige() {
    const c = getCoop();
    if (!c) return { ok: false, raison: 'API absente' };
    try {
      const p = c.prestige?.();
      const challenge = c.prestigeChallenge?.();
      if (!p) return { ok: false, raison: 'prestige() indisponible' };
      if (challenge?.active) return { ok: false, raison: 'Challenge en cours' };
      const level = p.level ?? 0;
      return { ok: true, raison: getPrestigeGoal(level), goal: getPrestigeGoal(level), level };
    } catch (e) { return { ok: false, raison: 'Erreur: ' + e.message }; }
  }

  // ═════════════════════════════════════════════════════════════════
  //  11. UTILS
  // ═════════════════════════════════════════════════════════════════
  async function verifierEtConnecter() {
    if (!autoLoginActif || authConnexionEnCours || Date.now() - dernierAuthTs < 10000) return false;
    const btn = document.querySelector('#signInFromStartBtn');
    if (!estVisible(btn)) return false;
    authConnexionEnCours = true; dernierAuthTs = Date.now(); pushLog('🔑 Auto-login...');
    try {
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
      if (estVisible(btn)) { pushLog('🔑 Clic SIGN IN'); btn.click(); await new Promise(r => setTimeout(r, 6000)); }
    } catch (e) { pushLog('❌ Erreur login : ' + e.message); } finally { authConnexionEnCours = false; }
    return true;
  }

  async function claimDailyGems(manuel = false) {
    if (gemClaimEnCours) return;
    const c = getCoop(); if (!c) return;
    let claimable = false;
    try { claimable = c.dailyGemBonusClaimable?.() === true; } catch (e) {}
    if (!claimable && !manuel) return;
    if (!c.claimDailyGemBonus) return;
    gemClaimEnCours = true; pushLog((manuel ? '💎 Manuel' : '💎 Auto') + ' claim...');
    try {
      const result = await c.claimDailyGemBonus();
      if (result?.ok) pushLog('✅ Gems claim !'); else pushLog('❌ Claim refusé');
      return result;
    } catch (e) { pushLog('❌ Erreur claim : ' + e.message); } finally { gemClaimEnCours = false; }
  }

  async function verifierEtLancerPub() {
    if (!autoAdActif || _autoAdEnCours) return false;

    const btnMain = document.getElementById('enemyRespawnAdBtn');
    const btnConfirm = document.getElementById('enemyRespawnAdConfirm');
    const confirmOk = btnConfirm && estVisible(btnConfirm);
    const mainOk = btnMain && estVisible(btnMain);

    if (!confirmOk && !mainOk) return false;

    _autoAdEnCours = true;
    try {
      const c = getCoop();
      if (c?.claimAdGems) {
        const avant = c.gemBalance?.()?.gems ?? -1;
        let result = null;
        try {
          result = await c.claimAdGems();
        } catch (e) {
          pushLog(`⚠️ Pub API erreur: ${e.message}`, 'warn');
        }

        if (result?.ok) {
          const apres = c.gemBalance?.()?.gems ?? -1;
          const gain = avant >= 0 && apres >= 0 ? apres - avant : 10;
          pushLog(`⚡ Pub API (+${gain} gemmes)`, 'ok');
          return true;
        }

        if (result?.error) {
          pushLog(`⚠️ Pub API refusée (${result.error}) — fallback clic`, 'warn');
        }
      }

      if (confirmOk) {
        simulerClic(btnConfirm);
        await attendre(3000);
        pushLog('📺 Pub (confirm direct)');
        return true;
      }

      if (mainOk) {
        simulerClic(btnMain);
        await attendre(1500);
        const confirm2 = document.getElementById('enemyRespawnAdConfirm');
        if (confirm2 && estVisible(confirm2)) {
          simulerClic(confirm2);
          await attendre(3000);
        }
        pushLog('📺 Pub (btn → confirm)');
        return true;
      }

      return false;
    } finally {
      _autoAdEnCours = false;
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  12. QUÊTES
  // ═════════════════════════════════════════════════════════════════
  function exposerQuestsJson() {
    try {
      pageWindow.eval(`
        (function() {
          if (window.__wildpote_quests_installed__) return;
          window.__wildpote_quests_installed__ = true;
          window.__wildpote_quests_json__ = 'null';
          function majQuests() {
            try {
              const coop = window.wildstatCoop;
              if (!coop || !coop.isConnected()) return;
              const data = coop.dailyQuests();
              if (!data || !data.quests) return;
              const simplified = {
                guildName: data.guildName || null, bonus: data.bonus, guildPoints: data.guildPoints,
                quests: data.quests.map(q => ({ mapId: String(q.mapId), enemy: String(q.enemy), target: Number(q.target), progress: Number(q.progress), takenBy: q.takenBy ? String(q.takenBy) : null }))
              };
              window.__wildpote_quests_json__ = JSON.stringify(simplified);
            } catch (e) {}
          }
          setInterval(majQuests, 3000);
          majQuests();
        })();
      `);
      log('✅ Exposition quêtes JSON installée');
    } catch (e) { log('❌ Échec exposition quêtes :', e.message); }
  }

  let questUI = null;

  function mettreAJourQuests() {
    if (!questUI) return;
    try {
      const json = pageWindow.__wildpote_quests_json__;
      if (!json || json === 'null') return;
      const data = JSON.parse(json);
      if (!data || !data.quests || data.quests.length === 0) return;
      const quests = data.quests;
      const done = quests.filter(q => q.progress >= q.target);
      setVal(questUI.questDoneCount, `${done.length}/15`, 'wp-num');
      setVal(questUI.questGuild, data.guildName || '—', 'wp-info');
      setVal(questUI.questBonus, data.bonus ? `+${Math.round((data.bonus - 1) * 100)}%` : '—', 'wp-ok');
      questUI.questTermineesContainer.innerHTML = '';
      if (done.length === 0) { const vide = document.createElement('div'); vide.style.cssText = 'color:#666;'; vide.textContent = '(aucune)'; questUI.questTermineesContainer.appendChild(vide); }
      else done.forEach(q => { const line = document.createElement('div'); line.style.cssText = 'color:#69e56f;'; line.textContent = `✓ ${q.enemy} (${q.mapId}) ${q.progress}/${q.target}`; questUI.questTermineesContainer.appendChild(line); });
    } catch (e) {}
  }

  function mettreAJourQuestsDepuisTracker() {
    if (!questUI) return;
    const quests = lireQuetesDepuisTracker();
    if (!quests || quests.length === 0) {
      setVal(questUI.questActiveCount, '—', 'wp-muted');
      return;
    }
    const actives = quests.filter(q => q.progress < q.target);
    setVal(questUI.questActiveCount, String(actives.length), 'wp-num');
    questUI.questActivesContainer.innerHTML = '';
    if (actives.length === 0) {
      const vide = document.createElement('div');
      vide.style.cssText = 'color:#69e56f;font-size:10px;text-align:center;padding:8px;';
      vide.textContent = '✅ Toutes les quêtes actives sont terminées';
      questUI.questActivesContainer.appendChild(vide);
    } else {
      actives.forEach(q => {
        const pct = Math.round((q.progress / q.target) * 100);
        const statColor = q.stat ? REWARD_COLOR_TO_STAT_REVERSE[q.stat] : '#888';
        const statLabel = q.groupe ? q.groupe.replace('stat:', '') : '—';
        const card = document.createElement('div');
        card.style.cssText = `padding:6px 8px;background:rgba(0,0,0,.25);border-radius:6px;border-left:3px solid ${statColor};`;
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <strong style="color:#f5f5e9;font-size:11px;">${q.enemy}</strong>
            <span style="color:${statColor};font-size:10px;font-weight:900;">${q.progress}/${q.target}</span>
          </div>
          <div style="color:#888;font-size:9px;margin-top:2px;">
            ${q.onMap ? '📍 sur place' : q.mapName} · <span style="color:${statColor};font-weight:900;">${statLabel}</span>
          </div>
          <div style="margin-top:3px;height:4px;background:rgba(255,255,255,.1);border-radius:2px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${statColor};transition:width .3s;"></div>
          </div>
        `;
        questUI.questActivesContainer.appendChild(card);
      });
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  14. NAVIGATION & PORTAILS
  // ═════════════════════════════════════════════════════════════════
  const MAPS_ORDRE = [
    'tutorial_forest', 'beginner_desert', 'intermediate_snowlands', 'advanced_lava_wastes',
    'infernal_depths', 'water_reach', 'samurai_garden', 'cloudspire', 'moonfen',
    'crystal_hollows', 'clockwork_ruins', 'duskfall_orchard', 'neon_bastion',
    'verdant_catacombs', 'ion_citadel'
  ];

  function getMapIndex(mapId) {
    if (!mapId) return -1;
    if (mapId === 'town') return -100;
    if (/^endless_(\d+)$/.test(mapId)) return 15 + parseInt(RegExp.$1, 10);
    return MAPS_ORDRE.indexOf(mapId);
  }

  const MAP_MIDDLE = { x: 2400, y: 2400 };
  const GATEWAY_SPACING = 220;

  function fallbackPortal(mapId, direction) {
    const idx = MAPS_ORDRE.indexOf(mapId);
    if (idx < 0) return null;

    const isLastCampaign = (mapId === 'ion_citadel');
    const hasPrev = idx > 0;
    const hasNext = isLastCampaign || (idx < MAPS_ORDRE.length - 1);
    if (direction === 'prev' && !hasPrev) return null;
    if (direction === 'next' && !hasNext) return null;

    const point = GATEWAY_POINT_NUDGES[mapId] || MAP_MIDDLE;
    const half = (hasPrev && hasNext) ? GATEWAY_SPACING / 2 : 0;
    const x = direction === 'prev' ? point.x - half : point.x + half;
    const useY = point.y - PORTAL_HEIGHT * PORTAL_USE_RATIO;

    return {
      x, useX: x, useY,
      source: 'fallback-reconstructed',
      destination: (isLastCampaign && direction === 'next') ? 'endless_1' : null,
    };
  }

  function appliquerOvershootPortail(portal) {
    if (!portal) return portal;
    return {
      ...portal,
      baseUseY: portal.useY,
      useY: portal.useY + PORTAL_OVERSHOOT_PX,
      overshoot: PORTAL_OVERSHOOT_PX,
    };
  }

  function getPortalTarget(mapId, direction) {
    const real = getRealPortal(mapId, direction);
    if (real) return appliquerOvershootPortail(real);
    const fb = fallbackPortal(mapId, direction);
    if (fb) { pushLog(`⚠️ Fallback ${mapId}/${direction} [${fb.source}]`); return appliquerOvershootPortail(fb); }
    return null;
  }

  function trouverPortailVersCible(mapActuelle, mapCible) {
    const portals = getAllRealPortals(mapActuelle);
    if (!portals || portals.length === 0) {
      const idxA = getMapIndex(mapActuelle);
      const idxC = getMapIndex(mapCible);
      if (idxA >= 0 && idxC >= 0) {
        const direction = idxC > idxA ? 'next' : 'prev';
        const fb = fallbackPortal(mapActuelle, direction);
        if (fb) return { ...fb, direction };
      }
      return null;
    }

    const direct = portals.find(p => p.destination === mapCible);
    if (direct) return { ...direct, direction: direct.x < MAP_MIDDLE.x ? 'prev' : 'next' };

    const idxActuel = getMapIndex(mapActuelle);
    const idxCible = getMapIndex(mapCible);
    if (idxActuel >= 0 && idxCible >= 0) {
      const direction = idxCible > idxActuel ? 'next' : 'prev';
      const target = direction === 'prev' ? portals[0] : portals[portals.length - 1];
      if (target) return { ...target, direction };
    }
    return null;
  }

    async function marcherVersDiag(targetX, targetY, timeoutMs, mapIdDepart) {
    const navEtaitEnCours = navigationEnCours;
    navigationEnCours = true;
    try {
    const c = getCoop();
    const debut = Date.now();
    let dernierePosMarche = null;
    let stuckCount = 0;
    let bestDist = Infinity, bestPos = null;
    let figeeCount = 0;
    let derniereTsVue = 0;

    pushLog(`🚶 Marche vers (${Math.round(targetX)}, ${Math.round(targetY)}) [map=${mapIdDepart ?? '?'}]`);

    while (Date.now() - debut < timeoutMs) {
      if (navAbort) { relacherToutes(); return false; }

      const mapNow = getMapIdActuel();
      if (mapIdDepart && mapNow && mapNow !== mapIdDepart) {
        relacherToutes();
        pushLog(`✅ Map changée pendant la marche: ${mapIdDepart} → ${mapNow}`);
        return true;
      }

      const est = getPositionInterpolee(c);
      if (!est) {
        pushLog(`❌ Position indisponible (minimap), on s'arrête`, 'warn');
        relacherToutes();
        return false;
      }

      if (minimapEstFigee(est)) {
        figeeCount++;
        if (figeeCount === 20 && est.ts !== derniereTsVue) {
          derniereTsVue = est.ts;
          relacherToutes();
          pushLog(`⚠️ Minimap figée (${Math.round((Date.now() - est.ts) / 1000)}s) — touches relâchées, on attend`, 'warn');
        }
        if (figeeCount * 100 > MINIMAP_FROZEN_ABANDON_MS) {
          pushLog(`❌ Minimap figée depuis ${Math.round(MINIMAP_FROZEN_ABANDON_MS / 1000)}s, abandon de la marche`, 'bad');
          return false;
        }
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      figeeCount = 0;

      const dx = targetX - est.x;
      const dy = targetY - est.y;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; bestPos = { x: Math.round(est.x), y: Math.round(est.y) }; }
      const posKey = `${Math.round(est.x)},${Math.round(est.y)}`;
      if (dernierePosMarche === posKey) stuckCount++;
      else { stuckCount = 0; dernierePosMarche = posKey; }

      if (dist < ARRIVAL_THRESHOLD_PX) {
        relacherToutes();
        pushLog(`✅ Arrivé (dist=${Math.round(dist)}px)`);
        return true;
      }

      let touches;
      if (stuckCount > 12) {
        // Simple recoil: pull back one step, then retry forward.
        touches = [];
        if (Math.abs(dx) > Math.abs(dy)) {
          touches.push(dx > 0 ? 'ArrowLeft' : 'ArrowRight');
        } else {
          touches.push(dy > 0 ? 'ArrowUp' : 'ArrowDown');
        }
        stuckCount = 0;
      } else {
        touches = directionVersTouches(Math.atan2(dy, dx));
      }
      envoyerTouches(touches);
      await new Promise(r => setTimeout(r, 100));
    }
        relacherToutes();
    const finalPos = getPositionInterpolee(c);
    pushLog(`⏱️ Timeout — best=${Math.round(bestDist)}px (${bestPos ? `à (${bestPos.x},${bestPos.y})` : 'aucun progrès'}) final=${finalPos ? `(${Math.round(finalPos.x)},${Math.round(finalPos.y)})` : '?'}`);
    return false;
    } finally {
      navigationEnCours = navEtaitEnCours;
    }
  }

  async function allerAuPortail(directionOrOpts) {
    const c = getCoop();
    if (!c?.isConnected?.()) { pushLog('❌ Non connecté'); return { ok: false }; }
    const mapActuelle = getMapIdActuel();
    if (!mapActuelle) { pushLog('❌ Map inconnue'); return { ok: false }; }

    let portal, direction, destinationPredite = null;

    if (typeof directionOrOpts === 'string') {
      direction = directionOrOpts;
      portal = getPortalTarget(mapActuelle, direction);
      destinationPredite = portal?.destination ?? null;
    } else if (directionOrOpts && directionOrOpts.targetMapId) {
      const resolved = trouverPortailVersCible(mapActuelle, directionOrOpts.targetMapId);
      if (!resolved) {
        pushLog(`⚠️ Aucun portail vers ${directionOrOpts.targetMapId} depuis ${mapActuelle}`);
        return { ok: false };
      }
      portal = appliquerOvershootPortail(resolved);
      direction = resolved.direction || 'next';
      destinationPredite = resolved.destination ?? null;
    } else {
      pushLog('❌ allerAuPortail: argument invalide');
      return { ok: false };
    }

    if (!portal) { pushLog(`⚠️ Pas de portail sur ${mapActuelle}`); return { ok: false }; }

    pushLog(`🚪 Portail ${direction} → (${Math.round(portal.useX)}, ${Math.round(portal.useY)})`);

    const kitingEtaitActif = kitingActif;
    const navigationEtaitEnCours = navigationEnCours;
    navigationEnCours = true;
    kitingActif = false;
    relacherToutes();
    orbitActuelle = null;

    let result = { ok: false, newMapId: null, predictedDestination: destinationPredite };

    try {
      const ok = await marcherVersDiag(portal.useX, portal.useY, 25000, mapActuelle);
      if (!ok) {
        pushLog(`❌ Impossible d'atteindre le portail`);
      } else {
        relacherToutes();
        const sArrivee = getMapIdActuel();
        if (sArrivee && sArrivee !== mapActuelle) {
          pushLog(`✅ Traversée détectée: ${mapActuelle} → ${sArrivee}`);
          result = { ok: true, newMapId: sArrivee, predictedDestination: destinationPredite };
        } else {
          const posArrivee = getPositionInterpolee(c);
          const posY = posArrivee?.y ?? (portal.baseUseY ?? portal.useY);
          const pushDir = (portal.baseUseY ?? portal.useY) < posY ? 'ArrowUp' : 'ArrowDown';
          pushLog(`🚪 Push ${pushDir}...`);
          await pushDirectionnel(pushDir, PUSH_DURATION_MS);
          await new Promise(r => setTimeout(r, 300));

          const mapAfterPush = getMapIdActuel();
          if (mapAfterPush && mapAfterPush !== mapActuelle) {
            pushLog(`✅ Map changée après push: ${mapActuelle} → ${mapAfterPush}`);
            result = { ok: true, newMapId: mapAfterPush, predictedDestination: destinationPredite };
          } else {
            pushLog(`🚪 Attente passive...`);
            const waitStart = Date.now();
            const mapNameBefore = document.getElementById('minimapMapName')?.textContent?.trim() || '';
            while (Date.now() - waitStart < 10000) {
              await new Promise(r => setTimeout(r, 200));
              const mapNameNow = document.getElementById('minimapMapName')?.textContent?.trim() || '';
              if (mapNameNow && mapNameBefore && mapNameNow !== mapNameBefore) {
                pushLog(`✅ Transition DOM: "${mapNameBefore}" → "${mapNameNow}"`);
                result = { ok: true, newMapId: mapNameToMapId(mapNameNow), mapName: mapNameNow, predictedDestination: destinationPredite };
                break;
              }
              const currentMap = getMapIdActuel();
              if (currentMap && currentMap !== mapActuelle) {
                pushLog(`✅ Transition localState: ${mapActuelle} → ${currentMap}`);
                result = { ok: true, newMapId: currentMap, predictedDestination: destinationPredite };
                break;
              }
            }
            if (!result.ok) pushLog(`⚠️ Timeout 10s sans transition`);
          }
        }
      }
    } catch (e) {
      pushLog(`❌ Erreur portail : ${e.message}`);
    } finally {
      if (kitingEtaitActif) kitingActif = true;
      navigationEnCours = navigationEtaitEnCours;
    }
    return result;
  }

  // ═════════════════════════════════════════════════════════════════
  //  15. AUTO-FARM QUÊTES
  // ═════════════════════════════════════════════════════════════════

  function logAutoFarm(msg, cls = 'info') {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    autoFarmQuestLogs.push({ ts, msg, cls });
    if (autoFarmQuestLogs.length > 50) autoFarmQuestLogs.shift();
    pushLog(`🤖 ${msg}`);
  }

  const REWARD_COLOR_TO_STAT = {
    'rgb(255, 101, 90)':  'damage',
    'rgb(102, 237, 121)': 'health',
    'rgb(255, 224, 93)':  'speed',
    'rgb(116, 216, 255)': 'armor',
    'rgb(255, 124, 203)': 'regen',
    'rgb(255, 154, 77)':  'crit',
  };

  const REWARD_COLOR_TO_STAT_REVERSE = {
    'damage': 'rgb(255, 101, 90)',
    'health': 'rgb(102, 237, 121)',
    'speed':  'rgb(255, 224, 93)',
    'armor':  'rgb(116, 216, 255)',
    'regen':  'rgb(255, 124, 203)',
    'crit':   'rgb(255, 154, 77)',
  };

  const REWARD_LABEL_TO_STAT = {
    'damage': 'damage',
    'max health': 'health',
    'health': 'health',
    'attack speed': 'speed',
    'speed': 'speed',
    'armor': 'armor',
    'hp/sec': 'regen',
    'regen': 'regen',
    'crit damage': 'crit',
    'crit': 'crit',
  };

  function statDepuisTracker(item) {
    const statEl = item.querySelector('.quest-tracker-stat');
    if (!statEl) return null;
    const color = statEl.style.color;
    if (REWARD_COLOR_TO_STAT[color]) return REWARD_COLOR_TO_STAT[color];
    const label = (statEl.textContent || '').toLowerCase().trim();
    for (const [text, stat] of Object.entries(REWARD_LABEL_TO_STAT)) {
      if (label.includes(text)) return stat;
    }
    return null;
  }

  function lireQuetesDepuisTracker() {
    const items = document.querySelectorAll('.quest-tracker .quest-tracker-item');
    if (items.length === 0) return null;

    const quests = [];
    for (const item of items) {
      const enemy = item.querySelector('.quest-tracker-enemy')?.textContent?.trim();
      if (!enemy) continue;

      const countText = item.querySelector('.quest-tracker-count')?.textContent || '';
      const m = countText.match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) continue;

      const stat = statDepuisTracker(item);
      const whereText = item.querySelector('.quest-tracker-where')?.textContent?.trim() || '';
      const mapName = whereText.split(/[·]/)[0].split(' - ')[0].trim();
      const onMap = item.classList.contains('is-here');

      quests.push({
        enemy,
        stat,
        progress: parseInt(m[1], 10),
        target: parseInt(m[2], 10),
        mapName,
        onMap,
        groupe: stat ? `stat:${stat}` : null,
      });
    }
    return quests;
  }

  // ═════════════════════════════════════════════════════════════════
  //  15.5. QUÊTES DE GUILDE
  // ═════════════════════════════════════════════════════════════════

  function etatQuetesApi() {
    try {
      const c = getCoop();
      const data = c?.dailyQuests?.();
      if (!data || !Array.isArray(data.quests)) return null;
      const perso = data.quests.filter(q => !q.from);
      const collected = data.quests.filter(q => q.from);
      const persoNonReglees = perso.filter(q => !(q.progress >= q.target) && !q.takenBy);
      return {
        total: data.quests.length,
        perso: perso.length,
        persoDone: perso.filter(q => q.progress >= q.target).length,
        persoTakenBy: perso.filter(q => q.takenBy && q.progress < q.target).length,
        persoNonReglees: persoNonReglees.length,
        collected: collected.length,
        collectedDone: collected.filter(q => q.progress >= q.target).length,
        guildName: data.guildName || null,
        bonus: data.bonus ?? 1,
      };
    } catch (e) { return null; }
  }

  function peutCollecterQuetesGuilde() {
    const etat = etatQuetesApi();
    if (!etat) return { peut: false, raison: 'dailyQuests() indisponible (hydratation ?)' };
    if (!etat.guildName) return { peut: false, raison: 'pas dans une guilde' };
    if (etat.perso === 0) return { peut: false, raison: 'aucune quête perso (semaine pas tirée ?)' };
    if (etat.persoNonReglees > 0) return { peut: false, raison: `${etat.persoNonReglees} perso non terminée(s)` };
    if (etat.collected >= 15) return { peut: false, raison: `limite de 15 quêtes de guilde atteinte (${etat.collected}/15)` };
    return { peut: true, dejaCollectees: etat.collected };
  }

  async function collecterQuetesGuilde() {
    const c = getCoop();
    const identity = c?.localIdentity?.();
    if (!identity) return { ok: false, raison: 'localIdentity() indisponible' };
    if (typeof c?.guild?.guildAction !== 'function') return { ok: false, raison: 'guild.guildAction indisponible' };
    logAutoFarm(`📥 Collecte quêtes de guilde (${identity.slice(0, 8)}…)`, 'info');
    try {
      await c.guild.guildAction({ kind: 'collectQuests', identity });
      logAutoFarm('✅ Collecte quêtes de guilde OK', 'ok');
      return { ok: true };
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      logAutoFarm(`❌ Collecte refusée : ${msg}`, 'bad');
      return { ok: false, raison: msg };
    }
  }

  // ═════════════════════════════════════════════════════════════════

  async function desactiverAutoFarmPanel() {
    const sheet = document.getElementById('autoFarmSheet');
    if (!sheet) return false;

    const content = sheet.querySelector('#autoFarmContent');
    const wasHidden = content?.hidden;
    if (wasHidden) {
      sheet.querySelector('.farm-toggle')?.click();
      await new Promise(r => setTimeout(r, 300));
    }

    const advanceSwitch = sheet.querySelector('[data-switch="advance"]');
    if (advanceSwitch && advanceSwitch.getAttribute('aria-checked') === 'true') {
      advanceSwitch.click();
      pushLog('🛑 Move On désactivé (évite conflit navigation)');
      await new Promise(r => setTimeout(r, 200));
    }

    const closeBtn = sheet.querySelector('.farm-close');
    if (closeBtn && /stop/i.test(closeBtn.textContent || '')) {
      closeBtn.click();
      await new Promise(r => setTimeout(r, 500));
    }

    const rows = sheet.querySelectorAll('[data-group]');
    for (const row of rows) {
      const offBtn = row.querySelector('[data-mode="off"]');
      if (offBtn && offBtn.getAttribute('aria-checked') !== 'true') {
        offBtn.click();
        await new Promise(r => setTimeout(r, 20));
      }
    }

    if (wasHidden && content && !content.hidden) {
      sheet.querySelector('.farm-toggle')?.click();
      await new Promise(r => setTimeout(r, 100));
    }

    return true;
  }

  async function voyagerVersMap(targetMapId) {
    let currentMap = getMapIdActuel();
    if (currentMap === targetMapId) return true;
    let guard = 0;
    while (currentMap !== targetMapId && guard < 30) {
      guard++;
      if (navAbort) return false;
      const resolved = trouverPortailVersCible(currentMap, targetMapId);
      if (!resolved) {
        logAutoFarm(`❌ Aucun portail vers ${targetMapId} depuis ${currentMap}`, 'bad');
        return false;
      }
      logAutoFarm(`🚪 Portail ${resolved.direction} (${currentMap} → ${targetMapId}) [dest=${resolved.destination ?? '?'}]`);
      const result = await allerAuPortail({ targetMapId });
      if (!result || !result.ok) {
        logAutoFarm(`❌ Portail échoué (${currentMap} → ${targetMapId})`, 'bad');
        return false;
      }
      if (result.newMapId) {
        currentMap = result.newMapId;
        logAutoFarm(`✅ Map après portail: ${currentMap}`);
      } else {
        await new Promise(r => setTimeout(r, 2000));
        currentMap = getMapIdActuel();
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (currentMap !== targetMapId) {
      logAutoFarm(`❌ Voyage inachevé: ${currentMap} ≠ ${targetMapId}`, 'bad');
      return false;
    }
    return true;
  }

  async function autoFarmQuestRoutine() {
    if (autoFarmQuestEnCours) return;
    autoFarmQuestEnCours = true;
    navAbort = false;
    autoFarmQuestLogs = [];
    logAutoFarm(`Démarrage auto-farm quêtes (v${VERSION})`);

    try {
      const etatInit = etatQuetesApi();
      if (etatInit) {
        logAutoFarm(`📊 État : ${etatInit.persoDone}/${etatInit.perso} perso, ${etatInit.collected}/15 collectées, guilde=${etatInit.guildName ?? '—'}`, 'info');
      } else {
        logAutoFarm('⚠️ dailyQuests() pas encore hydraté', 'warn');
      }

      logAutoFarm('🛑 Désactivation auto-farm natif + Move On', 'info');
      await desactiverAutoFarmPanel();
      await new Promise(r => setTimeout(r, 500));

      let iterations = 0;
      const MAX_ITER = 20;

      while (iterations < MAX_ITER && autoFarmQuestActif) {
        iterations++;

        const mapActuelle = getMapIdActuel();
        const questsTracker = lireQuetesDepuisTracker();
        if (!questsTracker || questsTracker.length === 0) {
          logAutoFarm('⏳ Tracker vide (attendre chargement)', 'warn');
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const idxActuel = getMapIndex(mapActuelle);
        const cibles = questsTracker
          .filter(q => q.progress < q.target && q.groupe)
          .map(q => {
            const targetMapId = mapNameToMapId(q.mapName);
            const targetIdx = getMapIndex(targetMapId);
            const distance = (idxActuel >= 0 && targetIdx >= 0) ? Math.abs(targetIdx - idxActuel) : 999;
            return { ...q, targetMapId, targetIdx, distance };
          })
          .sort((a, b) => {
            if (a.onMap !== b.onMap) return a.onMap ? -1 : 1;
            return a.distance - b.distance;
          });

        if (cibles.length === 0) {
          const check = peutCollecterQuetesGuilde();
          if (check.peut) {
            logAutoFarm(`🎁 15 perso réglées — collecte guilde (${check.dejaCollectees}/15 déjà collectées)`, 'info');
            const res = await collecterQuetesGuilde();
            if (res.ok) {
              logAutoFarm('⏳ Attente propagation des nouvelles quêtes…', 'info');
              await new Promise(r => setTimeout(r, 2500));
              continue;
            }
            logAutoFarm(`⏹️ Arrêt : collecte refusée (${res.raison})`, 'warn');
            break;
          }
          logAutoFarm(`ℹ️ Pas de collecte : ${check.raison}`, 'info');
          logAutoFarm('✅ Aucune quête active avec camp connu', 'ok');
          break;
        }

        logAutoFarm(`📋 ${cibles.length} cible(s) : ${cibles.map(c => `${c.enemy}@${c.mapName || 'sur place'}(d=${c.onMap ? 0 : c.distance})`).join(', ')}`, 'info');

        const cible = cibles[0];
        logAutoFarm(`🎯 ${cible.enemy} (${cible.progress}/${cible.target}) → ${cible.groupe}`, 'info');

        if (!cible.onMap && cible.targetMapId && cible.targetMapId !== mapActuelle) {
          const targetMapId = cible.targetMapId;
          await desactiverAutoFarmPanel();
          await new Promise(r => setTimeout(r, 300));
          logAutoFarm(`🚶 Voyage ${mapActuelle} → ${targetMapId}`, 'info');
          const ok = await voyagerVersMap(targetMapId);
          if (!ok) { logAutoFarm('❌ Voyage échoué', 'bad'); break; }
          await new Promise(r => setTimeout(r, 1000));
        }

        const aggroOk = await activerAggroSurGroupe(cible.groupe);
        if (!aggroOk) logAutoFarm('⚠️ Aggro non activé, on tente quand même', 'bad');

        logAutoFarm('⚔️ Farm en cours (max 60s)...');
        const debutFarm = Date.now();
        let derniereProgress = cible.progress;
        let progressThisIteration = false;

        while (Date.now() - debutFarm < 60000 && autoFarmQuestActif) {
          await new Promise(r => setTimeout(r, 3000));
          const questsMaj = lireQuetesDepuisTracker();
          if (!questsMaj) break;
          const q = questsMaj.find(x => x.enemy === cible.enemy);
          if (!q) { logAutoFarm(`✅ Quête ${cible.enemy} disparue`, 'ok'); progressThisIteration = true; break; }
          if (q.progress > derniereProgress) {
            derniereProgress = q.progress;
            progressThisIteration = true;
            logAutoFarm(`📈 ${q.progress}/${q.target}`);
          }
          if (q.progress >= q.target) {
            logAutoFarm(`✅ Quête ${cible.enemy} terminée !`, 'ok');
            break;
          }
        }

        if (!progressThisIteration) logAutoFarm('⚠️ Aucune progression en 60s', 'warn');
        logAutoFarm(`🔄 Itération ${iterations + 1}`);
        await new Promise(r => setTimeout(r, 1000));
      }
      logAutoFarm(`🏁 Routine terminée (${iterations} itérations)`, 'ok');
    } catch (e) {
      logAutoFarm(`❌ Erreur: ${e.message}`, 'bad');
    } finally {
      autoFarmQuestEnCours = false;
      await desactiverAutoFarmPanel().catch(() => {});
    }
  }

  async function activerAggroSurGroupe(groupeCible) {
    const sheet = document.getElementById('autoFarmSheet');
    if (!sheet) {
      logAutoFarm('❌ Panneau Auto Farm introuvable', 'bad');
      return false;
    }

    const content = sheet.querySelector('#autoFarmContent');
    let weOpenedIt = false;
    if (content?.hidden) {
      const toggle = sheet.querySelector('.farm-toggle');
      if (toggle) {
        toggle.click();
        weOpenedIt = true;
        await new Promise(r => setTimeout(r, 400));
      }
    }

    let rows = sheet.querySelectorAll('[data-group]');
    const t0 = Date.now();
    while (rows.length === 0 && Date.now() - t0 < 3000) {
      await new Promise(r => setTimeout(r, 200));
      rows = sheet.querySelectorAll('[data-group]');
    }

    if (rows.length === 0) {
      logAutoFarm('❌ Aucun groupe dans le panneau', 'bad');
      if (weOpenedIt) sheet.querySelector('.farm-toggle')?.click();
      return false;
    }

    let found = false;
    for (const row of rows) if (row.dataset.group === groupeCible) { found = true; break; }
    if (!found) {
      const dispo = Array.from(rows).map(r => r.dataset.group).join(', ');
      logAutoFarm(`❌ Groupe "${groupeCible}" introuvable. Dispo: ${dispo}`, 'bad');
      if (weOpenedIt) sheet.querySelector('.farm-toggle')?.click();
      return false;
    }

    for (const row of rows) {
      const targetMode = (row.dataset.group === groupeCible) ? 'aggro' : 'off';
      const btn = row.querySelector(`[data-mode="${targetMode}"]`);
      if (btn && btn.getAttribute('aria-checked') !== 'true') {
        btn.click();
        await new Promise(r => setTimeout(r, 30));
      }
    }

    const startBtn = sheet.querySelector('.farm-start');
    if (startBtn && !startBtn.disabled) {
      startBtn.click();
      await new Promise(r => setTimeout(r, 500));
    } else if (startBtn?.disabled) {
      const reason = sheet.querySelector('.farm-selection')?.textContent || '';
      logAutoFarm(`⚠️ Bouton Start disabled${reason ? ` (${reason})` : ''}`, 'bad');
    }

    if (weOpenedIt && content && !content.hidden) {
      sheet.querySelector('.farm-toggle')?.click();
      await new Promise(r => setTimeout(r, 150));
    }

    logAutoFarm(`✅ Aggro ${groupeCible} activé`, 'ok');
    return true;
  }

  // ═════════════════════════════════════════════════════════════════
  //  Mapping mob → groupe stat
  // ═════════════════════════════════════════════════════════════════
  const ENEMY_REWARD_STAT = {
    'Bramble': 'health', 'Needle': 'speed', 'Mossback': 'armor', 'Spitter': 'damage',
    'Brood': 'regen', 'Cindermaw': 'damage', 'King Slime': 'health', 'Dread Warden': 'damage',
    'Striker': 'crit',
    'Dune Raider': 'damage', 'Dune Archer': 'health', 'Dune Regent': 'health',
    'Venom Guard': 'armor', 'Wastes Reaper': 'damage', 'Blight Oracle': 'regen',
    'Dune Needle': 'speed', 'Dune Striker': 'crit',
    'Frost Raider': 'damage', 'Glacier Archer': 'health', 'Glacier Regent': 'health',
    'Rime Guard': 'armor', 'Whiteout Reaper': 'damage', 'Aurora Oracle': 'regen',
    'Frost Needle': 'speed', 'Frost Striker': 'crit',
    'Ember Raider': 'damage', 'Cinder Archer': 'health', 'Cinder Regent': 'health',
    'Magma Guard': 'armor', 'Ash Reaper': 'damage', 'Inferno Oracle': 'regen',
    'Cinder Needle': 'speed', 'Cinder Striker': 'crit',
    'Depth Raider': 'damage', 'Abyss Archer': 'health', 'Abyss Regent': 'health',
    'Obsidian Colossus': 'armor', 'Doom Reaper': 'damage', 'Nether Oracle': 'regen',
    'Abyss Needle': 'speed', 'Abyss Striker': 'crit',
    'Tide Raider': 'damage', 'Reef Archer': 'health', 'Reef Regent': 'health',
    'Coral Colossus': 'armor', 'Drowned Reaper': 'damage', 'Tidal Oracle': 'regen',
    'Reef Needle': 'speed', 'Reef Striker': 'crit',
    'Sakura Ronin': 'damage', 'Petal Archer': 'health', 'Petal Regent': 'health',
    'Bamboo Guardian': 'armor', 'Moonblade Reaper': 'damage', 'Shrine Oracle': 'regen',
    'Petal Needle': 'speed', 'Petal Striker': 'crit',
    'Gale Prowler': 'damage', 'Nimbus Archer': 'health', 'Nimbus Regent': 'health',
    'Skyguard Colossus': 'armor', 'Thunder Reaper': 'damage', 'Tempest Oracle': 'regen',
    'Gale Needle': 'speed', 'Gale Striker': 'crit',
    'Fen Prowler': 'damage', 'Glowcap Archer': 'health', 'Glowcap Regent': 'health',
    'Bog Colossus': 'armor', 'Moonmire Reaper': 'damage', 'Wisp Oracle': 'regen',
    'Fen Needle': 'speed', 'Fen Striker': 'crit',
    'Shard Hopper': 'damage', 'Crystal Spitter': 'health', 'Crystal Regent': 'health',
    'Geode Guardian': 'armor', 'Prism Reaver': 'damage', 'Hollow Oracle': 'regen',
    'Shard Needle': 'speed', 'Shard Striker': 'crit',
    'Gear Prowler': 'damage', 'Rivet Spitter': 'health', 'Gear Regent': 'health',
    'Iron Guardian': 'armor', 'Scrap Reaver': 'damage', 'Spark Oracle': 'regen',
    'Gear Needle': 'speed', 'Gear Striker': 'crit',
    'Gourd Prowler': 'damage', 'Seed Spitter': 'health', 'Harvest Regent': 'health',
    'Husk Guardian': 'armor', 'Thorn Reaver': 'damage', 'Harvest Oracle': 'regen',
    'Gourd Needle': 'speed', 'Gourd Striker': 'crit',
    'Circuit Prowler': 'damage', 'Pulse Spitter': 'health', 'Voltage Regent': 'health',
    'Relay Guardian': 'armor', 'Arc Reaver': 'damage', 'Signal Oracle': 'regen',
    'Circuit Needle': 'speed', 'Circuit Striker': 'crit',
    'Mossbound Stalker': 'damage', 'Spore Slinger': 'health', 'Mycelial Regent': 'health',
    'Ossuary Guardian': 'armor', 'Briar Reaver': 'damage', 'Crypt Oracle': 'regen',
    'Moss Needle': 'speed', 'Moss Striker': 'crit',
    'Ion Patrol': 'damage', 'Capacitor Gunner': 'health', 'Citadel Marshal': 'health',
    'Bastion Defender': 'armor', 'Flux Enforcer': 'damage', 'Reactor Warden': 'regen',
    'Ion Needle': 'speed', 'Ion Striker': 'crit',
  };

  const ARENA_CENTRE = { x: 4050, y: 4050 };
  const BOSS_POSITIONS = {
    tutorial_forest: { x: 4040, y: 4240 },
    beginner_desert: ARENA_CENTRE,
    intermediate_snowlands: ARENA_CENTRE,
    advanced_lava_wastes: ARENA_CENTRE,
    infernal_depths: ARENA_CENTRE,
    water_reach: ARENA_CENTRE,
    samurai_garden: ARENA_CENTRE,
    cloudspire: ARENA_CENTRE,
    moonfen: ARENA_CENTRE,
    crystal_hollows: ARENA_CENTRE,
    clockwork_ruins: ARENA_CENTRE,
    duskfall_orchard: ARENA_CENTRE,
    neon_bastion: ARENA_CENTRE,
    verdant_catacombs: ARENA_CENTRE,
    ion_citadel: ARENA_CENTRE,
  };

  const BOSS_HITBOXES = {
    tutorial_forest: { r: 85, vr: 115, offsetY: 17 },
    beginner_desert: { r: 146, vr: 103, offsetY: -43 },
    intermediate_snowlands: { r: 150, vr: 191, offsetY: 24 },
    advanced_lava_wastes: { r: 171, vr: 126, offsetY: 51 },
    infernal_depths: { r: 137, vr: 154, offsetY: 29 },
    water_reach: { r: 197, vr: 119, offsetY: 6 },
    samurai_garden: { r: 103, vr: 116, offsetY: -13 },
    cloudspire: { r: 136, vr: 139, offsetY: 42 },
    moonfen: { r: 119, vr: 95, offsetY: 63 },
    crystal_hollows: { r: 147, vr: 144, offsetY: 29 },
    clockwork_ruins: { r: 170, vr: 170, offsetY: 0 },
    duskfall_orchard: { r: 170, vr: 170, offsetY: 0 },
    neon_bastion: { r: 173, vr: 173, offsetY: 13 },
    verdant_catacombs: { r: 170, vr: 170, offsetY: 0 },
    ion_citadel: { r: 170, vr: 170, offsetY: 0 },
  };

  function getBossPosition(mapId) { return BOSS_POSITIONS[mapId] || ARENA_CENTRE; }

  function getMaxAggro() {
    const c = getCoop();
    if (!c) return 1;
    try {
      const agg = c.aggroChallenge?.();
      if (agg?.active) return 0;
      return Math.min(5, 1 + (agg?.completed ?? 0));
    } catch (e) {
      return 1;
    }
  }

  function getMaxAggroEffective() {
    const manual = parseInt(localStorage.getItem('wildpote_maxaggro_manual') || '0', 10);
    if (manual >= 1 && manual <= 5) return manual;
    return getMaxAggro();
  }

  function groupeDeEnemy(enemy) {
    const stat = ENEMY_REWARD_STAT[enemy];
    return stat ? `stat:${stat}` : null;
  }

  // ═════════════════════════════════════════════════════════════════
  //  15.7. TARGET CARDS
  // ═════════════════════════════════════════════════════════════════
  const CARD_DB = {
    bramble_card:       { enemy: 'Bramble', map: 'tutorial_forest', rarity: 'regular', slot: 'CHEST', desc: '+1.5% reflect' },
    needle_card:        { enemy: 'Needle', map: 'tutorial_forest', rarity: 'regular', slot: 'HAND', desc: '+1% dbl strike' },
    mossback_card:      { enemy: 'Mossback', map: 'tutorial_forest', rarity: 'regular', slot: 'CHEST', desc: '+3% armor' },
    spitter_card:       { enemy: 'Spitter', map: 'tutorial_forest', rarity: 'regular', slot: 'HAND', desc: '+2% atk' },
    brood_card:         { enemy: 'Brood', map: 'tutorial_forest', rarity: 'regular', slot: 'HEAD', desc: '+4% regen' },
    cindermaw_card:     { enemy: 'Cindermaw', map: 'tutorial_forest', rarity: 'regular', slot: 'HAND', desc: '+3% burn' },
    king_slime_card:    { enemy: 'King Slime', map: 'tutorial_forest', rarity: 'elite', slot: 'CHEST', desc: '+3.1% hp, +0.26% sw' },
    dread_warden_card:  { enemy: 'Dread Warden', map: 'tutorial_forest', rarity: 'elite', slot: 'HAND', desc: '+9% elite slay' },
    striker_card:       { enemy: 'Striker', map: 'tutorial_forest', rarity: 'regular', slot: 'HEAD', desc: '+1% crit' },
    dragon_card:        { enemy: 'Dragon', map: 'tutorial_forest', rarity: 'boss', slot: 'HAND', desc: '+25% splash' },
    dune_raider_card:   { enemy: 'Dune Raider', map: 'beginner_desert', rarity: 'regular', slot: 'HAND', desc: '+9% map slay' },
    dune_archer_card:   { enemy: 'Dune Archer', map: 'beginner_desert', rarity: 'regular', slot: 'HEAD', desc: '+2% long shot' },
    dune_regent_card:   { enemy: 'Dune Regent', map: 'beginner_desert', rarity: 'elite', slot: 'CHEST', desc: '+9% map guard, +3.4% hp' },
    venom_guard_card:   { enemy: 'Venom Guard', map: 'beginner_desert', rarity: 'regular', slot: 'HAND', desc: '+3.2% poison' },
    wastes_reaper_card: { enemy: 'Wastes Reaper', map: 'beginner_desert', rarity: 'elite', slot: 'HAND', desc: '+13% execute' },
    blight_oracle_card: { enemy: 'Blight Oracle', map: 'beginner_desert', rarity: 'elite', slot: 'HEAD', desc: '+3% respawn' },
    dune_needle_card:   { enemy: 'Dune Needle', map: 'beginner_desert', rarity: 'regular', slot: 'HAND', desc: '+0.05 atk/s' },
    dune_striker_card:  { enemy: 'Dune Striker', map: 'beginner_desert', rarity: 'regular', slot: 'HAND', desc: '+6% crit dmg' },
    desert_spider_card: { enemy: 'Desert Spider', map: 'beginner_desert', rarity: 'boss', slot: 'CHEST', desc: '+40% web, +6% hp' },
    frost_raider_card:      { enemy: 'Frost Raider', map: 'intermediate_snowlands', rarity: 'regular', slot: 'HAND', desc: '+4.6% chill' },
    glacier_archer_card:    { enemy: 'Glacier Archer', map: 'intermediate_snowlands', rarity: 'regular', slot: 'CHEST', desc: '+6% ranged guard' },
    glacier_regent_card:    { enemy: 'Glacier Regent', map: 'intermediate_snowlands', rarity: 'elite', slot: 'CHEST', desc: '+5% shield' },
    rime_guard_card:        { enemy: 'Rime Guard', map: 'intermediate_snowlands', rarity: 'regular', slot: 'CHEST', desc: '+6.9% armor, -5% regen' },
    whiteout_reaper_card:   { enemy: 'Whiteout Reaper', map: 'intermediate_snowlands', rarity: 'elite', slot: 'HAND', desc: '+1.7% stun' },
    aurora_oracle_card:     { enemy: 'Aurora Oracle', map: 'intermediate_snowlands', rarity: 'elite', slot: 'HEAD', desc: '+1.7% all gain' },
    frost_needle_card:      { enemy: 'Frost Needle', map: 'intermediate_snowlands', rarity: 'regular', slot: 'HAND', desc: '+1.1% arrow storm' },
    frost_striker_card:     { enemy: 'Frost Striker', map: 'intermediate_snowlands', rarity: 'regular', slot: 'HEAD', desc: '+1.1% crit' },
    frostclaw_card:         { enemy: 'Frostclaw', map: 'intermediate_snowlands', rarity: 'boss', slot: 'HAND', desc: '+12% stun 1.5s' },
    ember_raider_card:      { enemy: 'Ember Raider', map: 'advanced_lava_wastes', rarity: 'regular', slot: 'HAND', desc: '+4.9% atk, -3.6% hp' },
    cinder_archer_card:     { enemy: 'Cinder Archer', map: 'advanced_lava_wastes', rarity: 'regular', slot: 'HAND', desc: '+3.6% burn' },
    cinder_regent_card:     { enemy: 'Cinder Regent', map: 'advanced_lava_wastes', rarity: 'elite', slot: 'CHEST', desc: '+3.8% hp, +5% melee guard' },
    magma_guard_card:       { enemy: 'Magma Guard', map: 'advanced_lava_wastes', rarity: 'regular', slot: 'CHEST', desc: '+10% map guard' },
    ash_reaper_card:        { enemy: 'Ash Reaper', map: 'advanced_lava_wastes', rarity: 'elite', slot: 'HAND', desc: '+11% berserk' },
    inferno_oracle_card:    { enemy: 'Inferno Oracle', map: 'advanced_lava_wastes', rarity: 'elite', slot: 'CHEST', desc: '+9% panic heal' },
    cinder_needle_card:     { enemy: 'Cinder Needle', map: 'advanced_lava_wastes', rarity: 'regular', slot: 'HAND', desc: '+1.2% dbl strike' },
    cinder_striker_card:    { enemy: 'Cinder Striker', map: 'advanced_lava_wastes', rarity: 'regular', slot: 'HAND', desc: '+10% opener' },
    magmalisk_card:         { enemy: 'Magmalisk', map: 'advanced_lava_wastes', rarity: 'boss', slot: 'HAND', desc: '+100% burn, +6% atk' },
    depth_raider_card:      { enemy: 'Depth Raider', map: 'infernal_depths', rarity: 'regular', slot: 'HAND', desc: '+10% map slay' },
    abyss_archer_card:      { enemy: 'Abyss Archer', map: 'infernal_depths', rarity: 'regular', slot: 'HAND', desc: '+0.64% lifesteal' },
    abyss_regent_card:      { enemy: 'Abyss Regent', map: 'infernal_depths', rarity: 'elite', slot: 'CHEST', desc: '+4% hp, +0.34% sw' },
    obsidian_colossus_card: { enemy: 'Obsidian Colossus', map: 'infernal_depths', rarity: 'regular', slot: 'CHEST', desc: '+3.9% armor' },
    doom_reaper_card:       { enemy: 'Doom Reaper', map: 'infernal_depths', rarity: 'elite', slot: 'HAND', desc: '+4% boss slay, +11% execute' },
    nether_oracle_card:     { enemy: 'Nether Oracle', map: 'infernal_depths', rarity: 'elite', slot: 'HEAD', desc: '+10% card hunter' },
    abyss_needle_card:      { enemy: 'Abyss Needle', map: 'infernal_depths', rarity: 'regular', slot: 'HAND', desc: '+3.9% weaken' },
    abyss_striker_card:     { enemy: 'Abyss Striker', map: 'infernal_depths', rarity: 'regular', slot: 'HEAD', desc: '+0.9% crit, +0.9% fleet' },
    gloomroot_card:         { enemy: 'Gloomroot', map: 'infernal_depths', rarity: 'boss', slot: 'CHEST', desc: '+50% last stand' },
    tide_raider_card:       { enemy: 'Tide Raider', map: 'water_reach', rarity: 'regular', slot: 'HAND', desc: '+5.4% knockback' },
    reef_archer_card:       { enemy: 'Reef Archer', map: 'water_reach', rarity: 'regular', slot: 'HEAD', desc: '+3% long shot' },
    reef_regent_card:       { enemy: 'Reef Regent', map: 'water_reach', rarity: 'elite', slot: 'CHEST', desc: '+4% shield, +6% regen' },
    coral_colossus_card:    { enemy: 'Coral Colossus', map: 'water_reach', rarity: 'regular', slot: 'CHEST', desc: '+2% reflect' },
    drowned_reaper_card:    { enemy: 'Drowned Reaper', map: 'water_reach', rarity: 'elite', slot: 'HAND', desc: '+1.02% lifesteal' },
    tidal_oracle_card:      { enemy: 'Tidal Oracle', map: 'water_reach', rarity: 'elite', slot: 'HEAD', desc: '+1.4% fleet, +2.8% hp gain' },
    reef_needle_card:       { enemy: 'Reef Needle', map: 'water_reach', rarity: 'regular', slot: 'HAND', desc: '+1.4% ricochet' },
    reef_striker_card:      { enemy: 'Reef Striker', map: 'water_reach', rarity: 'regular', slot: 'HAND', desc: '+8% crit dmg' },
    tidewyrm_card:          { enemy: 'Tidewyrm', map: 'water_reach', rarity: 'boss', slot: 'HAND', desc: '+60% splash' },
    sakura_ronin_card:      { enemy: 'Sakura Ronin', map: 'samurai_garden', rarity: 'regular', slot: 'HAND', desc: '+1% dbl, +1% crit' },
    petal_archer_card:      { enemy: 'Petal Archer', map: 'samurai_garden', rarity: 'regular', slot: 'HEAD', desc: '+1.4% crit' },
    petal_regent_card:      { enemy: 'Petal Regent', map: 'samurai_garden', rarity: 'elite', slot: 'CHEST', desc: '+2.1% dodge' },
    bamboo_guardian_card:   { enemy: 'Bamboo Guardian', map: 'samurai_garden', rarity: 'regular', slot: 'CHEST', desc: '+6% melee guard' },
    moonblade_reaper_card:  { enemy: 'Moonblade Reaper', map: 'samurai_garden', rarity: 'elite', slot: 'HAND', desc: '+9% crit dmg, +12% execute' },
    shrine_oracle_card:     { enemy: 'Shrine Oracle', map: 'samurai_garden', rarity: 'elite', slot: 'HEAD', desc: '+6% treasure' },
    petal_needle_card:      { enemy: 'Petal Needle', map: 'samurai_garden', rarity: 'regular', slot: 'HAND', desc: '+1.4% piercing' },
    petal_striker_card:     { enemy: 'Petal Striker', map: 'samurai_garden', rarity: 'regular', slot: 'HAND', desc: '+11% opener' },
    koi_shogun_card:        { enemy: 'Koi Shogun', map: 'samurai_garden', rarity: 'boss', slot: 'HAND', desc: 'iaido on, +15% crit dmg' },
    gale_prowler_card:      { enemy: 'Gale Prowler', map: 'cloudspire', rarity: 'regular', slot: 'HAND', desc: '+1.5% momentum' },
    nimbus_archer_card:     { enemy: 'Nimbus Archer', map: 'cloudspire', rarity: 'regular', slot: 'HAND', desc: '+9% ranged slay' },
    nimbus_regent_card:     { enemy: 'Nimbus Regent', map: 'cloudspire', rarity: 'elite', slot: 'CHEST', desc: '+1.6% dodge, +4.7% hp' },
    skyguard_colossus_card: { enemy: 'Skyguard Colossus', map: 'cloudspire', rarity: 'regular', slot: 'CHEST', desc: '+8% ranged guard' },
    thunder_reaper_card:    { enemy: 'Thunder Reaper', map: 'cloudspire', rarity: 'elite', slot: 'HAND', desc: '+4.5% chain' },
    tempest_oracle_card:    { enemy: 'Tempest Oracle', map: 'cloudspire', rarity: 'elite', slot: 'HEAD', desc: '+2.2% fleet' },
    gale_needle_card:       { enemy: 'Gale Needle', map: 'cloudspire', rarity: 'regular', slot: 'HAND', desc: '+0.08 atk/s' },
    gale_striker_card:      { enemy: 'Gale Striker', map: 'cloudspire', rarity: 'regular', slot: 'HEAD', desc: '+1.5% crit' },
    tempest_kirin_card:     { enemy: 'Tempest Kirin', map: 'cloudspire', rarity: 'boss', slot: 'HEAD', desc: '+12% fleet, +0.2 atk/s' },
    fen_prowler_card:       { enemy: 'Fen Prowler', map: 'moonfen', rarity: 'regular', slot: 'HAND', desc: '+13% map slay' },
    glowcap_archer_card:    { enemy: 'Glowcap Archer', map: 'moonfen', rarity: 'regular', slot: 'HAND', desc: '+4.7% poison' },
    glowcap_regent_card:    { enemy: 'Glowcap Regent', map: 'moonfen', rarity: 'elite', slot: 'CHEST', desc: '+7% regen, +4.9% hp' },
    bog_colossus_card:      { enemy: 'Bog Colossus', map: 'moonfen', rarity: 'regular', slot: 'CHEST', desc: '+13% map guard' },
    moonmire_reaper_card:   { enemy: 'Moonmire Reaper', map: 'moonfen', rarity: 'elite', slot: 'HAND', desc: '+6.6% chill, +4.9% weaken' },
    wisp_oracle_card:       { enemy: 'Wisp Oracle', map: 'moonfen', rarity: 'elite', slot: 'HEAD', desc: '+24% starshard' },
    fen_needle_card:        { enemy: 'Fen Needle', map: 'moonfen', rarity: 'regular', slot: 'HAND', desc: '+0.79% lifesteal' },
    fen_striker_card:       { enemy: 'Fen Striker', map: 'moonfen', rarity: 'regular', slot: 'HAND', desc: '+13% execute' },
    miremaw_card:           { enemy: 'Miremaw', map: 'moonfen', rarity: 'boss', slot: 'CHEST', desc: '+3% sw, +20% regen' },
    shard_hopper_card:      { enemy: 'Shard Hopper', map: 'crystal_hollows', rarity: 'regular', slot: 'HAND', desc: '+8% splash' },
    crystal_spitter_card:   { enemy: 'Crystal Spitter', map: 'crystal_hollows', rarity: 'regular', slot: 'HEAD', desc: '+3% long shot' },
    crystal_regent_card:    { enemy: 'Crystal Regent', map: 'crystal_hollows', rarity: 'elite', slot: 'CHEST', desc: '+2.6% reflect, +5.2% armor' },
    geode_guardian_card:    { enemy: 'Geode Guardian', map: 'crystal_hollows', rarity: 'regular', slot: 'HEAD', desc: '+7% mining' },
    prism_reaver_card:      { enemy: 'Prism Reaver', map: 'crystal_hollows', rarity: 'elite', slot: 'HAND', desc: '+3.5% split, +1.7% crit' },
    hollow_oracle_card:     { enemy: 'Hollow Oracle', map: 'crystal_hollows', rarity: 'elite', slot: 'HEAD', desc: '+7% ore find' },
    shard_needle_card:      { enemy: 'Shard Needle', map: 'crystal_hollows', rarity: 'regular', slot: 'HAND', desc: '+1.6% dbl strike' },
    shard_striker_card:     { enemy: 'Shard Striker', map: 'crystal_hollows', rarity: 'regular', slot: 'HAND', desc: '+10% crit dmg' },
    prismshell_card:        { enemy: 'Prismshell', map: 'crystal_hollows', rarity: 'boss', slot: 'CHEST', desc: '+8% reflect, prism on' },
    gear_prowler_card:      { enemy: 'Gear Prowler', map: 'clockwork_ruins', rarity: 'regular', slot: 'HAND', desc: '+7% steady' },
    rivet_spitter_card:     { enemy: 'Rivet Spitter', map: 'clockwork_ruins', rarity: 'regular', slot: 'HAND', desc: '+6.9% knockback' },
    gear_regent_card:       { enemy: 'Gear Regent', map: 'clockwork_ruins', rarity: 'elite', slot: 'CHEST', desc: '+8% shield' },
    iron_guardian_card:     { enemy: 'Iron Guardian', map: 'clockwork_ruins', rarity: 'regular', slot: 'CHEST', desc: '+3.6% armor, +5% melee guard' },
    scrap_reaver_card:      { enemy: 'Scrap Reaver', map: 'clockwork_ruins', rarity: 'elite', slot: 'HAND', desc: '+8% boss slay' },
    spark_oracle_card:      { enemy: 'Spark Oracle', map: 'clockwork_ruins', rarity: 'elite', slot: 'HAND', desc: '+2.6% stun' },
    gear_needle_card:       { enemy: 'Gear Needle', map: 'clockwork_ruins', rarity: 'regular', slot: 'HAND', desc: '+0.09 atk/s' },
    gear_striker_card:      { enemy: 'Gear Striker', map: 'clockwork_ruins', rarity: 'regular', slot: 'HEAD', desc: '+1.7% crit' },
    ironhorn_card:          { enemy: 'Ironhorn', map: 'clockwork_ruins', rarity: 'boss', slot: 'CHEST', desc: '+15% boss/elite guard, +12% armor' },
    gourd_prowler_card:     { enemy: 'Gourd Prowler', map: 'duskfall_orchard', rarity: 'regular', slot: 'HAND', desc: '+14% execute' },
    seed_spitter_card:      { enemy: 'Seed Spitter', map: 'duskfall_orchard', rarity: 'regular', slot: 'HEAD', desc: '+3.6% hp gain' },
    harvest_regent_card:    { enemy: 'Harvest Regent', map: 'duskfall_orchard', rarity: 'elite', slot: 'CHEST', desc: '+0.47% sw, +5.6% hp' },
    husk_guardian_card:     { enemy: 'Husk Guardian', map: 'duskfall_orchard', rarity: 'regular', slot: 'CHEST', desc: '+14% map guard' },
    thorn_reaver_card:      { enemy: 'Thorn Reaver', map: 'duskfall_orchard', rarity: 'elite', slot: 'HAND', desc: '+11% elite slay, +1.9% momentum' },
    harvest_oracle_card:    { enemy: 'Harvest Oracle', map: 'duskfall_orchard', rarity: 'elite', slot: 'HEAD', desc: '+2.7% all gain' },
    gourd_needle_card:      { enemy: 'Gourd Needle', map: 'duskfall_orchard', rarity: 'regular', slot: 'HAND', desc: '+3.6% split' },
    gourd_striker_card:     { enemy: 'Gourd Striker', map: 'duskfall_orchard', rarity: 'regular', slot: 'HAND', desc: '+11% crit dmg' },
    dreadreaper_card:       { enemy: 'Dreadreaper', map: 'duskfall_orchard', rarity: 'boss', slot: 'HAND', desc: '+10% reap, +10% boss slay' },
    circuit_prowler_card:   { enemy: 'Circuit Prowler', map: 'neon_bastion', rarity: 'regular', slot: 'HAND', desc: '+3.7% chain' },
    pulse_spitter_card:     { enemy: 'Pulse Spitter', map: 'neon_bastion', rarity: 'regular', slot: 'HAND', desc: '+1.9% stun' },
    voltage_regent_card:    { enemy: 'Voltage Regent', map: 'neon_bastion', rarity: 'elite', slot: 'CHEST', desc: '+6% shield, +2.9% reflect' },
    relay_guardian_card:    { enemy: 'Relay Guardian', map: 'neon_bastion', rarity: 'regular', slot: 'CHEST', desc: '+9% ranged guard' },
    arc_reaver_card:        { enemy: 'Arc Reaver', map: 'neon_bastion', rarity: 'elite', slot: 'HAND', desc: '+1.9% dbl, +3.9% chain' },
    signal_oracle_card:     { enemy: 'Signal Oracle', map: 'neon_bastion', rarity: 'elite', slot: 'HEAD', desc: '+14% card hunter' },
    circuit_needle_card:    { enemy: 'Circuit Needle', map: 'neon_bastion', rarity: 'regular', slot: 'HAND', desc: '+0.09 atk/s' },
    circuit_striker_card:   { enemy: 'Circuit Striker', map: 'neon_bastion', rarity: 'regular', slot: 'HEAD', desc: '+1.3% crit, +1.3% fleet' },
    voltwarden_card:        { enemy: 'Voltwarden', map: 'neon_bastion', rarity: 'boss', slot: 'HAND', desc: '+20% chain, +0.2 atk/s' },
    mossbound_stalker_card: { enemy: 'Mossbound Stalker', map: 'verdant_catacombs', rarity: 'regular', slot: 'HAND', desc: '+15% map slay' },
    spore_slinger_card:     { enemy: 'Spore Slinger', map: 'verdant_catacombs', rarity: 'regular', slot: 'HAND', desc: '+5.8% poison' },
    mycelial_regent_card:   { enemy: 'Mycelial Regent', map: 'verdant_catacombs', rarity: 'elite', slot: 'CHEST', desc: '+8% regen, +10% panic heal' },
    ossuary_guardian_card:  { enemy: 'Ossuary Guardian', map: 'verdant_catacombs', rarity: 'regular', slot: 'CHEST', desc: '+15% map guard' },
    briar_reaver_card:      { enemy: 'Briar Reaver', map: 'verdant_catacombs', rarity: 'elite', slot: 'HAND', desc: '+12% berserk, +1.01% lifesteal' },
    crypt_oracle_card:      { enemy: 'Crypt Oracle', map: 'verdant_catacombs', rarity: 'elite', slot: 'CHEST', desc: '+29% last stand' },
    moss_needle_card:       { enemy: 'Moss Needle', map: 'verdant_catacombs', rarity: 'regular', slot: 'HAND', desc: '+5.8% weaken' },
    moss_striker_card:      { enemy: 'Moss Striker', map: 'verdant_catacombs', rarity: 'regular', slot: 'HAND', desc: '+15% opener' },
    gravebloom_card:        { enemy: 'Gravebloom', map: 'verdant_catacombs', rarity: 'boss', slot: 'HEAD', desc: '+10% all gain' },
    ion_patrol_card:        { enemy: 'Ion Patrol', map: 'ion_citadel', rarity: 'regular', slot: 'HAND', desc: '+4% atk' },
    capacitor_gunner_card:  { enemy: 'Capacitor Gunner', map: 'ion_citadel', rarity: 'regular', slot: 'HAND', desc: '+10% splash' },
    citadel_marshal_card:   { enemy: 'Citadel Marshal', map: 'ion_citadel', rarity: 'elite', slot: 'CHEST', desc: '+6.3% hp, +10% elite guard' },
    bastion_defender_card:  { enemy: 'Bastion Defender', map: 'ion_citadel', rarity: 'regular', slot: 'CHEST', desc: '+8% boss guard' },
    flux_enforcer_card:     { enemy: 'Flux Enforcer', map: 'ion_citadel', rarity: 'elite', slot: 'HAND', desc: '+4.2% atk, +13% elite slay' },
    reactor_warden_card:    { enemy: 'Reactor Warden', map: 'ion_citadel', rarity: 'elite', slot: 'HAND', desc: '+3% momentum' },
    ion_needle_card:        { enemy: 'Ion Needle', map: 'ion_citadel', rarity: 'regular', slot: 'HAND', desc: '+0.1 atk/s' },
    ion_striker_card:       { enemy: 'Ion Striker', map: 'ion_citadel', rarity: 'regular', slot: 'HAND', desc: '+1.4% crit, +8% crit dmg' },
        aegis_prime_card:       { enemy: 'Aegis Prime', map: 'ion_citadel', rarity: 'boss', slot: 'CHEST', desc: '+25% shield, +10% boss guard' },
    // Endless : une carte Warden par bande de 10 maps, à la rareté boss.
    warden_i_card:          { enemy: 'Warden I',   map: 'endless', rarity: 'boss', slot: 'CHEST', desc: '+7% hp, +12% boss guard' },
    warden_ii_card:         { enemy: 'Warden II',  map: 'endless', rarity: 'boss', slot: 'HEAD',  desc: 'onward (auto-advance au prochain boss)' },
    warden_iii_card:        { enemy: 'Warden III', map: 'endless', rarity: 'boss', slot: 'HAND',  desc: '+15% boss slay, +5% atk' },
    warden_iv_card:         { enemy: 'Warden IV',  map: 'endless', rarity: 'boss', slot: 'HEAD',  desc: '+20% card hunter' },
    warden_v_card:          { enemy: 'Warden V',   map: 'endless', rarity: 'boss', slot: 'CHEST', desc: '+9% shield, +8% armor' },
    warden_vi_card:         { enemy: 'Warden VI',  map: 'endless', rarity: 'boss', slot: 'HAND',  desc: '+16% crit dmg, +2% dbl strike' },
    // Timberwood : coupe d'arbres, non trackable côté userscript.
    // `tree` est le nom du stand (kind) : 'pine' | 'oak' | 'yew' | 'elder'.
    // Il était `true` avant → causait "no farmable kind" (state[true] = undefined).
    oak_tree_card:          { enemy: 'Oak Tree',   map: 'timberwood', rarity: 'regular', slot: 'HEAD', desc: '+7% woodcutting speed', tree: 'oak' },
    elder_tree_card:        { enemy: 'Elder Tree', map: 'timberwood', rarity: 'elite',   slot: 'HEAD', desc: '+7% log find', tree: 'elder' },
	};

  const CARD_MAP_NAMES = {
    tutorial_forest: 'Tutorial Forest',
    beginner_desert: 'Beginner Desert',
    intermediate_snowlands: 'Intermediate Snowlands',
    advanced_lava_wastes: 'Advanced Lava Wastes',
    infernal_depths: 'Infernal Depths',
    water_reach: 'Water Reach',
    samurai_garden: 'Samurai Garden',
    cloudspire: 'Cloudspire',
    moonfen: 'Moonfen',
    crystal_hollows: 'Crystal Hollows',
    clockwork_ruins: 'Clockwork Ruins',
    duskfall_orchard: 'Duskfall Orchard',
    neon_bastion: 'Neon Bastion',
    verdant_catacombs: 'Verdant Catacombs',
        ion_citadel: 'Ion Citadel',
    endless: 'Endless',
    timberwood: 'Timberwood',
  };
  let cardTargetMode = localStorage.getItem('wildpote_cardtarget_mode') || 'target';
  let cardTargetList = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('wildpote_cardtarget_list') || '[]');
      if (Array.isArray(saved)) return saved.filter(id => CARD_DB[id]);
    } catch (e) {}
    return [];
  })();
  let cardTargetCopies = parseInt(localStorage.getItem('wildpote_cardtarget_copies') || '1', 10) || 1;

  let cardTargetRunning = false;
  let cardTargetAbort = false;
  let cardTargetLock = false;
  let cardTargetCurrentIdx = -1;

  let cardTargetLogs = [];

  let cardTargetUI = null;
  let cardTargetKitingInitial = false;

  function saveCardTargetState() {
    try {
      localStorage.setItem('wildpote_cardtarget_list', JSON.stringify(cardTargetList));
      localStorage.setItem('wildpote_cardtarget_copies', String(cardTargetCopies));
      localStorage.setItem('wildpote_cardtarget_mode', cardTargetMode);
    } catch (e) {}
  }

  const cardOwnedHeaders = { global: null, perMap: new Map() };

  function computeOwnedStats() {
    const owned = getCoop()?.cards?.() || {};
    const stats = { global: { owned: 0, total: 0 }, perMap: {} };
    for (const [cardId, def] of Object.entries(CARD_DB)) {
      const mapId = def.map;
      if (!stats.perMap[mapId]) stats.perMap[mapId] = { owned: 0, total: 0 };
      stats.perMap[mapId].total++;
      stats.global.total++;
      if ((owned[cardId] || 0) > 0) {
        stats.perMap[mapId].owned++;
        stats.global.owned++;
      }
    }
    return stats;
  }

  function refreshCardOwnedHeaders() {
    const stats = computeOwnedStats();
    if (cardOwnedHeaders.global) {
      const { owned, total } = stats.global;
      cardOwnedHeaders.global.textContent = `${owned}/${total}`;
      cardOwnedHeaders.global.style.color = owned === total && total > 0 ? '#69e56f' : '#888';
    }
    for (const [mapId, el] of cardOwnedHeaders.perMap) {
      const s = stats.perMap[mapId];
      if (!s) continue;
      el.textContent = `${s.owned}/${s.total}`;
      el.style.color = s.owned === s.total && s.total > 0 ? '#69e56f' : '#888';
    }
  }

  // v20.6.18 : mise à jour légère des compteurs de la target list (sans rebuild DOM)
    function refreshTargetListCounts() {
    if (!cardTargetUI?.targetListEl) return;
    const owned = getCoop()?.cards?.() || {};
    const rows = cardTargetUI.targetListEl.querySelectorAll('.cf-target-item');
    rows.forEach(row => {
      const cardId = row.dataset.cardId;
      if (!cardId || !CARD_DB[cardId]) return;
      const countEl = row.querySelector('.cf-target-count');
      if (countEl) {
        const ownedCount = owned[cardId] || 0;
        const newText = `${ownedCount}/${cardTargetCopies}`;
        if (countEl.textContent !== newText) {
          countEl.textContent = newText;
          countEl.style.color = ownedCount >= cardTargetCopies ? '#69e56f' : '';
        }
      }
      // ── Barre de pity (mobs seulement, boss = N/A) ──
      let pityEl = row.querySelector('.cf-pity');
      if (!pityEl) {
        pityEl = document.createElement('div');
        pityEl.className = 'cf-pity';
        pityEl.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:2px;width:100%;';
        pityEl.innerHTML =
          '<span style="font-size:8px;color:#888;min-width:18px;">~</span>' +
          '<div style="flex:1;height:3px;background:rgba(255,255,255,.1);border-radius:2px;overflow:hidden;">' +
            '<div class="cf-pity-bar" style="height:100%;background:#ffd85b;width:0;transition:width .3s;"></div>' +
          '</div>' +
          '<span class="cf-pity-pct" style="font-size:8px;color:#888;min-width:26px;text-align:right;">—</span>';
        row.appendChild(pityEl);
      }
      const pct = pityPct(cardId);
      const bar = pityEl.querySelector('.cf-pity-bar');
      const pctEl = pityEl.querySelector('.cf-pity-pct');
      if (pct === null) {
        // Carte boss : non trackable
        pityEl.style.display = 'flex';
        if (bar) bar.style.width = '0%';
        if (pctEl) { pctEl.textContent = 'N/A'; pctEl.style.color = '#666'; }
      } else {
        const hidden = (owned[cardId] || 0) >= cardTargetCopies;
        pityEl.style.display = hidden ? 'none' : 'flex';
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        if (pctEl) { pctEl.textContent = Math.round(pct) + '%'; pctEl.style.color = '#888'; }
      }
    });
  }

  function logCardTarget(msg, cls = 'info') {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    cardTargetLogs.push({ ts, msg, cls });
    if (cardTargetLogs.length > 100) cardTargetLogs.shift();
    pushLog(`🎯 ${msg}`);
    if (cardTargetUI) refreshCardTargetLogs();
  }

  function refreshCardTargetLogs() {
    if (!cardTargetUI?.logsEl) return;
    cardTargetUI.logsEl.innerHTML = cardTargetLogs.map(l => `<div class="${l.cls}">[${l.ts}] ${l.msg}</div>`).join('');
    cardTargetUI.logsEl.scrollTop = cardTargetUI.logsEl.scrollHeight;
  }

  function refreshCardTargetUI() {
    if (!cardTargetUI) return;
    const { targetListEl, copiesInputEl, btnStartEl, btnAllCardsEl, statusEl } = cardTargetUI;

        targetListEl.innerHTML = '';
    if (cardTargetMode === 'all') {
      // Mode All : on affiche les cartes de la MAP ACTUELLE (read-only)
      // pour surveiller le pity meter en temps réel. Le bot voyage entre
      // les maps, la target list se met à jour à chaque changement.
      const currentMap = getMapIdActuel();
      let mapCards = [];
      if (/^endless_\d+$/.test(currentMap || '')) {
        // Endless : une seule carte boss (la Warden de la bande)
        const wardenId = resolveBossCardId(currentMap);
        if (wardenId && CARD_DB[wardenId]) {
          mapCards = [{ cardId: wardenId, def: CARD_DB[wardenId] }];
        }
      } else {
        mapCards = Object.entries(CARD_DB)
          .filter(([id, def]) => def.map === currentMap && !def.tree)
          .map(([id, def]) => ({ cardId: id, def }));
      }

      // Hint mode
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:9px;color:#74d8ff;padding:2px 4px;margin-bottom:4px;';
      hint.textContent = `📍 All Cards — ${CARD_MAP_NAMES[currentMap] || currentMap || '?'}`;
      targetListEl.appendChild(hint);

      if (mapCards.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cf-empty-hint';
        empty.textContent = 'Aucune carte sur cette map';
        targetListEl.appendChild(empty);
      } else {
        const owned = getCoop()?.cards?.() || {};
        // Tri : rareté (boss > elite > regular), puis pity desc, puis nom
        const rarityRank = { boss: 0, elite: 1, regular: 2 };
        mapCards.sort((a, b) => {
          const ra = rarityRank[a.def.rarity] ?? 9;
          const rb = rarityRank[b.def.rarity] ?? 9;
          if (ra !== rb) return ra - rb;
          const pa = pityPct(a.cardId) ?? 0;
          const pb = pityPct(b.cardId) ?? 0;
          if (pa !== pb) return pb - pa;
          return a.def.enemy.localeCompare(b.def.enemy);
        });

        mapCards.forEach(({ cardId, def }) => {
          const ownedCount = owned[cardId] || 0;
          const row = document.createElement('div');
          row.className = 'cf-target-item';
          row.dataset.cardId = cardId;
          // Pas draggable, pas de grip interactif, pas de remove : read-only
          row.style.opacity = '0.92';
          const grip = document.createElement('span');
          grip.className = 'cf-target-grip';
          grip.textContent = '·';
          grip.style.color = '#444';
          grip.style.cursor = 'default';
          const name = document.createElement('span');
          name.className = 'cf-target-name';
          name.textContent = def.enemy;
          name.style.color = def.rarity === 'boss' ? '#ff655a' : def.rarity === 'elite' ? '#b47fff' : '#f5f5e9';
          const count = document.createElement('span');
          count.className = 'cf-target-count';
          count.textContent = `${ownedCount}/${cardTargetCopies}`;
          if (ownedCount >= cardTargetCopies) count.style.color = '#69e56f';
          row.append(grip, name, count);
          targetListEl.appendChild(row);
        });
      }
    } else if (cardTargetList.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cf-empty-hint';
      empty.textContent = 'Cochez des cartes ci-dessus pour les ajouter ici';
      targetListEl.appendChild(empty);
    } else {
      const c = getCoop();
      const owned = c?.cards?.() || {};
      cardTargetList.forEach((cardId, idx) => {
        const def = CARD_DB[cardId];
        if (!def) return;
        const ownedCount = owned[cardId] || 0;
        const row = document.createElement('div');
        row.className = 'cf-target-item';
        row.draggable = true;
        row.dataset.cardId = cardId;
        row.dataset.idx = idx;
        const grip = document.createElement('span');
        grip.className = 'cf-target-grip';
        grip.textContent = '≡';
        const name = document.createElement('span');
        name.className = 'cf-target-name';
        name.textContent = def.enemy;
        name.style.color = def.rarity === 'boss' ? '#ff655a' : def.rarity === 'elite' ? '#b47fff' : '#f5f5e9';
        const count = document.createElement('span');
        count.className = 'cf-target-count';
        count.textContent = `${ownedCount}/${cardTargetCopies}`;
        if (ownedCount >= cardTargetCopies) count.style.color = '#69e56f';
        const removeBtn = document.createElement('button');
        removeBtn.className = 'cf-target-remove';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Retirer';
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          cardTargetList.splice(idx, 1);
          saveCardTargetState();
          refreshCardTargetUI();
        };
        row.append(grip, name, count, removeBtn);

        row.ondragstart = (e) => {
          row.classList.add('is-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        };
        row.ondragend = () => row.classList.remove('is-dragging');
        row.ondragover = (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('is-drop-target');
        };
        row.ondragleave = () => row.classList.remove('is-drop-target');
        row.ondrop = (e) => {
          e.preventDefault();
          row.classList.remove('is-drop-target');
          const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (isNaN(fromIdx) || fromIdx === idx) return;
          const [moved] = cardTargetList.splice(fromIdx, 1);
          cardTargetList.splice(idx, 0, moved);
          saveCardTargetState();
          refreshCardTargetUI();
        };
        targetListEl.appendChild(row);
      });
    }

    if (copiesInputEl) copiesInputEl.value = String(cardTargetCopies);

    if (btnStartEl) {
      if (cardTargetRunning) {
        btnStartEl.textContent = cardTargetMode === 'all' ? '🛑 STOP (All)' : '🛑 STOP';
        btnStartEl.classList.remove('wp-primary');
        btnStartEl.classList.add('wp-danger');
        btnStartEl.disabled = false;
      } else {
        btnStartEl.textContent = '🎯 TARGET CARDS';
        btnStartEl.classList.remove('wp-danger');
        btnStartEl.classList.add('wp-primary');
        btnStartEl.disabled = cardTargetMode === 'target' && cardTargetList.length === 0;
      }
    }

    if (btnAllCardsEl) {
      if (cardTargetRunning) {
        btnAllCardsEl.disabled = true;
      } else {
        const owned = getCoop()?.cards?.() || {};
        const missingCount = Object.entries(CARD_DB).filter(([id]) => (owned[id] || 0) < cardTargetCopies).length;
        btnAllCardsEl.textContent = `🎯 ALL CARDS (${missingCount})`;
        btnAllCardsEl.classList.remove('wp-danger');
        btnAllCardsEl.classList.add('wp-primary');
        btnAllCardsEl.disabled = missingCount === 0;
      }
    }

    if (statusEl) {
      if (!cardTargetRunning) {
        if (cardTargetMode === 'all') {
          statusEl.textContent = 'Mode All Cards prêt';
          statusEl.style.color = '#74d8ff';
        } else if (cardTargetList.length === 0) {
          statusEl.textContent = 'Aucune carte sélectionnée';
          statusEl.style.color = '#888';
        } else {
          statusEl.textContent = `${cardTargetList.length} carte(s) en attente`;
          statusEl.style.color = '#888';
        }
      } else if (cardTargetCurrentIdx >= 0 && cardTargetList[cardTargetCurrentIdx]) {
        const def = CARD_DB[cardTargetList[cardTargetCurrentIdx]];
        const modeLabel = cardTargetMode === 'all' ? 'All' : 'Target';
        statusEl.textContent = `▶ [${modeLabel}] ${def?.enemy || '?'} (${cardTargetCurrentIdx + 1}/${cardTargetList.length})`;
        statusEl.style.color = '#69e56f';
      } else {
        statusEl.textContent = `▶ [${cardTargetMode === 'all' ? 'All' : 'Target'}] En cours…`;
        statusEl.style.color = '#69e56f';
      }
    }
  }

  function groupesAActiver(mapId, cardsSurMap) {
    const owned = getCoop()?.cards?.() || {};
    const maxAggro = getMaxAggroEffective();
    const groupes = new Set();

    for (const cardId of cardsSurMap) {
      const def = CARD_DB[cardId];
      if (!def || def.rarity === 'boss') continue;
      const g = groupeDeEnemy(def.enemy);
      if (g) groupes.add(g);
    }

    if (groupes.size < maxAggro) {
      const mobsSurMap = Object.entries(CARD_DB)
        .filter(([id, def]) => def.map === mapId && def.rarity !== 'boss')
        .map(([id, def]) => ({ cardId: id, enemy: def.enemy, owned: owned[id] || 0, groupe: groupeDeEnemy(def.enemy) }))
        .filter(m => m.groupe && !groupes.has(m.groupe))
        .sort((a, b) => a.owned - b.owned);

      const ajoutes = [];
      for (const m of mobsSurMap) {
        if (groupes.size >= maxAggro) break;
        groupes.add(m.groupe);
        ajoutes.push(m.groupe);
      }
      if (ajoutes.length > 0) logCardTarget(`Fallback (${ajoutes.length}): ${ajoutes.join(', ')}`, 'info');
    }

    return [...groupes].slice(0, maxAggro);
  }

  async function activerAggroMultiples(groupes) {
    if (groupes.length === 0) return [];
    const sheet = document.getElementById('autoFarmSheet');
    if (!sheet) { logCardTarget('❌ Panneau auto-farm introuvable', 'bad'); return []; }

    const content = sheet.querySelector('#autoFarmContent');
    let weOpenedIt = false;
    if (content?.hidden) {
      sheet.querySelector('.farm-toggle')?.click();
      weOpenedIt = true;
      await new Promise(r => setTimeout(r, 400));
    }

    let rows = sheet.querySelectorAll('[data-group]');
    const t0 = Date.now();
    while (rows.length === 0 && Date.now() - t0 < 3000) {
      await new Promise(r => setTimeout(r, 200));
      rows = sheet.querySelectorAll('[data-group]');
    }
    if (rows.length === 0) {
      logCardTarget('❌ Aucun groupe dans le panneau', 'bad');
      if (weOpenedIt) sheet.querySelector('.farm-toggle')?.click();
      return [];
    }

    const dispo = Array.from(rows).map(r => r.dataset.group);
    const cibles = groupes.filter(g => dispo.includes(g));
    const manquants = groupes.filter(g => !dispo.includes(g));
    if (manquants.length > 0) logCardTarget(`⚠️ Groupes absents du panneau: ${manquants.join(', ')}`, 'warn');

    const setCibles = new Set(cibles);
    for (const row of rows) {
      if (!setCibles.has(row.dataset.group)) {
        const offBtn = row.querySelector('[data-mode="off"]');
        if (offBtn && offBtn.getAttribute('aria-checked') !== 'true') {
          offBtn.click();
          await new Promise(r => setTimeout(r, 30));
        }
      }
    }
    for (const row of rows) {
      if (setCibles.has(row.dataset.group)) {
        const aggroBtn = row.querySelector('[data-mode="aggro"]');
        if (aggroBtn && aggroBtn.getAttribute('aria-checked') !== 'true') {
          aggroBtn.click();
          await new Promise(r => setTimeout(r, 50));
        }
      }
    }

    await new Promise(r => setTimeout(r, 300));
    const actives = [];
    for (const row of sheet.querySelectorAll('[data-group]')) {
      const aggroBtn = row.querySelector('[data-mode="aggro"]');
      if (aggroBtn?.getAttribute('aria-checked') === 'true') actives.push(row.dataset.group);
    }
    logCardTarget(`✅ Aggro actif (${actives.length}/${getMaxAggroEffective()}): ${actives.join(', ') || '(aucun)'}`, 'ok');

    const startBtn = sheet.querySelector('.farm-start');
    if (startBtn && !startBtn.disabled) {
      startBtn.click();
      await new Promise(r => setTimeout(r, 500));
    } else if (startBtn?.disabled) {
      const reason = sheet.querySelector('.farm-selection')?.textContent || '';
      logCardTarget(`⚠️ Start disabled${reason ? ` (${reason})` : ''}`, 'bad');
    }

    if (weOpenedIt && content && !content.hidden) {
      sheet.querySelector('.farm-toggle')?.click();
      await new Promise(r => setTimeout(r, 150));
    }

    return actives;
  }

  // ─── Timberwood (Town grove): the game's own Auto Chop does the navigation ───
  // Once .farm-start is clicked in .farm-chop-body, the game walks the player to each tree
  // and chops it (woodcutting-runtime.ts). The bot only needs to reach the grove, enable the
  // right data-tree switches, and wait for the card drops.
  async function farmTownTrees(treeCards) {
    const c = getCoop();
    if (!c) return false;
    if (treeCards.length === 0) return true;

    logCardTarget(`🌳 Timberwood : ${treeCards.map(id => CARD_DB[id].enemy).join(', ')}`, 'info');

    // 1. Teleport to Town if needed
    if (getMapIdActuel() !== 'town') {
      const btn = document.querySelector('[aria-label="Teleport to Town"]');
      if (!btn || btn.disabled) {
        logCardTarget('❌ Town teleport button not available', 'bad');
        return false;
      }
      logCardTarget('🏘️ Teleport to Town…', 'info');
      _lastTownPos = null;  // reset anchor: arrival will default to village frame
      simulerClic(btn);
      await new Promise(r => setTimeout(r, 4000));
      if (getMapIdActuel() !== 'town') {
        logCardTarget('❌ Teleport failed', 'bad');
        return false;
      }
    }

    // 2. Navigate to grove (one-time walk)
    await navigateToGrove(c);

    // 3. Identify tree kinds needed (def.tree is the stand name: 'pine'|'oak'|'yew'|'elder')
    const kindsNeeded = new Set();
    for (const id of treeCards) {
      const def = CARD_DB[id];
      if (!def?.tree) continue;
      const kind = def.tree;
      if (typeof kind !== 'string' || !TREE_ORDER.includes(kind)) {
        logCardTarget(`⚠️ ${def.enemy} : kind invalide (${JSON.stringify(kind)}) — ignoré`, 'warn');
        continue;
      }
      kindsNeeded.add(kind);
    }
    if (kindsNeeded.size === 0) {
      logCardTarget('❌ Aucun kind valide dans treeCards', 'bad');
      return false;
    }

    // 4. Activate Auto Chop with fallback (locked kinds → farm the highest unlocked below)
    let chopResult = await activerAutoChopAvecFallback(kindsNeeded);
    if (!chopResult.ok) {
      logCardTarget(`❌ Auto-chop not activated: ${chopResult.reason}`, 'bad');
      return false;
    }
    for (const [kind, info] of chopResult.fallbackFor.entries()) {
      logCardTarget(`⚠️ ${kind}: ${info.reason} — leveling up via ${info.farming.join(', ') || '?'}`, 'warn');
    }

    // 5. Poll for card drops (game handles all navigation + chopping)
    //
    // Stall-based timeout: the loop resets `lastProgressTs` on every meaningful progress
    // (Woodcutting level-up OR card drop). It only aborts if NOTHING happens for STALL_MS
    // (default: user's `wildpote_card_timeout_ms`, 20 min). This is what makes elder
    // farmable: grinding 24 → 900 takes hours, but each level-up keeps the timer fresh.
    // A separate HARD_CAP_MS (12h) prevents runaway if something silently breaks.
    const STALL_MS = parseInt(localStorage.getItem('wildpote_card_timeout_ms') || String(20 * 60 * 1000), 10);
    const HARD_CAP_MS = 12 * 60 * 60 * 1000;
    const debut = Date.now();
    let lastProgressTs = debut;
    let lastProgressReason = 'start';
    let bagFullStreak = 0;
    let lastUnlockCheck = 0;
    let lastWcLevel = getWoodcuttingLevel();
    // Thresholds from shared/woodcutting.ts WOOD_STANDS
    const WC_THRESHOLD = { pine: 0, oak: 50, yew: 250, elder: 900 };
    const nextLockedThreshold = () => {
      let min = Infinity;
      for (const lockedKind of chopResult.fallbackFor.keys()) {
        const t = WC_THRESHOLD[lockedKind];
        if (t !== undefined && t < min) min = t;
      }
      return Number.isFinite(min) ? min : null;
    };
    let lastOwnedSnapshot = { ...(c.cards?.() || {}) };
    if (lastWcLevel !== null) {
      const need = nextLockedThreshold();
      const prog = need !== null ? `${lastWcLevel}/${need}` : `${lastWcLevel}`;
      logCardTarget(`🪓 Woodcutting ${prog}`, 'info');
    }

    while (!cardTargetAbort && cardTargetRunning) {
      // Hard cap: abort after 12h regardless of progress (safety)
      if (Date.now() - debut > HARD_CAP_MS) {
        logCardTarget(`⏹️ 12h hard cap reached`, 'warn');
        break;
      }
      // Stall: no progress for STALL_MS (level-up or drop resets this)
      if (Date.now() - lastProgressTs > STALL_MS) {
        const mins = Math.round(STALL_MS / 60000);
        logCardTarget(`⏹️ Stall ${mins}min (last progress: ${lastProgressReason})`, 'warn');
        break;
      }

      await new Promise(r => setTimeout(r, 3000));
      if (estMort()) continue;
      const owned = c.cards?.() || {};
      let allDone = true;
      for (const cardId of treeCards) {
        if ((owned[cardId] || 0) >= cardTargetCopies) {
          if (!reached.has(cardId)) {
            reached.add(cardId);
            logCardTarget(`✅ ${CARD_DB[cardId].enemy} terminé (${owned[cardId]}/${cardTargetCopies})`, 'ok');
          }
        } else allDone = false;
      }
      if (allDone) break;

      // ── Progress detection ──────────────────────────────────────────
      // 1. Woodcutting level up → reset stall timer
      const wcNow = getWoodcuttingLevel();
      if (wcNow !== null && wcNow !== lastWcLevel) {
        lastWcLevel = wcNow;
        lastProgressTs = Date.now();
        lastProgressReason = `WC ${wcNow}`;
        const need = nextLockedThreshold();
        const prog = need !== null ? `${wcNow}/${need}` : `${wcNow}`;
        logCardTarget(`🪓 Woodcutting ${prog}`, 'info');
      }
      // 2. Card drop → reset stall timer (also covers the case where woodcutting is
      //    not maxed but its gain is negligible, e.g. if a future stand caps it)
      for (const cardId of treeCards) {
        const cur = owned[cardId] || 0;
        const prev = lastOwnedSnapshot[cardId] || 0;
        if (cur > prev) {
          lastOwnedSnapshot[cardId] = cur;
          lastProgressTs = Date.now();
          lastProgressReason = `${CARD_DB[cardId].enemy} drop`;
        }
      }

      // Periodic re-evaluation: has a locked kind unlocked?
      // 30 s normally, but 5 s when close to the next threshold (within 10 levels).
      const unlockPollMs = (() => {
        const need = nextLockedThreshold();
        if (need !== null && lastWcLevel !== null && need - lastWcLevel <= 10) return 5000;
        return 30000;
      })();
      if (chopResult.fallbackFor.size > 0 && Date.now() - lastUnlockCheck > unlockPollMs) {
        lastUnlockCheck = Date.now();
        // (WC change detection is already done at the top of the loop; nothing to do here.)
        const nowUnlocked = [];
        for (const lockedKind of chopResult.fallbackFor.keys()) {
          if (isKindUnlocked(lockedKind)) nowUnlocked.push(lockedKind);
        }
        if (nowUnlocked.length > 0) {
          logCardTarget(`🎉 ${nowUnlocked.join(', ')} unlocked — switching`, 'ok');
          await desactiverAutoFarmPanel();
          await new Promise(r => setTimeout(r, 500));
          const re = await activerAutoChopAvecFallback(kindsNeeded);
          if (re.ok) {
            chopResult = re;
            // A successful unlock counts as progress (stall timer resets)
            lastProgressTs = Date.now();
            lastProgressReason = `${nowUnlocked.join(',')} unlocked`;
            if (chopResult.fallbackFor.size === 0) {
              logCardTarget(`🎯 All needed kinds active (${chopResult.activeKinds.join(', ')})`, 'ok');
            }
          } else {
            logCardTarget(`⚠️ Re-activation failed: ${re.reason}`, 'warn');
          }
        }
      }

      // Detect stuck states
      const sheet = document.getElementById('autoFarmSheet');
      const status = sheet?.querySelector('.farm-chop-body .farm-mine-status')?.textContent || '';
      if (/Bag Full/i.test(status)) {
        bagFullStreak++;
        if (bagFullStreak >= 3) {
          logCardTarget(`⚠️ ${status} — stopping (bag full)`, 'warn');
          break;
        }
      } else {
        bagFullStreak = 0;
      }
      if (!sheet?.classList.contains('is-farming')) {
        logCardTarget(`⚠️ Auto Chop stopped unexpectedly (status: "${status}")`, 'warn');
        break;
      }
    }

    // 6. Stop + teleport back
    await desactiverAutoFarmPanel();
    if (getMapIdActuel() === 'town') {
      logCardTarget('🏘️ Teleport back to enemy map…', 'info');
      await new Promise(r => setTimeout(r, 5500)); // cooldown (TOWN_TELEPORT_COOLDOWN_MS = 5000)
      _lastTownPos = null;  // reset anchor for next town visit
      const btn = document.querySelector('[aria-label="Return to enemy map"]');
      if (btn && !btn.disabled) {
        simulerClic(btn);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    return treeCards.every(id => ((c.cards?.() || {})[id] || 0) >= cardTargetCopies);
  }

  // Is the game's chop body visible? That's the true "in grove" signal (the game
  // itself swaps bodies based on inTownGrove in shared/town.ts).
  function isInGrove() {
    const sheet = document.getElementById('autoFarmSheet');
    const chopBody = sheet?.querySelector('.farm-chop-body');
    return !!(chopBody && !chopBody.hidden);
  }

  // Tree progression order (see shared/woodcutting.ts WOOD_STANDS): pine=0, oak=50, yew=250, elder=900.
  const TREE_ORDER = ['pine', 'oak', 'yew', 'elder'];

  // Is a tree kind currently unlocked? Reads the panel's [data-tree] button's `disabled` state.
  function isKindUnlocked(kind) {
    const sheet = document.getElementById('autoFarmSheet');
    const chopBody = sheet?.querySelector('.farm-chop-body');
    if (!chopBody || chopBody.hidden) return false;
    const btn = chopBody.querySelector(`[data-tree="${kind}"]`);
    return !!(btn && !btn.disabled);
  }

  // Current woodcutting level (best effort — the coop API may expose it).
  function getWoodcuttingLevel() {
    try { return getCoop()?.woodcutting?.() ?? null; } catch (e) { return null; }
  }

  async function navigateToGrove(coop) {
    if (isInGrove()) {
      logCardTarget('✅ Already in grove', 'ok');
      return;
    }
    await new Promise(r => setTimeout(r, 500));
    const pos = getPositionInterpolee(coop);
    const atArrival = pos && Math.abs(pos.x - 6120) < 800 && Math.abs(pos.y - 5110) < 800;

    if (atArrival) {
      logCardTarget(`🌳 Minimap OK (pos=${Math.round(pos.x)},${Math.round(pos.y)}), waypoints`, 'info');
      // Waypoint 1: west bridge deck (67px gap between railings, y=5226 dead-center)
      const okBridge = await marcherVersDiag(4088, 5226, 20000, 'town');
      if (isInGrove()) { logCardTarget('✅ Grove reached after bridge', 'ok'); return; }
      if (!okBridge) {
        logCardTarget('⚠️ Bridge not reached, blind walk fallback', 'warn');
        await blindWalkToGrove();
        return;
      }
      // Waypoint 2: Oak stand (well inside TOWN_GROVE, chop body should appear)
      await marcherVersDiag(2800, 5200, 20000, 'town');
      if (isInGrove()) { logCardTarget('✅ Grove reached', 'ok'); return; }
      logCardTarget('⚠️ Grove not reached after waypoints, blind walk fallback', 'warn');
      await blindWalkToGrove();
    } else {
      logCardTarget(`🌳 Minimap unreliable (pos=${pos?.x?.toFixed(0) ?? '?'},${pos?.y?.toFixed(0) ?? '?'}), blind walk`, 'warn');
      await blindWalkToGrove();
    }
    // Let the game notice we're in the grove and swap to chop mode
    await new Promise(r => setTimeout(r, 1500));
  }

  async function blindWalkToGrove() {
    // Arrival (6120, 5110) → bridge (4088, 5226, y+116) → grove landing (2800, 5200)
    // Walk left in chunks, checking isInGrove() between each so we stop as soon as
    // the game swaps to chop-body (which happens the moment we cross into TOWN_GROVE).
    await pushDirectionnel('ArrowDown', 400);   // align bridge y
    for (let i = 0; i < 14; i++) {
      if (navAbort) return;
      if (isInGrove()) { logCardTarget(`✅ Grove reached (blind walk, ${i} chunks)`, 'ok'); return; }
      await pushDirectionnel('ArrowLeft', 1000);
      // Every 4 chunks (~4000ms of walking), wiggle to unstick from railings/walls
      if ((i + 1) % 4 === 0 && !isInGrove()) {
        await pushDirectionnel('ArrowUp', 150);
        await pushDirectionnel('ArrowDown', 300);
        await pushDirectionnel('ArrowUp', 150);
      }
    }
    if (!isInGrove()) logCardTarget('⚠️ Blind walk finished without reaching grove', 'warn');
  }

  /**
   * Activate Auto Chop for the requested kinds, with fallback to any unlocked lower kind
   * when a requested kind is locked. E.g. requesting Oak while Oak needs Woodcutting 50
   * will farm Pine (0+) until Oak unlocks. Returns which kinds were actually activated
   * and which requested kinds are on fallback (with reasons).
   */
  async function activerAutoChopAvecFallback(kindsNeeded) {
    const sheet = document.getElementById('autoFarmSheet');
    if (!sheet) return { ok: false, reason: 'autoFarmSheet missing', activeKinds: [], fallbackFor: new Map(), skipped: [], skipReasons: {} };

    // Open the panel if collapsed
    const toggle = sheet.querySelector('.farm-toggle');
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') {
      toggle.click();
      await new Promise(r => setTimeout(r, 400));
    }

    // Must be in chop body (game swaps bodies based on inTownGrove)
    const chopBody = sheet.querySelector('.farm-chop-body');
    if (!chopBody) return { ok: false, reason: 'chop body missing', activeKinds: [], fallbackFor: new Map(), skipped: [], skipReasons: {} };
    if (chopBody.hidden) return { ok: false, reason: 'chop body hidden (player not in grove?)', activeKinds: [], fallbackFor: new Map(), skipped: [], skipReasons: {} };

    // Snapshot each button's current state
    const buttons = Array.from(chopBody.querySelectorAll('[data-tree]'));
    const state = {};
    for (const btn of buttons) {
      state[btn.dataset.tree] = {
        disabled: btn.disabled,
        checked: btn.getAttribute('aria-checked') === 'true',
        reason: btn.querySelector('.farm-boss-status')?.textContent?.trim() || '',
      };
    }
    logCardTarget(`🌳 Tree buttons: ${buttons.map(b => `${b.dataset.tree}${state[b.dataset.tree].disabled ? `(lock: ${state[b.dataset.tree].reason})` : `=${state[b.dataset.tree].checked}`}`).join(', ')}`, 'info');

    // Compute: which kinds to activate, and which requested kinds are locked (fallback needed)
    const toActivate = new Set();
    const fallbackFor = new Map();  // lockedKind -> { reason, farming: [kinds] }
    const skipped = [];
    const skipReasons = {};

    for (const kind of kindsNeeded) {
      const st = state[kind];
      if (!st) { skipped.push(kind); skipReasons[kind] = 'not in panel'; continue; }
      if (st.disabled) {
        skipped.push(kind);
        skipReasons[kind] = st.reason || 'disabled';
        fallbackFor.set(kind, { reason: st.reason || 'locked', farming: [] });
        continue;
      }
      toActivate.add(kind);
    }

    // For each locked kind, add the highest unlocked kind below it (fallback)
    for (const [lockedKind, info] of fallbackFor.entries()) {
      const lockedIdx = TREE_ORDER.indexOf(lockedKind);
      if (lockedIdx < 0) continue;
      for (let i = lockedIdx - 1; i >= 0; i--) {
        const candidate = TREE_ORDER[i];
        const st = state[candidate];
        if (st && !st.disabled) {
          toActivate.add(candidate);
          info.farming.push(candidate);
          logCardTarget(`🪓 ${lockedKind} locked (${info.reason}) — farming ${candidate} to unlock`, 'warn');
          break;
        }
      }
    }

    if (toActivate.size === 0) {
      return { ok: false, reason: 'no farmable kind (all locked, no fallback)', activeKinds: [], fallbackFor, skipped, skipReasons };
    }

    // Apply checkbox state — only toggle buttons that need to change
    for (const btn of buttons) {
      const kind = btn.dataset.tree;
      const shouldCheck = toActivate.has(kind);
      const isChecked = state[kind].checked;
      if (shouldCheck && !isChecked && !state[kind].disabled) {
        btn.click();
        await new Promise(r => setTimeout(r, 100));
      } else if (!shouldCheck && isChecked) {
        btn.click();
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Let the game update the start button (it re-evaluates on each click)
    await new Promise(r => setTimeout(r, 600));

    const startBtn = sheet.querySelector('.farm-start');
    if (!startBtn || startBtn.disabled) {
      const reason = sheet.querySelector('.farm-selection')?.textContent?.trim() || 'Start disabled';
      return { ok: false, reason, activeKinds: [...toActivate], fallbackFor, skipped, skipReasons };
    }
    startBtn.click();
    await new Promise(r => setTimeout(r, 1000));

    if (!sheet.classList.contains('is-farming')) {
      return { ok: false, reason: 'start clicked but not farming', activeKinds: [...toActivate], fallbackFor, skipped, skipReasons };
    }
    logCardTarget(`✅ Auto Chop started (${[...toActivate].join(', ')})`, 'ok');
    return { ok: true, activeKinds: [...toActivate], fallbackFor, skipped, skipReasons };
  }

  // Kept as a thin wrapper for any old call sites.
  async function activerAutoChop(kinds) {
    const r = await activerAutoChopAvecFallback(kinds);
    return { ok: r.ok, reason: r.reason, skipped: r.skipped, skipReasons: r.skipReasons };
  }

  async function farmMapParallel(mapId, mobsRestants, bossRestants) {
    const c = getCoop();
    if (!c) return false;

    // Timberwood: cards whose `tree` flag is set are farmed in the Town's grove.
    const treeCards = [...mobsRestants, ...bossRestants].filter(id => CARD_DB[id]?.tree);
    if (mapId === 'town' || treeCards.length > 0) {
      return await farmTownTrees(treeCards);
    }

    const maxAggro = getMaxAggroEffective();

    let aggroActifs = [];
    const passiveCardIds = [];

    if (mobsRestants.length > 0 && maxAggro > 0) {
      const groupes = groupesAActiver(mapId, mobsRestants);
      if (groupes.length > 0) {
        logCardTarget(`🎯 Groupes ciblés (max ${maxAggro}): ${groupes.join(', ')}`, 'info');
        aggroActifs = await activerAggroMultiples(groupes);
        if (aggroActifs.length === 0) logCardTarget(`⚠️ Aucun aggro actif`, 'warn');
      }
    } else if (mobsRestants.length === 0 && bossRestants.length > 0 && maxAggro > 0) {
      const owned = c.cards?.() || {};
      const mobsFallback = Object.entries(CARD_DB)
        .filter(([id, def]) => def.map === mapId && def.rarity !== 'boss')
        .map(([id, def]) => ({
          cardId: id,
          enemy: def.enemy,
          owned: owned[id] || 0,
          groupe: groupeDeEnemy(def.enemy),
        }))
        .filter(m => m.groupe && m.owned < cardTargetCopies)
        .sort((a, b) => a.owned - b.owned);

      if (mobsFallback.length > 0) {
        const pulledGroups = new Set();
        for (const m of mobsFallback) {
          if (pulledGroups.size >= maxAggro) break;
          pulledGroups.add(m.groupe);
        }
        if (pulledGroups.size > 0) {
          logCardTarget(`🔄 Hug boss — aggro passif (${pulledGroups.size}/${maxAggro}): ${[...pulledGroups].join(', ')}`, 'info');
          aggroActifs = await activerAggroMultiples([...pulledGroups]);
          if (aggroActifs.length > 0) {
            const activeGroups = new Set(aggroActifs);
            for (const [cardId, def] of Object.entries(CARD_DB)) {
              if (def.map !== mapId || def.rarity === 'boss') continue;
              if (activeGroups.has(groupeDeEnemy(def.enemy))) {
                passiveCardIds.push(cardId);
              }
            }
          }
        }
      }
    } else if (maxAggro === 0) {
      logCardTarget(`⚠️ maxAggro=0 (run aggro en cours ?) — pas d'aggro`, 'warn');
    }

    let realBossPos = null;
    let bossCardId = null;
    let bossHitbox = null;
    if (bossRestants.length > 0) {
      bossCardId = bossRestants[0];
      realBossPos = getBossPosition(CARD_DB[bossCardId].map);
      bossHitbox = BOSS_HITBOXES[mapId] || { r: 150, vr: 150, offsetY: 0 };

      const targetY = realBossPos.y + bossHitbox.offsetY;

      logCardTarget(`👹 Boss ${CARD_DB[bossCardId].enemy} @ (${realBossPos.x}, ${realBossPos.y}) — approche vers (${realBossPos.x}, ${Math.round(targetY)}), aggro ${aggroActifs.length}`, 'info');
      await marcherVersDiag(realBossPos.x, targetY, 25000, mapId);
    }

    const allTargets = [...mobsRestants, ...bossRestants];
    const reached = new Set();
    const passiveReached = new Set();
    const debut = Date.now();
    const TIMEOUT_PHASE = parseInt(localStorage.getItem('wildpote_card_timeout_ms') || String(20 * 60 * 1000), 10);
    let derniereApproche = 0;
    let dernierePosApproche = null;
    let stagnationCount = 0;
    let approcheAbandonnee = false;
    let derniereMortTs = 0;

    logCardTarget(`⚔️ Farm parallèle : ${allTargets.map(id => CARD_DB[id].enemy).join(', ')}${realBossPos ? ' (contact boss)' : ''}${passiveCardIds.length > 0 ? ` + ${passiveCardIds.length} passive(s)` : ''}`, 'info');

    while (Date.now() - debut < TIMEOUT_PHASE && !cardTargetAbort && cardTargetRunning) {
      await new Promise(r => setTimeout(r, 2000));

      if (estMort()) {
        if (Date.now() - derniereMortTs > 5000) {
          logCardTarget(`💀 Mort — en attente respawn`, 'warn');
          derniereMortTs = Date.now();
        }
        continue;
      }

      const cardsNow = c.cards?.() || {};
      let allDone = true;
      for (const cardId of allTargets) {
        const now = cardsNow[cardId] || 0;
        if (now >= cardTargetCopies) {
          if (!reached.has(cardId)) {
            reached.add(cardId);
            logCardTarget(`✅ ${CARD_DB[cardId].enemy} terminé ! (${now}/${cardTargetCopies})`, 'ok');
            cardTargetCurrentIdx = cardTargetList.indexOf(cardId);
            refreshCardTargetUI();
          }
        } else {
          allDone = false;
        }
      }
      if (allDone) { logCardTarget(`✅ Toutes les cibles de ${CARD_MAP_NAMES[mapId] || mapId} terminées`, 'ok'); break; }

      for (const cardId of passiveCardIds) {
        if (passiveReached.has(cardId)) continue;
        const now = cardsNow[cardId] || 0;
        if (now >= cardTargetCopies) {
          passiveReached.add(cardId);
          logCardTarget(`🎁 Bonus ${CARD_DB[cardId].enemy} terminé (${now}/${cardTargetCopies})`, 'ok');
        }
      }

      if (bossCardId && !reached.has(bossCardId) && realBossPos && !approcheAbandonnee) {
        const maintenant = Date.now();
        if (maintenant - derniereApproche > 5000) {
          const pos = getPositionInterpolee(c);
          if (pos && !minimapEstFigee(pos)) {
            const bodyY = realBossPos.y + bossHitbox.offsetY;
            const distBody = Math.hypot(realBossPos.x - pos.x, bodyY - pos.y);

            if (distBody <= BOSS_CONTACT_RADIUS) {
              if (maintenant - derniereApproche > 15000) {
                logCardTarget(`⚔️ En combat (pos=${Math.round(pos.x)},${Math.round(pos.y)} distBody=${Math.round(distBody)}px) — attente active`, 'ok');
              }
            } else {
              if (dernierePosApproche) {
                const mouvement = Math.hypot(pos.x - dernierePosApproche.x, pos.y - dernierePosApproche.y);
                if (mouvement < BOSS_PROGRESS_MIN_PX) {
                  stagnationCount++;
                  logCardTarget(`⚠️ Stagnation #${stagnationCount}/${BOSS_MAX_STAGNATION} (mouvement=${Math.round(mouvement)}px, distBody=${Math.round(distBody)}px)`, 'warn');
                  if (stagnationCount >= BOSS_MAX_STAGNATION) {
                    logCardTarget(`🚫 Blocage persistant après ${BOSS_MAX_STAGNATION} tentatives — abandon des ré-approches pour cette map`, 'bad');
                    approcheAbandonnee = true;
                    derniereApproche = maintenant;
                    continue;
                  }
                } else {
                  stagnationCount = 0;
                }
              }
              dernierePosApproche = { x: pos.x, y: pos.y };
              logCardTarget(`🚶 Ré-approche boss (distBody=${Math.round(distBody)}px)`, 'info');
              await marcherVersDiag(realBossPos.x, bodyY, 15000, mapId);
            }
          } else {
            logCardTarget(`⚠️ Minimap indisponible/figée — attente sans bouger`, 'warn');
          }
          derniereApproche = maintenant;
        }
      }
    }

    if (aggroActifs.length > 0) {
      logCardTarget(`🛑 Désactivation aggro (fin de map)`, 'info');
      await desactiverAutoFarmPanel();
      await new Promise(r => setTimeout(r, 500));
    }
    const cardsFinal = c.cards?.() || {};
    const notDone = allTargets.filter(id => (cardsFinal[id] || 0) < cardTargetCopies);
    if (notDone.length > 0) logCardTarget(`⚠️ Non terminés : ${notDone.map(id => CARD_DB[id].enemy).join(', ')}`, 'warn');

    return notDone.length === 0;
  }

  // ═════════════════════════════════════════════════════════════════
  //  15.8. AUTO MINING & AUTO WOODCUTTING (standalone, in Town)
  // ═════════════════════════════════════════════════════════════════

  const ORE_ORDER = ['copper_ore', 'iron_ore', 'mithril_ore', 'adamant_ore'];
  const ORE_EXTRA = ['arcane_crystal', 'starshard'];
  const ORE_LABELS = {
    copper_ore: 'Copper Ore', iron_ore: 'Iron Ore', mithril_ore: 'Mithril Ore',
    adamant_ore: 'Adamant Ore', arcane_crystal: 'Arcane Crystal', starshard: 'Starshard',
  };
  const ORE_THRESHOLD = {
    copper_ore: 0, iron_ore: 50, mithril_ore: 250, adamant_ore: 900,
    arcane_crystal: 25, starshard: 0,
  };
  const TREE_LABELS = { pine: 'Pine Tree', oak: 'Oak Tree', yew: 'Yew Tree', elder: 'Elder Tree' };
  const TREE_THRESHOLD = { pine: 0, oak: 50, yew: 250, elder: 900 };

  function getMiningLevel() {
    try { return getCoop()?.mining?.() ?? null; } catch (e) { return null; }
  }
  function isInHills() {
    const sheet = document.getElementById('autoFarmSheet');
    const mineBody = sheet?.querySelector('.farm-mine-body:not(.farm-chop-body)');
    return !!(mineBody && !mineBody.hidden);
  }
  function isOreUnlocked(oreId) {
    const sheet = document.getElementById('autoFarmSheet');
    const mineBody = sheet?.querySelector('.farm-mine-body:not(.farm-chop-body)');
    if (!mineBody || mineBody.hidden) return false;
    const btn = mineBody.querySelector(`[data-ore="${oreId}"]`);
    return !!(btn && !btn.disabled);
  }

  let autoMiningActive = localStorage.getItem('wildpote_automining_active') === 'true';
  let autoMiningList = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('wildpote_automining_list') || '[]');
      const valid = [...ORE_ORDER, ...ORE_EXTRA];
      if (Array.isArray(saved)) return saved.filter(id => valid.includes(id));
    } catch (e) {}
    return ['copper_ore'];
  })();
  let autoMiningRunning = false;
  let autoMiningAbort = false;
  let autoMiningLogs = [];
  let autoMiningUI = null;

  let autoWoodcuttingActive = localStorage.getItem('wildpote_autowc_active') === 'true';
  let autoWoodcuttingList = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('wildpote_autowc_list') || '[]');
      const valid = ['pine', 'oak', 'yew', 'elder'];
      if (Array.isArray(saved)) return saved.filter(k => valid.includes(k));
    } catch (e) {}
    return ['pine'];
  })();
  let autoWoodcuttingRunning = false;
  let autoWoodcuttingAbort = false;
  let autoWoodcuttingLogs = [];
  let autoWoodcuttingUI = null;

  function saveAutoMiningState() {
    try {
      localStorage.setItem('wildpote_automining_active', String(autoMiningActive));
      localStorage.setItem('wildpote_automining_list', JSON.stringify(autoMiningList));
    } catch (e) {}
  }
  function saveAutoWoodcuttingState() {
    try {
      localStorage.setItem('wildpote_autowc_active', String(autoWoodcuttingActive));
      localStorage.setItem('wildpote_autowc_list', JSON.stringify(autoWoodcuttingList));
    } catch (e) {}
  }
  function logAutoMining(msg, cls = 'info') {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    autoMiningLogs.push({ ts, msg, cls });
    if (autoMiningLogs.length > 100) autoMiningLogs.shift();
    pushLog(`⛏️ ${msg}`);
    if (autoMiningUI) refreshAutoMiningLogs();
  }
  function logAutoWoodcutting(msg, cls = 'info') {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    autoWoodcuttingLogs.push({ ts, msg, cls });
    if (autoWoodcuttingLogs.length > 100) autoWoodcuttingLogs.shift();
    pushLog(`🌳 ${msg}`);
    if (autoWoodcuttingUI) refreshAutoWoodcuttingLogs();
  }
  function refreshAutoMiningLogs() {
    if (!autoMiningUI?.logsEl) return;
    autoMiningUI.logsEl.innerHTML = autoMiningLogs.map(l => `<div class="${l.cls}">[${l.ts}] ${l.msg}</div>`).join('');
    autoMiningUI.logsEl.scrollTop = autoMiningUI.logsEl.scrollHeight;
  }
  function refreshAutoWoodcuttingLogs() {
    if (!autoWoodcuttingUI?.logsEl) return;
    autoWoodcuttingUI.logsEl.innerHTML = autoWoodcuttingLogs.map(l => `<div class="${l.cls}">[${l.ts}] ${l.msg}</div>`).join('');
    autoWoodcuttingUI.logsEl.scrollTop = autoWoodcuttingUI.logsEl.scrollHeight;
  }

  // ─── Navigation to the hills ───
  //
  // The village Inn (Door 5) sits at (6690, 5203) with a collider spanning x ∈ [6390, 6990] — right on the
  // direct path between the arrival (6120, 5110) and the east fence gap (6930, 5225). So we route around it:
  // south of the Inn, then back up into the gap.
  //
  // Waypoints (each verified reachable at Town; the anti-stuck in marcherVersDiag now slides correctly):
  //   1. Village square, east of arrival, above the Inn : (6900, 5110)
  //   2. Slip south around the Inn                       : (6900, 5350)
  //   3. East of the Inn, north of it                    : (7150, 5225) — pre-gap approach
  //   4. Fence gap                                       : (6930, 5225) — the gap itself (go back west into it)
  //   5. Approaching east bridge                         : (7250, 5000)
  //   6. East bridge                                     : (7314, 4766)
  //   7. Bridge approach (north-east)                    : (7900, 4600)
  //   8. Hills interior                                  : (9500, 4260)
  async function navigateToHills(coop) {
    if (isInHills()) { logAutoMining('✅ Already in hills', 'ok'); return true; }
    await new Promise(r => setTimeout(r, 500));

    // Waypoints calculés depuis town-village-scene.json (origin = 6164, 5054).
    // Le couloir horizontal libre est y ∈ [5098, 5168] (entre la rangée d'objets
    // hauts ~5072-5098 et la rangée basse ~5168-5208). On y circule à y=5150.
    // Le mur sud-est (6406-6982, 5304-5722) bloque toute descente au sud : évité.
    const WAYPOINTS = [
      { x: 6176, y: 5150, name: 'below arrival' },        // décalé de 56px à droite (le banc d'arrivée) + descente à y safe
      { x: 6500, y: 5200, name: 'east corridor' },        // couloir y=5150, traverse tout le village
      { x: 6930, y: 5200, name: 'fence gap (in)' },       // entrée du gap
      { x: 7000, y: 5200, name: 'gap outside' },          // sortie du gap
      { x: 7000, y: 4733, name: 'bridge approach west' }, // approche ouest du pont
      { x: 7314, y: 4733, name: 'bridge center' },        // pont (passage entre railings y[4732,4799])
      { x: 7500, y: 4733, name: 'bridge exit' },          // sortie est du pont
      { x: 7900, y: 4650, name: 'bridge approach east' }, // approche est (approche[1] x[7440,7760], on pousse à 7900)
      { x: 8500, y: 4500, name: 'open countryside' },     // herbe ouverte
      { x: 9500, y: 4260, name: 'hills interior' },       // intérieur des collines
    ];

    for (let i = 0; i < WAYPOINTS.length; i++) {
      if (autoMiningAbort) return false;
      if (isInHills()) { logAutoMining(`✅ In hills (after wp ${i})`, 'ok'); return true; }
      const wp = WAYPOINTS[i];
      logAutoMining(`🚶 [${i + 1}/${WAYPOINTS.length}] → ${wp.name} (${wp.x}, ${wp.y})`, 'info');
      await marcherVersDiag(wp.x, wp.y, 12000, 'town');
    }
    if (isInHills()) { logAutoMining('✅ In hills (all waypoints)', 'ok'); return true; }

    // Blind walk fallback: push east + slight up, checking isInHills each chunk
    logAutoMining('⚠️ Waypoints failed, blind walk east', 'warn');
    for (let i = 0; i < 25; i++) {
      if (autoMiningAbort) return false;
      if (isInHills()) { logAutoMining(`✅ In hills (blind chunk ${i})`, 'ok'); return true; }
      await pushDirectionnel('ArrowRight', 800);
      if (i % 4 === 3) {
        await pushDirectionnel('ArrowUp', 200);
        await pushDirectionnel('ArrowDown', 100);
      }
    }
    return false;
  }

  // ─── Activation with fallback ───
  async function activerAutoMiningAvecFallback(oreIdsNeeded) {
    const empty = { ok: false, reason: 'missing', activeKinds: [], fallbackFor: new Map(), skipped: [], skipReasons: {} };
    const sheet = document.getElementById('autoFarmSheet');
    if (!sheet) return { ...empty, reason: 'sheet missing' };
    const toggle = sheet.querySelector('.farm-toggle');
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); await new Promise(r => setTimeout(r, 400)); }
    const mineBody = sheet.querySelector('.farm-mine-body:not(.farm-chop-body)');
    if (!mineBody) return { ...empty, reason: 'mine body missing' };
    if (mineBody.hidden) return { ...empty, reason: 'mine body hidden (not in hills?)' };
    const buttons = Array.from(mineBody.querySelectorAll('[data-ore]'));
    const state = {};
    for (const btn of buttons) {
      state[btn.dataset.ore] = {
        disabled: btn.disabled,
        checked: btn.getAttribute('aria-checked') === 'true',
        reason: btn.querySelector('.farm-boss-status')?.textContent?.trim() || '',
      };
    }
    logAutoMining(`⛏️ Ore buttons: ${buttons.map(b => `${b.dataset.ore}${state[b.dataset.ore].disabled ? `(lock: ${state[b.dataset.ore].reason})` : `=${state[b.dataset.ore].checked}`}`).join(', ')}`, 'info');
    const toActivate = new Set();
    const fallbackFor = new Map();
    const skipped = [], skipReasons = {};
    for (const oreId of oreIdsNeeded) {
      const st = state[oreId];
      if (!st) { skipped.push(oreId); skipReasons[oreId] = 'not in panel'; continue; }
      if (st.disabled) {
        skipped.push(oreId); skipReasons[oreId] = st.reason || 'disabled';
        if (ORE_ORDER.includes(oreId)) fallbackFor.set(oreId, { reason: st.reason || 'locked', farming: [] });
        continue;
      }
      toActivate.add(oreId);
    }
    for (const [lockedOre, info] of fallbackFor.entries()) {
      const idx = ORE_ORDER.indexOf(lockedOre);
      for (let i = idx - 1; i >= 0; i--) {
        const candidate = ORE_ORDER[i];
        if (state[candidate] && !state[candidate].disabled) {
          toActivate.add(candidate);
          info.farming.push(candidate);
          logAutoMining(`⛏️ ${lockedOre} locked (${info.reason}) — mining ${candidate}`, 'warn');
          break;
        }
      }
    }
    if (toActivate.size === 0) return { ok: false, reason: 'no farmable ore (all locked)', activeKinds: [], fallbackFor, skipped, skipReasons };
    for (const btn of buttons) {
      const oreId = btn.dataset.ore;
      const shouldCheck = toActivate.has(oreId);
      const isChecked = state[oreId].checked;
      if (shouldCheck && !isChecked && !state[oreId].disabled) { btn.click(); await new Promise(r => setTimeout(r, 100)); }
      else if (!shouldCheck && isChecked) { btn.click(); await new Promise(r => setTimeout(r, 100)); }
    }
    await new Promise(r => setTimeout(r, 600));
    const startBtn = sheet.querySelector('.farm-start');
    if (!startBtn || startBtn.disabled) {
      return { ok: false, reason: sheet.querySelector('.farm-selection')?.textContent?.trim() || 'Start disabled', activeKinds: [...toActivate], fallbackFor, skipped, skipReasons };
    }
    startBtn.click();
    await new Promise(r => setTimeout(r, 1000));
    if (!sheet.classList.contains('is-farming')) return { ok: false, reason: 'not farming', activeKinds: [...toActivate], fallbackFor, skipped, skipReasons };
    logAutoMining(`✅ Auto Mine started (${[...toActivate].join(', ')})`, 'ok');
    return { ok: true, activeKinds: [...toActivate], fallbackFor, skipped, skipReasons };
  }

  // ─── Core routines ───
  async function autoMiningRoutine() {
    if (autoMiningRunning) return;
    if (cardTargetRunning) { logAutoMining('❌ Target Cards en cours — arrête-le avant', 'bad'); return; }
    if (autoMiningList.length === 0) { logAutoMining('⚠️ Aucun minerai coché', 'warn'); return; }
    autoMiningRunning = true; autoMiningAbort = false; navAbort = false;
    refreshAutoMiningUI();
    try {
      const c = getCoop();
      if (!c) return;
      if (getMapIdActuel() !== 'town') {
        const btn = document.querySelector('[aria-label="Teleport to Town"]');
        if (!btn || btn.disabled) { logAutoMining('❌ Town teleport not available', 'bad'); return; }
        logAutoMining('🏘️ Teleport to Town…', 'info');
        _lastTownPos = null;
        simulerClic(btn);
        await new Promise(r => setTimeout(r, 4000));
        if (getMapIdActuel() !== 'town') { logAutoMining('❌ Teleport failed', 'bad'); return; }
      }
      await navigateToHills(c);
      let result = await activerAutoMiningAvecFallback(new Set(autoMiningList));
      if (!result.ok) { logAutoMining(`❌ Not activated: ${result.reason}`, 'bad'); return; }
      for (const [ore, info] of result.fallbackFor.entries()) logAutoMining(`⚠️ ${ore}: ${info.reason} — leveling via ${info.farming.join(', ') || '?'}`, 'warn');
      const STALL_MS = parseInt(localStorage.getItem('wildpote_card_timeout_ms') || String(20 * 60 * 1000), 10);
      const HARD_CAP_MS = 12 * 60 * 60 * 1000;
      const debut = Date.now();
      let lastProgressTs = debut, lastProgressReason = 'start', bagFullStreak = 0;
      let lastMiningLevel = getMiningLevel();
      const lastUnlocked = new Set([...ORE_ORDER, ...ORE_EXTRA].filter(id => isOreUnlocked(id)));
      const nextLockedThreshold = () => {
        let min = Infinity;
        for (const o of result.fallbackFor.keys()) { const t = ORE_THRESHOLD[o]; if (t !== undefined && t < min) min = t; }
        return Number.isFinite(min) ? min : null;
      };
      if (lastMiningLevel !== null) {
        const need = nextLockedThreshold();
        logAutoMining(`⛏️ Mining ${need !== null ? `${lastMiningLevel}/${need}` : lastMiningLevel}`, 'info');
      }
      while (!autoMiningAbort && autoMiningRunning) {
        if (Date.now() - debut > HARD_CAP_MS) { logAutoMining('⏹️ 12h hard cap', 'warn'); break; }
        if (Date.now() - lastProgressTs > STALL_MS) { logAutoMining(`⏹️ Stall ${Math.round(STALL_MS/60000)}min (last: ${lastProgressReason})`, 'warn'); break; }
        await new Promise(r => setTimeout(r, 3000));
        if (estMort()) continue;
        const lvl = getMiningLevel();
        if (lvl !== null && lvl !== lastMiningLevel) {
          lastMiningLevel = lvl; lastProgressTs = Date.now(); lastProgressReason = `Mining ${lvl}`;
          const need = nextLockedThreshold();
          logAutoMining(`⛏️ Mining ${need !== null ? `${lvl}/${need}` : lvl}`, 'info');
        }
        for (const oreId of [...ORE_ORDER, ...ORE_EXTRA]) {
          if (lastUnlocked.has(oreId)) continue;
          if (isOreUnlocked(oreId)) {
            lastUnlocked.add(oreId);
            // Only re-activate items the user has checked (they may have pre-checked
            // an item while it was locked). Items not in the list are just noted.
            if (!autoMiningList.includes(oreId)) continue;
            logAutoMining(`🎉 ${oreId} unlocked — activating`, 'ok');
            lastProgressTs = Date.now(); lastProgressReason = `${oreId} unlocked`;
            await desactiverAutoFarmPanel();
            await new Promise(r => setTimeout(r, 500));
            const re = await activerAutoMiningAvecFallback(new Set(autoMiningList));
            if (re.ok) {
              result = re;
              if (result.fallbackFor.size === 0) logAutoMining(`🎯 All active (${result.activeKinds.join(', ')})`, 'ok');
            }
          }
        }
        const sheet = document.getElementById('autoFarmSheet');
        const status = sheet?.querySelector('.farm-mine-body:not(.farm-chop-body) .farm-mine-status')?.textContent || '';
        if (/Bag Full/i.test(status)) { bagFullStreak++; if (bagFullStreak >= 3) { logAutoMining(`⚠️ ${status} — stopping`, 'warn'); break; } }
        else bagFullStreak = 0;
        if (!sheet?.classList.contains('is-farming')) { logAutoMining(`⚠️ Auto Mine stopped (status: "${status}")`, 'warn'); break; }
      }
    } catch (e) { logAutoMining(`❌ Erreur: ${e.message}`, 'bad'); }
    finally {
      await desactiverAutoFarmPanel().catch(() => {});
      if (getMapIdActuel() === 'town') {
        logAutoMining('🏘️ Teleport back…', 'info');
        await new Promise(r => setTimeout(r, 5500));
        _lastTownPos = null;
        const btn = document.querySelector('[aria-label="Return to enemy map"]');
        if (btn && !btn.disabled) { simulerClic(btn); await new Promise(r => setTimeout(r, 3000)); }
      }
      autoMiningRunning = false;
      refreshAutoMiningUI();
    }
  }

  async function autoWoodcuttingRoutine() {
    if (autoWoodcuttingRunning) return;
    if (cardTargetRunning) { logAutoWoodcutting('❌ Target Cards en cours — arrête-le avant', 'bad'); return; }
    if (autoWoodcuttingList.length === 0) { logAutoWoodcutting('⚠️ Aucun arbre coché', 'warn'); return; }
    autoWoodcuttingRunning = true; autoWoodcuttingAbort = false; navAbort = false;
    refreshAutoWoodcuttingUI();
    try {
      const c = getCoop();
      if (!c) return;
      if (getMapIdActuel() !== 'town') {
        const btn = document.querySelector('[aria-label="Teleport to Town"]');
        if (!btn || btn.disabled) { logAutoWoodcutting('❌ Town teleport not available', 'bad'); return; }
        logAutoWoodcutting('🏘️ Teleport to Town…', 'info');
        _lastTownPos = null;
        simulerClic(btn);
        await new Promise(r => setTimeout(r, 4000));
        if (getMapIdActuel() !== 'town') { logAutoWoodcutting('❌ Teleport failed', 'bad'); return; }
      }
      await navigateToGrove(c);
      let result = await activerAutoChopAvecFallback(new Set(autoWoodcuttingList));
      if (!result.ok) { logAutoWoodcutting(`❌ Not activated: ${result.reason}`, 'bad'); return; }
      for (const [kind, info] of result.fallbackFor.entries()) logAutoWoodcutting(`⚠️ ${kind}: ${info.reason} — leveling via ${info.farming.join(', ') || '?'}`, 'warn');
      const STALL_MS = parseInt(localStorage.getItem('wildpote_card_timeout_ms') || String(20 * 60 * 1000), 10);
      const HARD_CAP_MS = 12 * 60 * 60 * 1000;
      const debut = Date.now();
      let lastProgressTs = debut, lastProgressReason = 'start', bagFullStreak = 0;
      let lastWcLevel = getWoodcuttingLevel();
      const lastUnlocked = new Set(TREE_ORDER.filter(k => isKindUnlocked(k)));
      const nextLockedThreshold = () => {
        let min = Infinity;
        for (const k of result.fallbackFor.keys()) { const t = TREE_THRESHOLD[k]; if (t !== undefined && t < min) min = t; }
        return Number.isFinite(min) ? min : null;
      };
      if (lastWcLevel !== null) {
        const need = nextLockedThreshold();
        logAutoWoodcutting(`🪓 Woodcutting ${need !== null ? `${lastWcLevel}/${need}` : lastWcLevel}`, 'info');
      }
      while (!autoWoodcuttingAbort && autoWoodcuttingRunning) {
        if (Date.now() - debut > HARD_CAP_MS) { logAutoWoodcutting('⏹️ 12h hard cap', 'warn'); break; }
        if (Date.now() - lastProgressTs > STALL_MS) { logAutoWoodcutting(`⏹️ Stall ${Math.round(STALL_MS/60000)}min (last: ${lastProgressReason})`, 'warn'); break; }
        await new Promise(r => setTimeout(r, 3000));
        if (estMort()) continue;
        const lvl = getWoodcuttingLevel();
        if (lvl !== null && lvl !== lastWcLevel) {
          lastWcLevel = lvl; lastProgressTs = Date.now(); lastProgressReason = `WC ${lvl}`;
          const need = nextLockedThreshold();
          logAutoWoodcutting(`🪓 Woodcutting ${need !== null ? `${lvl}/${need}` : lvl}`, 'info');
        }
        for (const kind of TREE_ORDER) {
          if (lastUnlocked.has(kind)) continue;
          if (isKindUnlocked(kind)) {
            lastUnlocked.add(kind);
            // Only re-activate items the user has checked.
            if (!autoWoodcuttingList.includes(kind)) continue;
            logAutoWoodcutting(`🎉 ${kind} unlocked — activating`, 'ok');
            lastProgressTs = Date.now(); lastProgressReason = `${kind} unlocked`;
            await desactiverAutoFarmPanel();
            await new Promise(r => setTimeout(r, 500));
            const re = await activerAutoChopAvecFallback(new Set(autoWoodcuttingList));
            if (re.ok) {
              result = re;
              if (result.fallbackFor.size === 0) logAutoWoodcutting(`🎯 All active (${result.activeKinds.join(', ')})`, 'ok');
            }
          }
        }
        const sheet = document.getElementById('autoFarmSheet');
        const status = sheet?.querySelector('.farm-chop-body .farm-mine-status')?.textContent || '';
        if (/Bag Full/i.test(status)) { bagFullStreak++; if (bagFullStreak >= 3) { logAutoWoodcutting(`⚠️ ${status} — stopping`, 'warn'); break; } }
        else bagFullStreak = 0;
        if (!sheet?.classList.contains('is-farming')) { logAutoWoodcutting(`⚠️ Auto Chop stopped (status: "${status}")`, 'warn'); break; }
      }
    } catch (e) { logAutoWoodcutting(`❌ Erreur: ${e.message}`, 'bad'); }
    finally {
      await desactiverAutoFarmPanel().catch(() => {});
      if (getMapIdActuel() === 'town') {
        logAutoWoodcutting('🏘️ Teleport back…', 'info');
        await new Promise(r => setTimeout(r, 5500));
        _lastTownPos = null;
        const btn = document.querySelector('[aria-label="Return to enemy map"]');
        if (btn && !btn.disabled) { simulerClic(btn); await new Promise(r => setTimeout(r, 3000)); }
      }
      autoWoodcuttingRunning = false;
      refreshAutoWoodcuttingUI();
    }
  }

  async function startAutoMining() {
    if (cardTargetRunning) { logAutoMining('❌ Target Cards en cours', 'bad'); return; }
    if (autoMiningRunning) return;
    if (autoMiningList.length === 0) { logAutoMining('⚠️ Aucun minerai coché', 'warn'); return; }
    await autoMiningRoutine();
  }
  function stopAutoMining() { if (autoMiningRunning) { autoMiningAbort = true; navAbort = true; logAutoMining('🛑 Stop demandé', 'warn'); } }
  async function startAutoWoodcutting() {
    if (cardTargetRunning) { logAutoWoodcutting('❌ Target Cards en cours', 'bad'); return; }
    if (autoWoodcuttingRunning) return;
    if (autoWoodcuttingList.length === 0) { logAutoWoodcutting('⚠️ Aucun arbre coché', 'warn'); return; }
    await autoWoodcuttingRoutine();
  }
  function stopAutoWoodcutting() { if (autoWoodcuttingRunning) { autoWoodcuttingAbort = true; logAutoWoodcutting('🛑 Stop demandé', 'warn'); } }

  // ─── UI builders ───
  function buildAutoMiningSection() {
    const section = construireSection('⛏️ AUTO MINING', '#c9b8ff', true);
    const title = section._wpTitle;
    title.style.justifyContent = 'space-between';
    const leftSpan = h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });
    const chevron = section._wpChevron, labelSpan = section._wpLabel;
    if (chevron) leftSpan.appendChild(chevron);
    if (labelSpan) leftSpan.appendChild(labelSpan);
    title.innerHTML = '';
    title.appendChild(leftSpan);
    // (No toggle: START/STOP buttons already gate the routine. The old `autoMiningActive`
    // toggle was dead state — stored but never read. Removed to avoid confusion.)
    const statusPos = construireStatusRow('Position', '—', 'wp-muted');
    const statusLvl = construireStatusRow('Mining', '—', 'wp-info');
    section.append(statusPos.row, statusLvl.row);
    section.appendChild(h('div', { style: { fontSize: '10px', fontWeight: '900', color: '#b7c5b7', textTransform: 'uppercase', paddingTop: '4px' }, text: 'Minerais à farmer' }));
    const oreListEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
    section.appendChild(oreListEl);
    const oreCheckboxes = new Map();
    for (const oreId of [...ORE_ORDER, ...ORE_EXTRA]) {
      const cb = h('input', {
        type: 'checkbox',
        checked: autoMiningList.includes(oreId),
        onchange: () => {
          if (cb.checked) { if (!autoMiningList.includes(oreId)) autoMiningList.push(oreId); }
          else autoMiningList = autoMiningList.filter(x => x !== oreId);
          saveAutoMiningState(); refreshAutoMiningUI();
        },
      });
      const thr = ORE_THRESHOLD[oreId];
      const desc = h('span', { class: 'cf-mob-desc', text: thr === 0 ? 'Lv 0' : `Lv ${thr}` });
      oreListEl.appendChild(h('div', { class: 'cf-mob-row' },
        cb,
        h('span', { class: 'cf-mob-name', text: ORE_LABELS[oreId] }),
        desc,
      ));
      oreCheckboxes.set(oreId, { cb, desc });
    }
    const btnStart = h('button', { class: 'wp-btn wp-primary', text: '🚀 START', onclick: () => startAutoMining().catch(e => logAutoMining('❌ ' + e.message, 'bad')) });
    const btnStop = h('button', { class: 'wp-btn wp-danger', text: '🛑 STOP', onclick: () => stopAutoMining() });
    section.appendChild(h('div', { class: 'cf-actions', style: { marginTop: '4px' } }, btnStart, btnStop));
    const statusEl = h('div', { class: 'cf-status', style: { color: '#888' }, text: 'Idle' });
    section.appendChild(statusEl);
    const logsEl = h('div', { class: 'cf-logs' });
    section.appendChild(logsEl);
    const btnCopy = h('button', { class: 'wp-btn wp-info', text: '📋 Copier logs', onclick: async () => {
      if (autoMiningLogs.length === 0) return;
      const header = `=== DIAG AUTO MINING v${VERSION} ===\nTimestamp: ${new Date().toISOString()}\nList: ${autoMiningList.join(', ')}\nRunning: ${autoMiningRunning}\n--- LOGS ---\n`;
      const body = autoMiningLogs.map(l => `[${l.ts}] (${l.cls}) ${l.msg}`).join('\n');
      try { await navigator.clipboard.writeText(header + body); btnCopy.textContent = '✅ Copié'; setTimeout(() => { btnCopy.textContent = '📋 Copier logs'; }, 2000); }
      catch (e) { btnCopy.textContent = '❌ Voir console'; setTimeout(() => { btnCopy.textContent = '📋 Copier logs'; }, 2000); }
    }});
    section.appendChild(h('div', { class: 'cf-actions', style: { marginTop: '4px' } }, btnCopy));
    autoMiningUI = { section, statusPos, statusLvl, oreCheckboxes, btnStart, btnStop, statusEl, logsEl };
    refreshAutoMiningUI();
    refreshAutoMiningLogs();
    return section;
  }

  function buildAutoWoodcuttingSection() {
    const section = construireSection('🌳 AUTO WOODCUTTING', '#8fbf6f', true);
    const title = section._wpTitle;
    title.style.justifyContent = 'space-between';
    const leftSpan = h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });
    const chevron = section._wpChevron, labelSpan = section._wpLabel;
    if (chevron) leftSpan.appendChild(chevron);
    if (labelSpan) leftSpan.appendChild(labelSpan);
    title.innerHTML = '';
    title.appendChild(leftSpan);
    // (No toggle: START/STOP buttons already gate the routine.)
    const statusPos = construireStatusRow('Position', '—', 'wp-muted');
    const statusLvl = construireStatusRow('Woodcutting', '—', 'wp-info');
    section.append(statusPos.row, statusLvl.row);
    section.appendChild(h('div', { style: { fontSize: '10px', fontWeight: '900', color: '#b7c5b7', textTransform: 'uppercase', paddingTop: '4px' }, text: 'Arbres à farmer' }));
    const treeListEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
    section.appendChild(treeListEl);
    const oreCheckboxes = new Map();
    for (const kind of TREE_ORDER) {
      const cb = h('input', {
        type: 'checkbox',
        checked: autoWoodcuttingList.includes(kind),
        onchange: () => {
          if (cb.checked) { if (!autoWoodcuttingList.includes(kind)) autoWoodcuttingList.push(kind); }
          else autoWoodcuttingList = autoWoodcuttingList.filter(x => x !== kind);
          saveAutoWoodcuttingState(); refreshAutoWoodcuttingUI();
        },
      });
      const thr = TREE_THRESHOLD[kind];
      const desc = h('span', { class: 'cf-mob-desc', text: thr === 0 ? 'Lv 0' : `Lv ${thr}` });
      treeListEl.appendChild(h('div', { class: 'cf-mob-row' },
        cb,
        h('span', { class: 'cf-mob-name', text: TREE_LABELS[kind] }),
        desc,
      ));
      oreCheckboxes.set(kind, { cb, desc });
    }
    const btnStart = h('button', { class: 'wp-btn wp-primary', text: '🚀 START', onclick: () => startAutoWoodcutting().catch(e => logAutoWoodcutting('❌ ' + e.message, 'bad')) });
    const btnStop = h('button', { class: 'wp-btn wp-danger', text: '🛑 STOP', onclick: () => stopAutoWoodcutting() });
    section.appendChild(h('div', { class: 'cf-actions', style: { marginTop: '4px' } }, btnStart, btnStop));
    const statusEl = h('div', { class: 'cf-status', style: { color: '#888' }, text: 'Idle' });
    section.appendChild(statusEl);
    const logsEl = h('div', { class: 'cf-logs' });
    section.appendChild(logsEl);
    const btnCopy = h('button', { class: 'wp-btn wp-info', text: '📋 Copier logs', onclick: async () => {
      if (autoWoodcuttingLogs.length === 0) return;
      const header = `=== DIAG AUTO WC v${VERSION} ===\nTimestamp: ${new Date().toISOString()}\nList: ${autoWoodcuttingList.join(', ')}\nRunning: ${autoWoodcuttingRunning}\n--- LOGS ---\n`;
      const body = autoWoodcuttingLogs.map(l => `[${l.ts}] (${l.cls}) ${l.msg}`).join('\n');
      try { await navigator.clipboard.writeText(header + body); btnCopy.textContent = '✅ Copié'; setTimeout(() => { btnCopy.textContent = '📋 Copier logs'; }, 2000); }
      catch (e) { btnCopy.textContent = '❌ Voir console'; setTimeout(() => { btnCopy.textContent = '📋 Copier logs'; }, 2000); }
    }});
    section.appendChild(h('div', { class: 'cf-actions', style: { marginTop: '4px' } }, btnCopy));
    autoWoodcuttingUI = { section, statusPos, statusLvl, oreCheckboxes, btnStart, btnStop, statusEl, logsEl };
    refreshAutoWoodcuttingUI();
    refreshAutoWoodcuttingLogs();
    return section;
  }

  function refreshAutoMiningUI() {
    if (!autoMiningUI) return;
    const mapId = getMapIdActuel();
    const inHills = isInHills();
    const lvl = getMiningLevel();
    setVal(autoMiningUI.statusPos.val, inHills ? '📍 Copper Hills' : (mapId === 'town' ? 'Village' : (mapId || '?')), inHills ? 'wp-ok' : 'wp-muted');
    setVal(autoMiningUI.statusLvl.val, lvl !== null ? String(lvl) : '—', 'wp-info');
    const lvl0 = lvl ?? 0;
    // Checkboxes are ALWAYS checkable: user can pre-select an item and the bot will
    // farm it as soon as its level is high enough. The 🔒 + level hint signals it's
    // currently locked. `activerAutoMiningAvecFallback` reads the game panel's own
    // button state (not this checkbox) so locked items simply go into fallbackFor.
    for (const [oreId, entry] of autoMiningUI.oreCheckboxes.entries()) {
      const thr = ORE_THRESHOLD[oreId];
      const locked = thr !== undefined && lvl0 < thr;
      entry.desc.textContent = locked ? `🔒 Lv ${thr}` : (thr === 0 ? 'Lv 0' : `Lv ${thr}`);
      entry.desc.style.color = locked ? '#888' : '#69e56f';
    }
    if (autoMiningRunning) {
      autoMiningUI.btnStart.disabled = true; autoMiningUI.btnStop.disabled = false;
      autoMiningUI.statusEl.textContent = '▶ Running…'; autoMiningUI.statusEl.style.color = '#69e56f';
    } else {
      autoMiningUI.btnStart.disabled = autoMiningList.length === 0 || cardTargetRunning;
      autoMiningUI.btnStop.disabled = true;
      autoMiningUI.statusEl.textContent = autoMiningList.length === 0 ? 'Aucun minerai coché' : `${autoMiningList.length} minerai(s) — Idle`;
      autoMiningUI.statusEl.style.color = '#888';
    }
  }
  function refreshAutoWoodcuttingUI() {
    if (!autoWoodcuttingUI) return;
    const mapId = getMapIdActuel();
    const inGrove = isInGrove();
    const lvl = getWoodcuttingLevel();
    setVal(autoWoodcuttingUI.statusPos.val, inGrove ? '📍 Grove' : (mapId === 'town' ? 'Village' : (mapId || '?')), inGrove ? 'wp-ok' : 'wp-muted');
    setVal(autoWoodcuttingUI.statusLvl.val, lvl !== null ? String(lvl) : '—', 'wp-info');
    const lvl0 = lvl ?? 0;
    for (const [kind, entry] of autoWoodcuttingUI.oreCheckboxes.entries()) {
      const thr = TREE_THRESHOLD[kind];
      const locked = thr !== undefined && lvl0 < thr;
      entry.desc.textContent = locked ? `🔒 Lv ${thr}` : (thr === 0 ? 'Lv 0' : `Lv ${thr}`);
      entry.desc.style.color = locked ? '#888' : '#69e56f';
    }
    if (autoWoodcuttingRunning) {
      autoWoodcuttingUI.btnStart.disabled = true; autoWoodcuttingUI.btnStop.disabled = false;
      autoWoodcuttingUI.statusEl.textContent = '▶ Running…'; autoWoodcuttingUI.statusEl.style.color = '#69e56f';
    } else {
      autoWoodcuttingUI.btnStart.disabled = autoWoodcuttingList.length === 0 || cardTargetRunning;
      autoWoodcuttingUI.btnStop.disabled = true;
      autoWoodcuttingUI.statusEl.textContent = autoWoodcuttingList.length === 0 ? 'Aucun arbre coché' : `${autoWoodcuttingList.length} arbre(s) — Idle`;
      autoWoodcuttingUI.statusEl.style.color = '#888';
    }
  }

  async function autoCardTargetRoutine() {
    if (cardTargetLock) return;
    if (autoMiningRunning || autoWoodcuttingRunning) {
      logCardTarget('❌ Auto Mining/Woodcutting en cours — arrête-les avant', 'bad');
      return;
    }
    cardTargetLock = true;
    cardTargetAbort = false;
    navAbort = false;
    cardTargetRunning = true;
    localStorage.setItem('wildpote_cardtarget_running', 'true');
    localStorage.setItem('wildpote_cardtarget_mode', cardTargetMode);
    cardTargetKitingInitial = kitingActif;
    refreshCardTargetUI();

    if (cardTargetMode === 'all') {
      const owned = getCoop()?.cards?.() || {};
      cardTargetList = Object.entries(CARD_DB)
        .filter(([id]) => (owned[id] || 0) < cardTargetCopies)
        .map(([id]) => id);
      logCardTarget(`🎯 [All] ${cardTargetList.length} carte(s) manquante(s) (cible ${cardTargetCopies} copies)`, 'info');
      refreshCardTargetUI();
    }

    const modeLabel = cardTargetMode === 'all' ? 'All' : 'Target';
    logCardTarget(`🎯 [${modeLabel}] Démarrage (${cardTargetList.length} carte(s), ${cardTargetCopies} copies, maxAggro=${getMaxAggroEffective()})`);

    let routineCompleted = false;   // v20.6.18 : bascule auto Target→All

    try {
      if (cardTargetList.length === 0) { logCardTarget('Aucune carte à farmer', 'warn'); return; }

      logCardTarget('🛑 Désactivation kiting + auto-farm');
      kitingActif = false;
      relacherToutes();
      await desactiverAutoFarmPanel();
      await new Promise(r => setTimeout(r, 500));

      let maxRetries = 5;
      let retryCount = 0;

      while (!cardTargetAbort && cardTargetRunning && retryCount < maxRetries) {
        const c = getCoop();
        if (!c || !c.isConnected?.()) {
          logCardTarget('⏳ En attente de connexion au jeu...', 'warn');
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const parMap = new Map();
        for (const cardId of cardTargetList) {
          const def = CARD_DB[cardId];
          if (!def) continue;
          const targetMap = resolveTargetMapId(cardId);
          if (!targetMap) {
            logCardTarget(`⚠️ ${def.enemy} : map non navigable (${def.map}), ignoré`, 'warn');
            continue;
          }
          if (!parMap.has(targetMap)) parMap.set(targetMap, { mobs: [], boss: [] });
          const entry = parMap.get(targetMap);
          if (def.rarity === 'boss') entry.boss.push(cardId);
          else entry.mobs.push(cardId);
        }
        const ordreMap = [];
        for (const cardId of cardTargetList) {
          const targetMap = resolveTargetMapId(cardId);
          if (targetMap && !ordreMap.includes(targetMap)) ordreMap.push(targetMap);
        }

        let allMapsDone = true;

        for (const mapId of ordreMap) {
          if (cardTargetAbort || !cardTargetRunning) break;

          const entry = parMap.get(mapId);
          const mobsRestants = entry.mobs.filter(id => ((c.cards?.() || {})[id] || 0) < cardTargetCopies);
          const bossRestants = entry.boss.filter(id => ((c.cards?.() || {})[id] || 0) < cardTargetCopies);

          if (mobsRestants.length === 0 && bossRestants.length === 0) {
            logCardTarget(`✅ Map ${CARD_MAP_NAMES[mapId] || mapId} : tout atteint`, 'ok');
            continue;
          }

          allMapsDone = false;

          logCardTarget(`📍 Map ${CARD_MAP_NAMES[mapId] || mapId} : ${mobsRestants.length} mob(s), ${bossRestants.length} boss`, 'info');

          let mapActuelle = getMapIdActuel();
          let navOk = false;
          let navAttempts = 0;
          while (navAttempts < 3 && !navOk && !cardTargetAbort && cardTargetRunning) {
            if (mapActuelle === mapId) { navOk = true; break; }
            // Town is only reachable via the toolbar teleport button — farmTownTrees handles it.
            if (mapId === 'town') { navOk = true; break; }
            navAttempts++;
            logCardTarget(`🚶 Voyage ${mapActuelle} → ${mapId} (essai ${navAttempts}/3)`);
            navOk = await voyagerVersMap(mapId);
            if (!navOk) await new Promise(r => setTimeout(r, 2000));
            mapActuelle = getMapIdActuel();
          }

          if (!navOk) {
            logCardTarget(`❌ Impossible d'atteindre ${mapId}, on passe à la suite`, 'bad');
            continue;
          }

          await new Promise(r => setTimeout(r, 1500));

          const ok = await farmMapParallel(mapId, mobsRestants, bossRestants);
          if (!ok) {
            logCardTarget(`⚠️ Farm incomplet sur ${mapId}`, 'warn');
          }
        }

        if (allMapsDone) {
          logCardTarget('🏁 Toutes les cibles terminées !', 'ok');
          routineCompleted = true;   // v20.6.18
          break;
        }

        retryCount++;
        if (retryCount < maxRetries && !cardTargetAbort && cardTargetRunning) {
          logCardTarget(`🔄 Boucle terminée avec cibles manquantes. Nouvelle passe dans 20s... (${retryCount}/${maxRetries})`, 'warn');
          await new Promise(r => setTimeout(r, 20000));
        }
      }

      if (retryCount >= maxRetries) {
        logCardTarget(`⏹️ Nombre max de tentatives atteint (${maxRetries}). Arrêt.`, 'warn');
      } else if (cardTargetAbort) {
        logCardTarget('⏹️ Routine arrêtée par l\'utilisateur', 'warn');
      }

    } catch (e) {
      logCardTarget(`❌ Erreur: ${e.message}`, 'bad');
    } finally {
      // v20.6.18 : bascule auto Target → All si succès
      const wasTargetMode = cardTargetMode === 'target';
      const wasAborted = cardTargetAbort;

      cardTargetLock = false;
      cardTargetRunning = false;
      cardTargetCurrentIdx = -1;
      localStorage.setItem('wildpote_cardtarget_running', 'false');
      await desactiverAutoFarmPanel().catch(() => {});
      if (cardTargetKitingInitial) kitingActif = true;
      refreshCardTargetUI();

      if (wasTargetMode && routineCompleted && !wasAborted) {
        const owned = getCoop()?.cards?.() || {};
        const stillMissing = Object.entries(CARD_DB)
          .filter(([id]) => (owned[id] || 0) < cardTargetCopies)
          .length;

        if (stillMissing > 0) {
          logCardTarget(`🎉 Target Cards terminées — bascule auto vers All Cards dans 3s (${stillMissing} carte(s) manquante(s))`, 'ok');
          setTimeout(() => {
            if (!cardTargetRunning) {
              cardTargetMode = 'all';
              saveCardTargetState();
              refreshCardTargetUI();
              logCardTarget(`🎯 [All] Démarrage automatique (${stillMissing} manquante(s))`, 'info');
              autoCardTargetRoutine().catch(e => logCardTarget(`❌ Erreur bascule auto : ${e.message}`, 'bad'));
            }
          }, 3000);
        } else {
          logCardTarget(`🎉 Target Cards terminées — et toutes les cartes sont déjà à ${cardTargetCopies} copie(s) !`, 'ok');
        }
      }
    }
  }

  function stopCardTarget() {
    if (!cardTargetRunning || cardTargetAbort) return;
    cardTargetAbort = true;
    navAbort = true;
    localStorage.setItem('wildpote_cardtarget_running', 'false');
    logCardTarget('🛑 Arrêt demandé...', 'warn');
  }

  async function startTargetCardsRoutine() {
    if (cardTargetRunning) { stopCardTarget(); return; }
    if (cardTargetList.length === 0) {
      logCardTarget('⚠️ Target list vide — sélectionne des cartes ou utilise All Cards', 'warn');
      return;
    }
    cardTargetMode = 'target';
    saveCardTargetState();
    await autoCardTargetRoutine();
  }

  async function startAllCardsRoutine() {
    if (cardTargetRunning) { stopCardTarget(); return; }
    const owned = getCoop()?.cards?.() || {};
    const missingCount = Object.entries(CARD_DB).filter(([id]) => (owned[id] || 0) < cardTargetCopies).length;
    if (missingCount === 0) {
      logCardTarget(`✅ Toutes les cartes ont déjà ${cardTargetCopies} copies !`, 'ok');
      return;
    }
    cardTargetMode = 'all';
    saveCardTargetState();
    await autoCardTargetRoutine();
  }

  // ═════════════════════════════════════════════════════════════════
  //  16. UI
  // ═════════════════════════════════════════════════════════════════
  async function initBot() {
    log('Initialisation UI...');
    const checkApi = setInterval(() => {
      if (getCoop() && getCoop().isConnected()) {
        clearInterval(checkApi);
        log('Connexion détectée — hooks...');
        try { installerHookArray(); } catch (e) { log('❌ Hook Array:', e.message); }
        try { exposerQuestsJson(); } catch (e) { log('❌ Quêtes:', e.message); }
      }
    }, 500);

    if (document.getElementById('wildpote-ui')) return;

    function buildChrome() {
      const TAB_KEYS = ['farm', 'quest', 'kiting', 'misc'];
      const TAB_LABELS = { farm: 'FARM', quest: 'QUEST', kiting: 'KITING', misc: 'MISC' };

      injecterStyle();
      const box = h('div', { id: 'wildpote-ui' });
      const posSaved = JSON.parse(localStorage.getItem('wildpote_pos') || 'null');
      if (posSaved && posSaved.top && posSaved.left) { box.style.top = posSaved.top; box.style.left = posSaved.left; }
      else { box.style.top = '12px'; box.style.left = 'calc(100vw - 300px)'; }

      const handle = h('button', {
        class: 'wp-handle',
        innerHTML: `WildPote v${VERSION} <span class="wp-chevron">▾</span>`,
      });
      box.appendChild(h('header', null, handle));

      const tabs = h('div', { class: 'wp-tabs' });
      TAB_KEYS.forEach(k => {
        tabs.appendChild(h('button', {
          class: 'wp-tab' + (k === ongletActif ? ' is-active' : ''),
          dataset: { tab: k },
          text: TAB_LABELS[k],
          onclick: () => switchOnglet(k),
        }));
      });
      box.appendChild(tabs);

      const content = h('div', { class: 'wp-content' });
      box.appendChild(content);
      const panels = {};
      TAB_KEYS.forEach(k => {
        const panel = h('div', { class: 'wp-tab-panel', dataset: { tab: k } });
        content.appendChild(panel);
        panels[k] = panel;
      });

      return { box, handle, tabs, content, panels };
    }

    const { box, handle, tabs, content, panels } = buildChrome();

    // ─── FARM ───
    const panelFarm = panels.farm;

    function buildPrestigeSection() {
      const section = construireSection('👑 AUTO-PRESTIGE', '#ffd85b');

      const title = section._wpTitle;
      title.style.justifyContent = 'space-between';

      const leftSpan = h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });
      const chevron = section._wpChevron;
      const labelSpan = section._wpLabel;
      if (chevron) leftSpan.appendChild(chevron);
      if (labelSpan) leftSpan.appendChild(labelSpan);
      title.innerHTML = '';
      title.appendChild(leftSpan);

      const togglePrestigeInline = construireToggleInline(autoPrestigeActif, (v) => {
        autoPrestigeActif = v;
        localStorage.setItem('wildpote_autoprestige', String(v));
        pushLog(v ? '👑 Auto-prestige ON' : '👑 Auto-prestige OFF');
      }, 'Auto-prestige');
      title.appendChild(togglePrestigeInline.toggle);

      const prestigeTimer = construireStatusRow('Depuis dernier', '—', 'wp-info');
      const prestigeDuree = construireStatusRow('Dernier cycle', '—', 'wp-ok');
      const prestigeStatus = construireStatusRow('Statut', '—', 'wp-muted');
      const prestigeLevel = construireStatusRow('Niveau', '—', 'wp-num');
      section.append(prestigeTimer.row, prestigeDuree.row, prestigeLevel.row, prestigeStatus.row);

      const btn = h('button', {
        class: 'wp-btn wp-primary',
        text: '👑 PRESTIGE MAINTENANT',
        style: { marginTop: '4px' },
        onclick: () => {
          prestigeEnAttente = false;
          prestigeMapAttente = null;
          declencherPrestige(true).catch(e => pushLog('Erreur : ' + e.message));
        },
      });
      section.appendChild(btn);

      return { section, prestigeTimer, prestigeDuree, prestigeLevel, prestigeStatus };
    }

    const { section: sectionPrestige, prestigeTimer, prestigeDuree, prestigeStatus, prestigeLevel } = buildPrestigeSection();
    panelFarm.appendChild(sectionPrestige);

    // ─── TARGET CARDS ───
    function buildCardFarmingSection() {
    const sectionCardFarming = construireSection('🎯 TARGET CARDS', '#ff9fd2', true);

    const cardTreeHeader = document.createElement('div');
    cardTreeHeader.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;background:rgba(255,255,255,.05);border-radius:4px;cursor:pointer;font-size:10px;font-weight:900;color:#ffd85b;margin-bottom:4px;user-select:none;';
    const treeChevron = document.createElement('span');
    treeChevron.textContent = '▾';
    treeChevron.style.cssText = 'font-size:9px;transition:transform .15s;display:inline-block;';
    const treeTitle = document.createElement('span');
    treeTitle.textContent = 'Choix des cartes';
    treeTitle.style.flex = '1';
    const treeCount = document.createElement('span');
    treeCount.style.cssText = 'color:#888;font-weight:400;font-size:9px;';
    treeCount.textContent = `${Object.keys(CARD_DB).length}`;
    cardOwnedHeaders.global = treeCount;
    cardTreeHeader.append(treeChevron, treeTitle, treeCount);

    const cardTree = document.createElement('div');
    cardTree.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

    let cardTreeCollapsed = localStorage.getItem('wildpote_cardtree_collapsed') === 'true';
    const applyTreeCollapsed = () => {
      cardTree.style.display = cardTreeCollapsed ? 'none' : 'flex';
      treeChevron.style.transform = cardTreeCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
    };
    cardTreeHeader.onclick = () => {
      cardTreeCollapsed = !cardTreeCollapsed;
      localStorage.setItem('wildpote_cardtree_collapsed', String(cardTreeCollapsed));
      applyTreeCollapsed();
    };
    applyTreeCollapsed();

    sectionCardFarming.appendChild(cardTreeHeader);
    sectionCardFarming.appendChild(cardTree);

    const cardCheckboxes = new Map();

    const cardsByMap = {};
    Object.entries(CARD_DB).forEach(([cardId, def]) => {
      if (!cardsByMap[def.map]) cardsByMap[def.map] = [];
      cardsByMap[def.map].push({ cardId, ...def });
    });

    MAPS_ORDRE.forEach(mapId => {
      const cards = cardsByMap[mapId];
      if (!cards || cards.length === 0) return;
      cards.sort((a, b) => {
        const r = { regular: 0, elite: 1, boss: 2 };
        return r[a.rarity] - r[b.rarity] || a.enemy.localeCompare(b.enemy);
      });

      const mapGroup = h('div', { class: 'cf-map-group' });
      const mapCount = h('span', { class: 'cf-map-count', text: `${cards.length}` });
      cardOwnedHeaders.perMap.set(mapId, mapCount);
      const mapHeader = h('div', {
        class: 'cf-map-header',
        onclick: () => mapGroup.classList.toggle('is-open'),
      },
        h('span', { class: 'cf-map-chevron', text: '▸' }),
        h('span', { style: { flex: '1' }, text: CARD_MAP_NAMES[mapId] || mapId }),
        mapCount
      );

      const mapList = document.createElement('div');
      mapList.className = 'cf-map-list';

      cards.forEach(({ cardId, enemy, rarity, desc }) => {
        const ownedEl = h('span', { class: 'cf-mob-owned' });
        const updateOwned = () => {
          const count = (getCoop()?.cards?.() || {})[cardId] || 0;
          ownedEl.textContent = count > 0 ? `×${count}` : '';
        };
        updateOwned();

        const cb = h('input', {
          type: 'checkbox',
          checked: cardTargetList.includes(cardId),
          onchange: () => {
            if (cb.checked) {
              if (!cardTargetList.includes(cardId)) {
                cardTargetList.push(cardId);
                saveCardTargetState();
                refreshCardTargetUI();
                logCardTarget(`+ Ajouté ${enemy}`);
              }
            } else {
              cardTargetList = cardTargetList.filter(id => id !== cardId);
              saveCardTargetState();
              refreshCardTargetUI();
              logCardTarget(`− Retiré ${enemy}`);
            }
          },
        });

        const row = h('div', { class: 'cf-mob-row' },
          cb,
          h('span', { class: 'cf-mob-name', text: enemy }),
          h('span', { class: 'cf-mob-desc', text: desc || '' }),
          h('span', {
            class: `cf-mob-rarity ${rarity}`,
            text: rarity === 'boss' ? 'BOSS' : rarity === 'elite' ? 'ELITE' : 'REG',
          }),
          ownedEl
        );

        cardCheckboxes.set(cardId, { input: cb, updateOwned });
        mapList.appendChild(row);
      });

      mapGroup.append(mapHeader, mapList);
      cardTree.appendChild(mapGroup);
    });

    // ── Timberwood : cartes arbres (farming via Town grove) ──
    const timberCards = cardsByMap['timberwood'];
    if (timberCards && timberCards.length > 0) {
      const mapGroup = h('div', { class: 'cf-map-group' });
      const mapCount = h('span', { class: 'cf-map-count', text: `${timberCards.length}` });
      cardOwnedHeaders.perMap.set('timberwood', mapCount);
      const mapHeader = h('div', {
        class: 'cf-map-header',
        onclick: () => mapGroup.classList.toggle('is-open'),
        title: 'Farmé à Timberwood, dans Town (grove ouest)',
      },
        h('span', { class: 'cf-map-chevron', text: '▸' }),
        h('span', { style: { flex: '1' }, text: '🌳 Timberwood (Town)' }),
        mapCount
      );
      const mapList = h('div', { class: 'cf-map-list' });
      timberCards.forEach(({ cardId, enemy, rarity, desc }) => {
        const ownedEl = h('span', { class: 'cf-mob-owned' });
        const updateOwned = () => {
          const count = (getCoop()?.cards?.() || {})[cardId] || 0;
          ownedEl.textContent = count > 0 ? `×${count}` : '';
        };
        updateOwned();
        const cb = h('input', {
          type: 'checkbox',
          checked: cardTargetList.includes(cardId),
          onchange: () => {
            if (cb.checked) {
              if (!cardTargetList.includes(cardId)) {
                cardTargetList.push(cardId);
                saveCardTargetState();
                refreshCardTargetUI();
                logCardTarget(`+ Ajouté ${enemy} (Timberwood)`);
              }
            } else {
              cardTargetList = cardTargetList.filter(id => id !== cardId);
              saveCardTargetState();
              refreshCardTargetUI();
              logCardTarget(`− Retiré ${enemy}`);
            }
          },
        });
        const row = h('div', { class: 'cf-mob-row' },
          cb,
          h('span', { class: 'cf-mob-name', text: enemy }),
          h('span', { class: 'cf-mob-desc', text: desc || '' }),
          h('span', { class: `cf-mob-rarity ${rarity}`, text: rarity === 'elite' ? 'ELITE' : 'REG' }),
          ownedEl
        );
        cardCheckboxes.set(cardId, { input: cb, updateOwned });
        mapList.appendChild(row);
      });
      mapGroup.append(mapHeader, mapList);
      cardTree.appendChild(mapGroup);
    }

    // ── Endless : cartes Warden (une par bande de 10 maps) ──
    const WARDEN_BAND_LABEL = {
      warden_i_card:   'I (maps 1-10)',
      warden_ii_card:  'II (maps 11-20)',
      warden_iii_card: 'III (maps 21-30)',
      warden_iv_card:  'IV (maps 31-40)',
      warden_v_card:   'V (maps 41-50)',
      warden_vi_card:  'VI (maps 51+)',
    };

    const endlessCards = cardsByMap['endless'];
    if (endlessCards && endlessCards.length > 0) {
      const mapGroup = h('div', { class: 'cf-map-group' });
      const mapCount = h('span', { class: 'cf-map-count', text: `${endlessCards.length}` });
      cardOwnedHeaders.perMap.set('endless', mapCount);
      const mapHeader = h('div', {
        class: 'cf-map-header',
        onclick: () => mapGroup.classList.toggle('is-open'),
      },
        h('span', { class: 'cf-map-chevron', text: '▸' }),
        h('span', { style: { flex: '1' }, text: 'Endless (Wardens)' }),
        mapCount
      );

      const mapList = document.createElement('div');
      mapList.className = 'cf-map-list';

      endlessCards.sort((a, b) => a.enemy.localeCompare(b.enemy));

      endlessCards.forEach(({ cardId, enemy, rarity, desc }) => {
        const ownedEl = h('span', { class: 'cf-mob-owned' });
        const updateOwned = () => {
          const count = (getCoop()?.cards?.() || {})[cardId] || 0;
          ownedEl.textContent = count > 0 ? `×${count}` : '';
        };
        updateOwned();

        const cb = h('input', {
          type: 'checkbox',
          checked: cardTargetList.includes(cardId),
          onchange: () => {
            if (cb.checked) {
              if (!cardTargetList.includes(cardId)) {
                cardTargetList.push(cardId);
                saveCardTargetState();
                refreshCardTargetUI();
                logCardTarget(`+ Ajouté ${enemy} (${WARDEN_BAND_LABEL[cardId] || '?'})`);
              }
            } else {
              cardTargetList = cardTargetList.filter(id => id !== cardId);
              saveCardTargetState();
              refreshCardTargetUI();
              logCardTarget(`− Retiré ${enemy}`);
            }
          },
        });

        const row = h('div', { class: 'cf-mob-row' },
          cb,
          h('span', {
            class: 'cf-mob-name',
            text: enemy,
            title: WARDEN_BAND_LABEL[cardId] || undefined,
          }),
          h('span', {
            class: 'cf-mob-desc',
            text: `${WARDEN_BAND_LABEL[cardId] || ''} · ${desc || ''}`,
          }),
          h('span', { class: `cf-mob-rarity ${rarity}`, text: 'BOSS' }),
          ownedEl
        );

        cardCheckboxes.set(cardId, { input: cb, updateOwned });
        mapList.appendChild(row);
      });

      mapGroup.append(mapHeader, mapList);
      cardTree.appendChild(mapGroup);
    }

    const targetListTitle = document.createElement('div');
    targetListTitle.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.14);font-size:10px;font-weight:900;color:#b7c5b7;text-transform:uppercase;';
    targetListTitle.textContent = '🎯 Target list (drag pour ordonner)';
    sectionCardFarming.appendChild(targetListTitle);

    const targetListEl = document.createElement('div');
    targetListEl.className = 'cf-target-list';
    sectionCardFarming.appendChild(targetListEl);

    const copiesRow = document.createElement('div');
    copiesRow.className = 'cf-copies-row';
    const copiesLabel = document.createElement('label');
    copiesLabel.textContent = 'Nombre de copies visées';
    const copiesInput = document.createElement('input');
    copiesInput.type = 'number';
    copiesInput.min = '1';
    copiesInput.max = '99';
    copiesInput.value = String(cardTargetCopies);
    copiesInput.onchange = () => {
      const v = parseInt(copiesInput.value, 10);
      cardTargetCopies = (!isNaN(v) && v > 0) ? Math.min(99, v) : 1;
      copiesInput.value = String(cardTargetCopies);
      saveCardTargetState();
      refreshCardTargetUI();
    };
    copiesRow.append(copiesLabel, copiesInput);
    sectionCardFarming.appendChild(copiesRow);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'cf-actions';
    const btnStart = document.createElement('button');
    btnStart.className = 'wp-btn wp-primary';
    btnStart.textContent = '🎯 TARGET CARDS';
    btnStart.onclick = () => {
      startTargetCardsRoutine().catch(e => pushLog('Erreur target: ' + e.message));
    };
    actionsRow.appendChild(btnStart);

        const btnAllCards = document.createElement('button');
    btnAllCards.className = 'wp-btn wp-primary';
    btnAllCards.textContent = '🎯 ALL CARDS';
    btnAllCards.onclick = () => {
      startAllCardsRoutine().catch(e => pushLog('Erreur all cards: ' + e.message));
    };
    actionsRow.appendChild(btnAllCards);

    const btnClearList = document.createElement('button');
    btnClearList.className = 'wp-btn wp-danger';
    btnClearList.textContent = '🗑️ CLEAR';
    btnClearList.title = 'Vide la liste, décoche tout et arrête le farm en cours';
    btnClearList.onclick = () => {
      // 1. Stop farm si actif
      if (cardTargetRunning) {
        stopCardTarget();
        logCardTarget('🛑 Farm arrêté par CLEAR', 'warn');
      }
      // 2. Vide la liste et repasse en mode target (sinon en mode all
      // la vue continue d'afficher les cartes de la map actuelle)
      cardTargetList = [];
      cardTargetMode = 'target';
      // 3. Décoche tous les checkboxes du tree "Choix des cartes"
      for (const { input } of cardCheckboxes.values()) input.checked = false;
      // 4. Persiste + re-render
      saveCardTargetState();
      refreshCardTargetUI();
      logCardTarget('🗑️ Liste vidée', 'warn');
    };
    actionsRow.appendChild(btnClearList);

    sectionCardFarming.appendChild(actionsRow);

    const statusEl = document.createElement('div');
    statusEl.className = 'cf-status';
    statusEl.style.color = '#888';
    statusEl.textContent = 'Prêt';
    sectionCardFarming.appendChild(statusEl);

    const logsEl = document.createElement('div');
    logsEl.className = 'cf-logs';
    sectionCardFarming.appendChild(logsEl);

    const actionsRow2 = document.createElement('div');
    actionsRow2.className = 'cf-actions';
    actionsRow2.style.marginTop = '4px';

    const btnCopyCardLogs = document.createElement('button');
    btnCopyCardLogs.className = 'wp-btn wp-info';
    btnCopyCardLogs.textContent = '📋 Copier logs card';
    btnCopyCardLogs.onclick = async () => {
      if (cardTargetLogs.length === 0) {
        pushLog('⚠️ Aucun log card à copier');
        return;
      }
      const header = [
        `=== DIAG CARD TARGET v${VERSION} ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Mode: ${cardTargetMode} | Running: ${cardTargetRunning} | Current idx: ${cardTargetCurrentIdx} | Copies cible: ${cardTargetCopies} | maxAggro: ${getMaxAggroEffective()}`,
        `List: ${cardTargetList.join(', ') || '(vide)'}`,
        '--- LOGS ---',
      ].join('\n');
      const body = cardTargetLogs.map(l => `[${l.ts}] (${l.cls}) ${l.msg}`).join('\n');
      const rapport = header + '\n' + body;
      console.log(rapport);
      try {
        await navigator.clipboard.writeText(rapport);
        btnCopyCardLogs.textContent = '✅ Copié !';
        setTimeout(() => { btnCopyCardLogs.textContent = '📋 Copier logs card'; }, 2000);
      } catch (e) {
        btnCopyCardLogs.textContent = '❌ Voir console';
        setTimeout(() => { btnCopyCardLogs.textContent = '📋 Copier logs card'; }, 2000);
      }
    };
    actionsRow2.appendChild(btnCopyCardLogs);

    const btnClearLogs = document.createElement('button');
    btnClearLogs.className = 'wp-btn wp-danger';
    btnClearLogs.textContent = '🗑️ Effacer logs';
    btnClearLogs.onclick = () => {
      cardTargetLogs = [];
      refreshCardTargetLogs();
      pushLog('Logs card effacés');
    };
    actionsRow2.appendChild(btnClearLogs);

    sectionCardFarming.appendChild(actionsRow2);

    const __cardTargetUI_obj = { targetListEl, copiesInputEl: copiesInput, btnStartEl: btnStart, btnAllCardsEl: btnAllCards, statusEl, logsEl };
    return { sectionCardFarming, cardTargetUI: __cardTargetUI_obj, cardCheckboxes };
    }

    const __farmBuild = buildCardFarmingSection();
    panelFarm.appendChild(__farmBuild.sectionCardFarming);
    cardTargetUI = __farmBuild.cardTargetUI;
    const cardCheckboxes = __farmBuild.cardCheckboxes;
    refreshCardTargetUI();
    refreshCardTargetLogs();
    refreshCardOwnedHeaders();

    // New: Auto Mining & Auto Woodcutting sections
    panelFarm.appendChild(buildAutoMiningSection());
    panelFarm.appendChild(buildAutoWoodcuttingSection());
    setInterval(() => {
      if (autoMiningUI) refreshAutoMiningUI();
      if (autoWoodcuttingUI) refreshAutoWoodcuttingUI();
    }, 2000);

        // ── Détection des kills mobs (500 ms) + reset pity sur drop (500 ms) ──
    // Découplé du refresh UI (2s) pour ne pas rater les kills rapides sur les bas niveaux.
        let _lastOwnedSnapshot = null;
    setInterval(() => {
      // 1. Reset pity sur drop détecté (owned[cardId] augmente)
      const ownedNow = getCoop()?.cards?.() || {};
      if (_lastOwnedSnapshot) {
        for (const [cardId, count] of Object.entries(ownedNow)) {
          if (count > (_lastOwnedSnapshot[cardId] || 0)) resetPity(cardId);
        }
      }
      _lastOwnedSnapshot = ownedNow;

      // 2. Consommation de la queue unifiée de kills (mobs + elites + boss)
      // Alimentée par le hook Storage.setItem → pas de dépendance au hook Array.
      try {
        const pending = pageWindow.__wildpote_kills_pending__ || [];
        if (pending.length > 0) {
          pageWindow.__wildpote_kills_pending__ = [];
          for (const { mapId, enemy, count } of pending) {
            const cardId = enemy === 'boss'
              ? resolveBossCardId(mapId)
              : cardIdForEnemy(enemy);
            if (cardId) bumpPity(cardId, count);
          }
        }
      } catch (e) { /* silencieux */ }
    }, 500);

    // ── Refresh UI (2s, inchangé depuis v20.6.18) ──
    setInterval(() => {
      for (const { updateOwned } of cardCheckboxes.values()) updateOwned();
      refreshCardOwnedHeaders();
      refreshTargetListCounts();
      if (!cardTargetRunning) refreshCardTargetUI();
    }, 2000);

    // ─── KITING ───
    function buildKitingPanel() {
      const panelKiting = panels.kiting;
      const toggleKiting = construireToggle('Activer le kiting', kitingActif, (v) => {
        kitingActif = v;
        localStorage.setItem('wildpote_kiting', String(v));
        if (!v) { relacherToutes(); orbitActuelle = null; }
      });
      panelKiting.appendChild(toggleKiting.row);

      const btnDiagKiting = h('button', {
        class: 'wp-btn wp-info',
        text: '📋 Copier diag kiting',
        style: { marginTop: '4px' },
        onclick: async () => {
          const c = getCoop();
          const p = getPositionInterpolee(c);
          const chasersJson = pageWindow.__wildpote_chasers_json__;
          let chasers = [];
          try { if (chasersJson) chasers = JSON.parse(chasersJson); } catch (e) {}
          const lines = [`=== DIAG KITING v${VERSION} ===`];
          lines.push(`Kiting actif: ${kitingActif} | Nav en cours: ${navigationEnCours}`);
          if (p) lines.push(`pos client: (${Math.round(p.x)}, ${Math.round(p.y)}) src=${p.src} age=${p.ts ? Math.round(Date.now() - p.ts) + 'ms' : '?'}`);
          lines.push(`Chasseurs: ${chasers.length}`);
          for (const ch of chasers.slice(0, 5)) lines.push(`  (${Math.round(ch.x)}, ${Math.round(ch.y)}) r=${Math.round(ch.r)} dist=${Math.round(ch.dist)}`);
          if (orbitActuelle) lines.push(`Orbite: r=${Math.round(orbitActuelle.r)} dir=${orbitActuelle.dir > 0 ? '+' : '-'}`);
          lines.push(`Stats: état=${statsKiting.etat} touches=${statsKiting.touches}`);
          const rapport = lines.join('\n');
          console.log(rapport);
          try { await navigator.clipboard.writeText(rapport); btnDiagKiting.textContent = '✅ Copié'; setTimeout(() => { btnDiagKiting.textContent = '📋 Copier diag kiting'; }, 2000); }
          catch (e) { btnDiagKiting.textContent = '❌ Voir console'; setTimeout(() => { btnDiagKiting.textContent = '📋 Copier diag kiting'; }, 2000); }
        },
      });
      panelKiting.appendChild(btnDiagKiting);
    }
    buildKitingPanel();

    // ─── QUEST ───
    function buildQuestPanel() {
    const panelQuest = panels.quest;
    const sectionResume = construireSection('📊 RÉSUMÉ', '#ffd85b');
    const questDoneCount = construireStatusRow('Terminées', '—', 'wp-num');
    const questActiveCount = construireStatusRow('Actives', '—', 'wp-num');
    const questGuild = construireStatusRow('Guild', '—', 'wp-info');
    const questBonus = construireStatusRow('Bonus', '—', 'wp-ok');
    sectionResume.append(questDoneCount.row, questActiveCount.row, questGuild.row, questBonus.row);
    panelQuest.appendChild(sectionResume);

    const sectionActives = construireSection('🎯 QUÊTES ACTIVES', '#69e56f');
    const questActivesContainer = document.createElement('div');
    questActivesContainer.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    sectionActives.appendChild(questActivesContainer);
    panelQuest.appendChild(sectionActives);

    const sectionTerminees = construireSection('✅ TERMINÉES', '#b7c5b7', true);
    const questTermineesContainer = document.createElement('div');
    questTermineesContainer.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:10px;';
    sectionTerminees.appendChild(questTermineesContainer);
    panelQuest.appendChild(sectionTerminees);

    const sectionAutoFarm = construireSection(`🤖 AUTO-FARM QUÊTES v${VERSION}`, '#ff9fd2');
    const btnLaunchAutoFarm = document.createElement('button');
    btnLaunchAutoFarm.className = 'wp-btn wp-primary';
    btnLaunchAutoFarm.textContent = '🚀 LANCER AUTO-FARM QUÊTES';
    btnLaunchAutoFarm.style.marginTop = '4px';
    btnLaunchAutoFarm.onclick = async () => {
      if (autoFarmQuestEnCours) {
        autoFarmQuestActif = false;
        pushLog('🛑 Arrêt demandé');
        return;
      }
      autoFarmQuestActif = true;
      localStorage.setItem('wildpote_autofarmquest', 'true');
      try { await autoFarmQuestRoutine(); } catch (e) { pushLog('❌ Erreur : ' + e.message); }
    };
    sectionAutoFarm.appendChild(btnLaunchAutoFarm);

    const autoFarmLogsContainer = document.createElement('div');
    autoFarmLogsContainer.style.cssText = 'font-size:9px;max-height:150px;overflow-y:auto;white-space:pre-wrap;color:#8aa8c8;margin-top:4px;background:rgba(0,0,0,.3);padding:4px;border-radius:4px;';
    sectionAutoFarm.appendChild(autoFarmLogsContainer);

    const btnCopyAutoFarmLogs = document.createElement('button');
    btnCopyAutoFarmLogs.className = 'wp-btn wp-info';
    btnCopyAutoFarmLogs.textContent = '📋 Copier logs auto-farm';
    btnCopyAutoFarmLogs.style.marginTop = '4px';
    btnCopyAutoFarmLogs.onclick = async () => {
      if (autoFarmQuestLogs.length === 0) { pushLog('⚠️ Aucun log'); return; }
      const header = [`=== DIAG AUTO-FARM v${VERSION} ===`, `Timestamp: ${new Date().toISOString()}`, '--- LOGS ---'].join('\n');
      const body = autoFarmQuestLogs.map(l => `[${l.ts}] (${l.cls}) ${l.msg}`).join('\n');
      try { await navigator.clipboard.writeText(header + '\n' + body); btnCopyAutoFarmLogs.textContent = '✅ Copié !'; setTimeout(() => { btnCopyAutoFarmLogs.textContent = '📋 Copier logs auto-farm'; }, 2000); }
      catch (e) { btnCopyAutoFarmLogs.textContent = '❌ Voir console'; setTimeout(() => { btnCopyAutoFarmLogs.textContent = '📋 Copier logs auto-farm'; }, 2000); }
    };
    sectionAutoFarm.appendChild(btnCopyAutoFarmLogs);
    panelQuest.appendChild(sectionAutoFarm);

    const __questUI_obj = {
      questDoneCount: questDoneCount.val,
      questActiveCount: questActiveCount.val,
      questGuild: questGuild.val,
      questBonus: questBonus.val,
      questActivesContainer,
      questTermineesContainer,
    };
    return { questUI: __questUI_obj, btnLaunchAutoFarm, autoFarmLogsContainer };
    }

    const __questBuild = buildQuestPanel();
    questUI = __questBuild.questUI;
    const btnLaunchAutoFarm = __questBuild.btnLaunchAutoFarm;
    const autoFarmLogsContainer = __questBuild.autoFarmLogsContainer;

    // ─── MISC ───
    function buildMiscPanel() {
    const panelMisc = panels.misc;
    const sectionEtat = construireSection('📊 ÉTAT', '#69e56f');
    const statusMap = construireStatusRow('Map', '—', 'wp-muted');
    const statusClientPos = construireStatusRow('Position', '—', 'wp-info');
    const statusClientSrc = construireStatusRow('Source', '—', 'wp-info');
    sectionEtat.append(statusMap.row, statusClientPos.row, statusClientSrc.row);
    panelMisc.appendChild(sectionEtat);

    const sectionAuto = construireSection('🤖 AUTOMATISATIONS', '#74d8ff');
    const toggleAutoGems = construireToggle('Auto-gems (daily bonus)', autoDailyGemsActif, (v) => { autoDailyGemsActif = v; localStorage.setItem('wildpote_autodailygems', String(v)); pushLog(v ? '💎 ON' : '💎 OFF'); });
    sectionAuto.appendChild(toggleAutoGems.row);
    const toggleAutoLogin = construireToggle('Auto-login', autoLoginActif, (v) => { autoLoginActif = v; localStorage.setItem('wildpote_autologin', String(v)); pushLog(v ? '🔑 ON' : '🔑 OFF'); });
    sectionAuto.appendChild(toggleAutoLogin.row);
    const toggleAutoAd = construireToggle('Auto Ad (rewarded)', autoAdActif, (v) => { autoAdActif = v; localStorage.setItem('wildpote_autoad', String(v)); pushLog(v ? '📺 ON' : '📺 OFF'); if (v) verifierEtLancerPub().catch(() => {}); });
    sectionAuto.appendChild(toggleAutoAd.row);
    panelMisc.appendChild(sectionAuto);

    const logsChevron = h('span', {
      style: { display: 'inline-block', transition: 'transform .15s', fontSize: '9px', color: '#888' },
      text: '▸',
    });
    const logsCopyBtn = h('button', {
      type: 'button',
      style: { background: 'transparent', border: 0, color: '#888', cursor: 'pointer', fontSize: '12px', padding: '0 4px' },
      text: '📋',
      onclick: async (e) => {
        e.preventDefault(); e.stopPropagation();
        const text = logsPre.textContent || '';
        if (!text || text === '(aucun)') { pushLog('⚠️ Aucun log'); return; }
        try { await navigator.clipboard.writeText(text); logsCopyBtn.textContent = '✅'; setTimeout(() => { logsCopyBtn.textContent = '📋'; }, 2000); }
        catch (err) { logsCopyBtn.textContent = '❌'; setTimeout(() => { logsCopyBtn.textContent = '📋'; }, 2000); }
      },
    });
    const logsSummary = h('summary', {
      style: { display: 'flex', alignItems: 'center', gap: '6px', listStyle: 'none', cursor: 'pointer' },
    },
      logsChevron,
      h('span', { style: { flex: '1' }, text: 'Logs récents' }),
      logsCopyBtn
    );
    const logsSection = h('details', { class: 'wp-collapse' }, logsSummary, logsPre);

    const majChevronLogs = () => { logsChevron.style.transform = logsSection.open ? 'rotate(0deg)' : 'rotate(-90deg)'; };
    logsSection.addEventListener('toggle', majChevronLogs);
    majChevronLogs();
    panelMisc.appendChild(logsSection);
    return { statusMap, statusClientPos, statusClientSrc };
    }

    const __miscBuild = buildMiscPanel();
    const statusMap = __miscBuild.statusMap;
    const statusClientPos = __miscBuild.statusClientPos;
    const statusClientSrc = __miscBuild.statusClientSrc;

    document.body.appendChild(box);

    if (!window.__wildpote_console_hijacked__) {
      window.__wildpote_console_hijacked__ = true;
      const originalLog = console.log;
      console.log = function (...args) {
        originalLog.apply(console, args);
        if (typeof args[0] === 'string' && args[0].startsWith('[WildPote]')) {
          const msg = args.slice(1).join(' '); pushLog(msg);
        }
      };
    }

    function switchOnglet(k) {
      ongletActif = k; localStorage.setItem('wildpote_tab', k);
      tabs.querySelectorAll('.wp-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === k));
      content.querySelectorAll('.wp-tab-panel').forEach(p => { p.style.display = p.dataset.tab === k ? 'flex' : 'none'; });
      if (k === 'quest') { mettreAJourQuestsDepuisTracker(); mettreAJourQuests(); }
    }
    switchOnglet(ongletActif);

    function wireDragAndCollapse(box, handle) {
      let collapsed = localStorage.getItem('wildpote_collapsed') === 'true';
      const appliquerCollapse = () => { box.classList.toggle('is-collapsed', collapsed); handle.setAttribute('aria-expanded', String(!collapsed)); };
      appliquerCollapse();
      let drag = false, moved = false, ox = 0, oy = 0;
      handle.onmousedown = (e) => { drag = true; moved = false; ox = e.clientX - box.offsetLeft; oy = e.clientY - box.offsetTop; };
      document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        if (Math.abs(e.clientX - ox - box.offsetLeft) > 3 || Math.abs(e.clientY - oy - box.offsetTop) > 3) moved = true;
        box.style.left = `${e.clientX - ox}px`; box.style.top = `${e.clientY - oy}px`;
      });
      document.addEventListener('mouseup', () => {
        if (!drag) return; drag = false;
        if (!moved) { collapsed = !collapsed; localStorage.setItem('wildpote_collapsed', String(collapsed)); appliquerCollapse(); }
        else localStorage.setItem('wildpote_pos', JSON.stringify({ top: box.style.top, left: box.style.left }));
      });
    }
    wireDragAndCollapse(box, handle);

    function wireIntervals() {
    setInterval(() => {
      const c = getCoop();
      if (!c) return;
      if (!(c.isConnected && c.isConnected())) return;
      const mapId = getMapIdActuel();
      if (!mapId) return;
      setVal(statusMap.val, mapId, 'wp-info');
      const p = getPositionInterpolee(c);
      if (p) {
        setVal(statusClientPos.val, `${Math.round(p.x)}, ${Math.round(p.y)}`, 'wp-info');
        setVal(statusClientSrc.val, p.src, p.src === 'minimap-diamond' ? 'wp-ok' : 'wp-warn');
      }
    }, 250);

    setInterval(() => {
      autoFarmLogsContainer.innerHTML = autoFarmQuestLogs.map(l => `<div class="${l.cls}">[${l.ts}] ${l.msg}</div>`).join('');
      autoFarmLogsContainer.scrollTop = autoFarmLogsContainer.scrollHeight;
    }, 500);

    setInterval(() => {
      if (ongletActif === 'quest') { mettreAJourQuestsDepuisTracker(); mettreAJourQuests(); }
    }, 1000);

    setInterval(() => {
      if (autoFarmQuestEnCours) {
        btnLaunchAutoFarm.textContent = '🛑 ARRÊTER AUTO-FARM';
        btnLaunchAutoFarm.classList.remove('wp-primary');
        btnLaunchAutoFarm.classList.add('wp-danger');
      } else {
        btnLaunchAutoFarm.textContent = '🚀 LANCER AUTO-FARM QUÊTES';
        btnLaunchAutoFarm.classList.remove('wp-danger');
        btnLaunchAutoFarm.classList.add('wp-primary');
      }
    }, 500);

    setInterval(() => {
      const c = getCoop(); if (!c) return;
      try {
        const p = c.prestige?.();
        if (p) setVal(prestigeLevel.val, String(p.level ?? '?'), 'wp-num');
        if (dernierPrestigePerf > 0) {
          const diffSec = Math.floor((Date.now() - dernierPrestigePerf) / 1000);
          const h = Math.floor(diffSec / 3600), m = Math.floor((diffSec % 3600) / 60), s = diffSec % 60;
          setVal(prestigeTimer.val, h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`, 'wp-info');
        } else setVal(prestigeTimer.val, '—', 'wp-muted');
        setVal(prestigeDuree.val, dernierPrestigeDuree || '—', 'wp-ok');
      } catch (e) {}
      const conditions = verifierConditionsPrestige();
      if (conditions.ok) {
        setVal(prestigeStatus.val, `🎯 ${conditions.goal}`, 'wp-info');
        if (autoPrestigeActif && !prestigeEnCours) {
          const elapsed = Date.now() - dernierPrestigeTs;
          const mapActuelle = getMapIdActuel();
          if (prestigeEnAttente) {
            if (mapActuelle && prestigeMapAttente && mapActuelle !== prestigeMapAttente) {
              prestigeEnAttente = false;
              prestigeMapAttente = null;
              declencherPrestige(false).catch(() => {});
            } else {
              setVal(prestigeStatus.val, `⏸️ En attente (${mapActuelle ?? '?'})`, 'wp-warn');
            }
          } else if (elapsed >= 3000) {
            declencherPrestige(false).catch(() => {});
          }
        }
      } else {
        setVal(prestigeStatus.val, conditions.raison, 'wp-muted');
      }
      if (derniereErreurPrestige && !prestigeEnAttente) setVal(prestigeStatus.val, '❌ ' + derniereErreurPrestige, 'wp-bad');
    }, 2000);

    setInterval(() => { verifierEtConnecter(); }, 5000);
    setInterval(() => {
      const c = getCoop(); if (!c) return;
      let claimable = false; try { claimable = c.dailyGemBonusClaimable?.() === true; } catch (e) {}
      if (autoDailyGemsActif && claimable && !gemClaimEnCours) claimDailyGems(false).catch(() => {});
    }, 10000);
    setInterval(() => { verifierEtLancerPub().catch(() => {}); }, AD_CHECK_INTERVAL_MS);
    if (autoAdActif) verifierEtLancerPub().catch(() => {});
    }
    wireIntervals();

    if (localStorage.getItem('wildpote_cardtarget_running') === 'true') {
      localStorage.setItem('wildpote_cardtarget_running', 'false');
      setTimeout(() => {
        if (!cardTargetRunning && cardTargetMode) {
          logCardTarget(`🔄 Reprise automatique (mode=${cardTargetMode})...`, 'info');
          autoCardTargetRoutine().catch(e => console.error(e));
        }
      }, 5000);
    }

    log(`Bot initialisé v${VERSION}`);
  }

    // Exposition des fonctions pity pour debug console
  window.__wildpotePity = {
    pityPct, bumpPity, resetPity, cardIdForEnemy,
    getCardHunterBonus, _loadPity, CARD_DROP_OUTCOMES, CARD_METER_MULTIPLE,
  };

  const __wildpoteDebug = {
    getPortals: () => {
      try {
        const fn = pageWindow.__wildpote_getPortals__;
        if (typeof fn !== 'function') return 'fn absente';
        const json = fn();
        if (!json || json === 'null') return 'null';
        return JSON.parse(json);
      } catch (e) { return 'Erreur: ' + e.message; }
    },
    dumpTracker: () => {
      const q = lireQuetesDepuisTracker();
      if (!q) return 'Tracker vide';
      console.table(q);
      return q;
    },
    dumpPanel: () => {
      const sheet = document.getElementById('autoFarmSheet');
      if (!sheet) return 'Panneau absent';
      const groups = [];
      sheet.querySelectorAll('[data-group]').forEach(row => groups.push({
        group: row.dataset.group,
        mode: row.querySelector('[aria-checked="true"]')?.dataset.mode || 'off',
      }));
      console.table(groups);
      return groups;
    },
    desactiverAutoFarm: () => desactiverAutoFarmPanel(),
    prestigeState: () => ({
      actif: autoPrestigeActif,
      enAttente: prestigeEnAttente,
      mapActuelle: getMapIdActuel(),
      derniereErreur: derniereErreurPrestige,
    }),
    cardTargetState: () => ({
      running: cardTargetRunning,
      mode: cardTargetMode,
      currentIdx: cardTargetCurrentIdx,
      copies: cardTargetCopies,
      maxAggro: getMaxAggroEffective(),
      list: cardTargetList.map(id => ({ cardId: id, ...CARD_DB[id], owned: (getCoop()?.cards?.() || {})[id] || 0 })),
    }),
    cardSetTargets: (cardIds) => {
      const valid = cardIds.filter(id => CARD_DB[id]);
      cardTargetList = valid;
      cardTargetMode = 'target';
      saveCardTargetState();
      refreshCardTargetUI();
      return `Cibles: ${valid.join(', ') || '(aucune)'} (mode=target)`;
    },
    cardSetCopies: (n) => {
      const v = parseInt(n, 10);
      if (!isNaN(v) && v > 0) { cardTargetCopies = v; saveCardTargetState(); refreshCardTargetUI(); }
      return cardTargetCopies;
    },
    cardStart: () => { startTargetCardsRoutine().catch(e => console.error(e)); return 'Démarré (target)'; },
    cardStartAll: () => { startAllCardsRoutine().catch(e => console.error(e)); return 'Démarré (all)'; },
    cardStop: () => { stopCardTarget(); return 'Arrêt demandé'; },
    cardClearLogs: () => {
      cardTargetLogs = [];
      if (cardTargetUI) refreshCardTargetLogs();
      return 'Logs effacés';
    },
    cardDb: () => CARD_DB,
    collectionStats: () => computeOwnedStats(),
    maxAggro: () => {
      const agg = getCoop()?.aggroChallenge?.();
      return {
        api: getMaxAggro(),
        effective: getMaxAggroEffective(),
        aggroChallenge: agg ?? 'indisponible',
        formule: '1 + completed (cap 5), 0 si active',
        overrideManuel: localStorage.getItem('wildpote_maxaggro_manual') || null,
      };
    },
    setMaxAggro: (n) => {
      const v = parseInt(n, 10);
      if (v === 0) { localStorage.removeItem('wildpote_maxaggro_manual'); return 'Override retiré'; }
      if (v >= 1 && v <= 5) { localStorage.setItem('wildpote_maxaggro_manual', String(v)); return `Override = ${v}`; }
      return 'Valeur 0 (retirer) ou 1-5';
    },
    farmTimeout: (ms) => {
      const v = parseInt(ms, 10);
      if (v === 0) { localStorage.removeItem('wildpote_card_timeout_ms'); return 'Timeout réinitialisé (20 min)'; }
      if (!isNaN(v) && v >= 60000) { localStorage.setItem('wildpote_card_timeout_ms', String(v)); return `Timeout = ${Math.round(v/60000)} min`; }
      return 'Valeur en ms attendue (≥ 60000, ou 0 pour reset)';
    },
    farmMapStatus: () => {
      const c = getCoop();
      const pos = c ? getPositionInterpolee(c) : null;
      return {
        currentMap: getMapIdActuel(),
        posClient: pos,
        minimapAge: pos?.ts ? Date.now() - pos.ts : null,
        minimapFrozen: minimapEstFigee(pos),
        maxAggro: getMaxAggroEffective(),
        aggroChallenge: c?.aggroChallenge?.() ?? 'indisponible',
        bossPositions: BOSS_POSITIONS,
        bossHitboxes: BOSS_HITBOXES,
        arenaCentre: ARENA_CENTRE,
        timeout: parseInt(localStorage.getItem('wildpote_card_timeout_ms') || String(20*60*1000), 10),
      };
    },
    enemyStat: (enemy) => ENEMY_REWARD_STAT[enemy] || null,
    enemyGroup: (enemy) => groupeDeEnemy(enemy),
    // Auto Mining / Auto Woodcutting (standalone sections in FARM)
    autoMiningState: () => ({
      active: autoMiningActive, running: autoMiningRunning, inHills: isInHills(),
      mining: getMiningLevel(), list: [...autoMiningList], logs: autoMiningLogs.slice(-10),
    }),
    autoWoodcuttingState: () => ({
      active: autoWoodcuttingActive, running: autoWoodcuttingRunning, inGrove: isInGrove(),
      woodcutting: getWoodcuttingLevel(), list: [...autoWoodcuttingList], logs: autoWoodcuttingLogs.slice(-10),
    }),
    autoMiningStart: () => startAutoMining(),
    autoMiningStop: () => stopAutoMining(),
    autoWoodcuttingStart: () => startAutoWoodcutting(),
    autoWoodcuttingStop: () => stopAutoWoodcutting(),
    // Timberwood: current woodcutting level (from the coop API).
    treeState: () => {
      const sheet = document.getElementById('autoFarmSheet');
      const chopBody = sheet?.querySelector('.farm-chop-body');
      if (!chopBody || chopBody.hidden) return { inGrove: false };
      const trees = Array.from(chopBody.querySelectorAll('[data-tree]')).map(b => ({
        kind: b.dataset.tree,
        disabled: b.disabled,
        checked: b.getAttribute('aria-checked') === 'true',
        reason: b.querySelector('.farm-boss-status')?.textContent?.trim() || '',
      }));
      return {
        inGrove: true,
        woodcutting: getWoodcuttingLevel(),
        isFarming: sheet.classList.contains('is-farming'),
        selection: sheet.querySelector('.farm-selection')?.textContent?.trim() || '',
        trees,
      };
    },
    version: VERSION,
  };
  // Expose on the sandbox window (in case some contexts share it) AND on the page window
  // (so DevTools console can reach it despite @grant unsafeWindow sandboxing).
  window.wildpoteDebug = __wildpoteDebug;
  try {
    if (pageWindow && pageWindow !== window) {
      pageWindow.wildpoteDebug = __wildpoteDebug;
      pageWindow.__wildpotePity = window.__wildpotePity;
    }
  } catch (e) {
    // Some browsers may forbid direct page-window assignment; ignore.
  }
  log(`💡 Debug: wildpoteDebug.cardDb(), .cardTargetState(), .collectionStats(), .cardSetTargets(['needle_card']), .cardSetCopies(3), .cardStart(), .cardStartAll(), .cardStop(), .cardClearLogs(), .maxAggro(), .setMaxAggro(3), .farmTimeout(300000), .farmMapStatus(), .enemyGroup('King Slime')`);
  
  if (document.body) initBot().catch(e => console.error('[WildPote] Erreur init:', e));
  else document.addEventListener('DOMContentLoaded', () => initBot().catch(e => console.error('[WildPote] Erreur init:', e)));
})();
