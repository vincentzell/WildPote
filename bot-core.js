(function () {
  'use strict';

  if (document.getElementById('wildpote-ui')) return;

  // Variable locale pour mémoriser la position avant téléportation
  let savedPosition = null;

  // --- Recherche de la connexion SpacetimeDB ---
  function getSpacetimeConnection() {
    // Inspection des objets globaux connus ou recherche dans le scope window
    if (window.conn) return window.conn;
    if (window.game && window.game.conn) return window.game.conn;
    if (window.spacetimedb) return window.spacetimedb;
    return null;
  }

  // --- Création de l'UI ---
  const ui = document.createElement('div');
  ui.id = 'wildpote-ui';
  ui.innerHTML = `
    <div id="wildpote-header">
      <span>🐾 WildPote V1</span>
      <button id="wildpote-toggle">_</button>
    </div>
    <div id="wildpote-body">
      <button id="btn-home" class="wp-btn">🏠 Teleport Home</button>
      <button id="btn-return" class="wp-btn" disabled>🔙 Retour</button>
      <div id="wp-status">Prêt</div>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #wildpote-ui {
      position: fixed; top: 100px; left: 20px; z-index: 999999;
      width: 200px; background: #121218; color: #f0f0f0;
      border: 1px solid #2d2d3d; border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    }
    #wildpote-header {
      padding: 8px 12px; background: #1e1e2a; cursor: move;
      display: flex; justify-content: space-between; align-items: center;
      font-weight: bold; font-size: 13px; border-top-left-radius: 7px; border-top-right-radius: 7px;
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
    #wp-status { font-size: 11px; color: #a1a1aa; text-align: center; margin-top: 4px; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(ui);

  // --- Déplacement de l'UI (Drag & Drop) ---
  const header = document.getElementById('wildpote-header');
  let isDragging = false, offsetX = 0, offsetY = 0;

  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    offsetX = e.clientX - ui.offsetLeft;
    offsetY = e.clientY - ui.offsetTop;
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    ui.style.left = `${e.clientX - offsetX}px`;
    ui.style.top = `${e.clientY - offsetY}px`;
  });

  document.addEventListener('mouseup', () => { isDragging = false; });

  // Réductions de la fenêtre UI
  const toggleBtn = document.getElementById('wildpote-toggle');
  const body = document.getElementById('wildpote-body');
  toggleBtn.addEventListener('click', () => {
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'flex' : 'none';
    toggleBtn.textContent = isHidden ? '_' : '+';
  });

  // --- Gestion de la Téléportation ---
  const btnHome = document.getElementById('btn-home');
  const btnReturn = document.getElementById('btn-return');
  const statusEl = document.getElementById('wp-status');

  btnHome.addEventListener('click', () => {
    const conn = getSpacetimeConnection();
    statusEl.textContent = 'Téléportation en cours...';

    if (conn && conn.reducers) {
      // Appel du reducer de téléportation vers la Home/Recall si disponible
      if (typeof conn.reducers.teleportHome === 'function') {
        conn.reducers.teleportHome();
      } else if (typeof conn.reducers.recall === 'function') {
        conn.reducers.recall();
      } else {
        console.log('[WildPote] Reducers disponibles :', Object.keys(conn.reducers));
      }

      btnReturn.disabled = false;
      statusEl.textContent = 'Téléporté à la Home !';
    } else {
      statusEl.textContent = 'Connexion non trouvée';
      console.warn('[WildPote] Connexion SpacetimeDB introuvable sur window.');
    }
  });

  btnReturn.addEventListener('click', () => {
    const conn = getSpacetimeConnection();
    if (savedPosition && conn && conn.reducers) {
      statusEl.textContent = 'Retour en cours...';
      // Exécution de la téléportation vers les coordonnées enregistrées
      if (typeof conn.reducers.teleport === 'function') {
        conn.reducers.teleport(savedPosition);
      }
      statusEl.textContent = 'Retour effectué !';
    } else {
      statusEl.textContent = 'Aucune position sauvegardée';
    }
  });
})();
