(function () {
  'use strict';

  if (document.getElementById('wildpote-ui')) return;

  // --- Constantes ---
  const TOWN_ARRIVAL = { x: 6120, y: 5110 };
  const TOWN_TRAVEL_PORTAL = { x: 4780, y: 3635 };  // TOWN_TRAVEL_PORTAL de town.ts

  const getCoop = () => window.wildstatCoop || window.wildwoodCoop || null;

  // --- Création de l'UI ---
  const ui = document.createElement('div');
  ui.id = 'wildpote-ui';
  ui.innerHTML = `
    <div id="wildpote-header">
      <span>🐾 WildPote V2</span>
      <button id="wildpote-toggle">_</button>
    </div>
    <div id="wildpote-body">
      <button id="btn-home" class="wp-btn">🏠 Home</button>
      <button id="btn-travel" class="wp-btn">🗺️ Voyage (picker)</button>
      <div id="wp-status">Attente...</div>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #wildpote-ui {
      position: fixed; top: 100px; left: 20px; z-index: 2147483647;
      width: 220px; background: #121218; color: #f0f0f0;
      border: 1px solid #2d2d3d; border-radius: 8px;
      font-family: system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    }
    #wildpote-header {
      padding: 8px 12px; background: #1e1e2a; cursor: move;
      display: flex; justify-content: space-between; align-items: center;
      font-weight: bold; font-size: 13px;
      border-top-left-radius: 7px; border-top-right-radius: 7px;
      user-select: none;
    }
    #wildpote-toggle { background: none; border: none; color: #888; cursor: pointer; }
    #wildpote-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .wp-btn {
      padding: 8px 12px; background: #6366f1; color: white; border: none;
      border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
      transition: background 0.2s;
    }
    .wp-btn:hover:not(:disabled) { background: #4f46e5; }
    .wp-btn:disabled { background: #27272a; color: #52525b; cursor: not-allowed; }
    #wp-status { font-size: 11px; color: #a1a1aa; text-align: center; margin-top: 4px; white-space: pre-line; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(ui);

  // --- Drag & Drop ---
  const header = document.getElementById('wildpote-header');
  let isDragging = false, offsetX = 0, offsetY = 0;
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    offsetX = e.clientX - ui.offsetLeft;
    offsetY = e.clientY - ui.offsetTop;
  });
  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      ui.style.left = `${e.clientX - offsetX}px`;
      ui.style.top = `${e.clientY - offsetY}px`;
    }
  });
  document.addEventListener('mouseup', () => { isDragging = false; });

  const toggleBtn = document.getElementById('wildpote-toggle');
  const body = document.getElementById('wildpote-body');
  toggleBtn.addEventListener('click', () => {
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'flex' : 'none';
    toggleBtn.textContent = isHidden ? '_' : '+';
  });

  const statusEl = document.getElementById('wp-status');
  const btnHome = document.getElementById('btn-home');
  const btnTravel = document.getElementById('btn-travel');

  // --- Helpers ---
  const setStatus = (text) => { statusEl.textContent = text; };
  const log = (...args) => console.log('[WildPote]', ...args);

  // --- État live (polling 500ms) ---
  setInterval(() => {
    const c = getCoop();
    if (!c) { setStatus('❌ API non trouvée'); return; }
    if (!c.isConnected?.()) { setStatus('🔌 Non connecté'); return; }
    const s = c.localState?.();
    if (!s) { setStatus('⏳ État local indisponible'); return; }
    setStatus(`✅ ${s.mapId}\n(${Math.round(s.x)}, ${Math.round(s.y)})`);
  }, 500);

  // --- 🏠 Home : changeMap("town", x, y) ---
  async function goHome() {
    const c = getCoop();
    if (!c?.isConnected?.()) throw new Error('Non connecté au serveur');
    const s = c.localState?.();
    if (!s) throw new Error('Position indisponible');
    if (s.mapId === 'town') { setStatus('✅ Déjà en town'); return; }
    log('Home → changeMap("town",', s.x, ',', s.y, ')');
    setStatus('⏳ Home...');
    const ok = await c.changeMap('town', s.x, s.y);
    log('Home résultat:', ok);
    setStatus(ok ? '✅ Home OK' : '❌ Home refusé');
  }

  btnHome.addEventListener('click', async () => {
    try { await goHome(); }
    catch (e) { log('Home erreur:', e); setStatus('❌ ' + e.message); }
  });

  // --- 🗺️ Voyage via picker natif ---
  // 1. Ouvre le picker (via le portail de town, ou si déjà ouvert, on l'utilise)
  // 2. Sélectionne une destination
  // 3. Clique sur Travel
  
  async function openTravelPicker() {
    // Vérifie qu'on est en town
    const c = getCoop();
    const s = c?.localState?.();
    if (!s || s.mapId !== 'town') throw new Error('Voyage disponible uniquement depuis town');

    // Le picker s'ouvre en marchant sur le portail de voyage (TOWN_TRAVEL_PORTAL)
    // Alternative : le picker est un <dialog> qui s'ouvre via updatePortal() du jeu
    // quand le joueur est près du portail. On vérifie s'il est déjà ouvert.
    const dialog = document.querySelector('dialog.travel-sheet');
    if (dialog?.open) { log('Picker déjà ouvert'); return dialog; }

    // Sinon, on simule un déplacement vers le portail via des keydown
    // OU on attend que le joueur marche dessus manuellement
    // Pour le PoC, on affiche un message et on attend
    log('Position actuelle:', s.x, s.y, '— portail à:', TOWN_TRAVEL_PORTAL.x, TOWN_TRAVEL_PORTAL.y);
    const dist = Math.hypot(s.x - TOWN_TRAVEL_PORTAL.x, s.y - TOWN_TRAVEL_PORTAL.y);
    if (dist > 60) {
      throw new Error(`Marche jusqu'au portail (${Math.round(dist)} unités). Le picker s'ouvrira.`);
    }
    // Trop proche, le picker devrait s'ouvrir naturellement dans les 500ms suivantes
    await new Promise(r => setTimeout(r, 800));
    const dialog2 = document.querySelector('dialog.travel-sheet');
    if (!dialog2?.open) throw new Error('Picker pas ouvert — rapproche-toi du portail');
    return dialog2;
  }

  async function pickDestination(dialog, destination) {
    // Cherche le bouton de la destination dans le picker
    // Pour Endless, c'est un cas spécial (bouton + input number)
    // Pour les maps de campagne, c'est data-map="<mapId>"
    const btn = dialog.querySelector(`[data-map="${destination}"]`);
    if (!btn) throw new Error(`Destination "${destination}" non trouvée dans le picker`);
    if (btn.disabled) throw new Error(`Destination "${destination}" verrouillée`);
    btn.click();
    log('Destination sélectionnée:', destination);
  }

  async function clickTravel(dialog) {
    const go = dialog.querySelector('.travel-go');
    if (!go) throw new Error('Bouton Travel introuvable');
    if (go.disabled) throw new Error('Bouton Travel désactivé');
    go.click();
    log('Travel cliqué');
  }

  btnTravel.addEventListener('click', async () => {
    try {
      setStatus('⏳ Ouverture picker...');
      const dialog = await openTravelPicker();

      // Pour le PoC, on demande à l'utilisateur de choisir dans le picker
      // puis on ne fait rien (l'utilisateur clique lui-même Travel)
      setStatus('✅ Picker ouvert\nChoisis ta destination');
      log('Picker ouvert, en attente du choix utilisateur');

      // Alternative automatisée (décommenter pour choisir automatiquement) :
      // await pickDestination(dialog, 'endless_8');
      // await clickTravel(dialog);

    } catch (e) {
      log('Voyage erreur:', e);
      setStatus('❌ ' + e.message);
    }
  });

  log('V2 chargée. Home + Voyage picker prêts.');
})();
