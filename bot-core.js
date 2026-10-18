(function () {
  'use strict';

  if (document.getElementById('wildpote-ui')) return;

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
      <div id="wp-status">Attente WS...</div>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #wildpote-ui {
      position: fixed; top: 100px; left: 20px; z-index: 2147483647;
      width: 200px; background: #121218; color: #f0f0f0;
      border: 1px solid #2d2d3d; border-radius: 8px;
      font-family: system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,0.6);
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

  // --- Fonction de récupération de la socket ---
  function getActiveSocket() {
    return window.__WILDPOTE_WS__ || null;
  }

  // Mettre à jour l'affichage du statut si la socket est prête
  setInterval(() => {
    const ws = getActiveSocket();
    const statusEl = document.getElementById('wp-status');
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (statusEl.textContent.includes('Attente WS')) {
        statusEl.textContent = 'WS : Connecté !';
      }
    }
  }, 1000);

  // --- Actions ---
  const btnHome = document.getElementById('btn-home');
  const btnReturn = document.getElementById('btn-return');
  const statusEl = document.getElementById('wp-status');

  btnHome.addEventListener('click', () => {
    const ws = getActiveSocket();

    if (ws && ws.readyState === WebSocket.OPEN) {
      statusEl.textContent = 'Envoi Teleport Home...';

      // Reducer officiel change_map vers "home_exterior"
      const payload = JSON.stringify({
        reducer: "change_map",
        args: {
          map_id: "home_exterior"
        }
      });

      try {
        ws.send(payload);
        statusEl.textContent = 'Demande envoyée !';
        btnReturn.disabled = false;
      } catch (e) {
        console.error('[WildPote] Erreur d\'envoi WS:', e);
        statusEl.textContent = 'Erreur lors de l\'envoi';
      }
    } else {
      statusEl.textContent = 'Socket non trouvée/ouverte';
      console.warn('[WildPote] Socket réseau non prête dans window.__WILDPOTE_WS__');
    }
  });

  btnReturn.addEventListener('click', () => {
    const ws = getActiveSocket();

    if (ws && ws.readyState === WebSocket.OPEN) {
      statusEl.textContent = 'Envoi Retour Town...';

      const payload = JSON.stringify({
        reducer: "change_map",
        args: {
          map_id: "town"
        }
      });

      try {
        ws.send(payload);
        statusEl.textContent = 'Retour envoyé !';
      } catch (e) {
        console.error('[WildPote] Erreur d\'envoi WS:', e);
        statusEl.textContent = 'Erreur lors de l\'envoi';
      }
    } else {
      statusEl.textContent = 'Socket non trouvée/ouverte';
    }
  });
})();
