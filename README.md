WildPote — Documentation technique
1. Contexte

Bot pour WildStat MMO (wildstatmmo.com), un jeu de farm/ARPG idle joué dans le navigateur. Le bot est injecté via Tampermonkey (userscript) et interagit avec l'API officielle du jeu exposée en JavaScript.

Objectif V1 : piloter les déplacements majeurs (retour town) et l'état du joueur via l'API native, sans jamais manipuler le WebSocket ni contourner les règles serveur.
2. Architecture du jeu (ce qu'il faut savoir)
2.1 Stack

    Frontend : modules ES chargés par le site, bundle coop-client.*.js + game.*.js

    Backend : SpacetimeDB (maincloud.spacetimedb.com, database wildwood-coop)

    Auth : JWT SpacetimeDB stocké dans localStorage (clés auth_token/spacetimeauth_id_token_v1, etc.)

    Communication : WebSocket binaire (BSATN), pas du JSON

2.2 API publique exposée

Le jeu expose un objet global window.wildstatCoop (et un alias legacy window.wildwoodCoop) via :
js

Object.defineProperty(window, 'wildstatCoop', {
  value: wildstatCoop,
  writable: false,
  configurable: false,
  enumerable: true
});

Cet objet est figé (Object.freeze) : ses méthodes ne peuvent pas être remplacées. Il est posé à la fin du chargement du module wildstat-coop.ts, donc après la connexion SpacetimeDB initiale.

Méthodes utiles (non exhaustif) :
Méthode	Signature	Usage
isConnected()	() → boolean	Vérifier la connexion au serveur
localState()	() → {x, y, facing, speed, moving, mapId}	Position + map actuelles
localIdentity()	() → string	Identité du joueur
changeMap(mapId, x, y)	(string, number, number) → Promise<boolean>	Changer de map (mécanique du bouton Home)
findTeleportPlayer(query)	(string) → Promise<{identity, mapId}>	Dev uniquement
devTeleportToPlayer(id, mapId)	(string, string) → Promise<boolean>	Dev uniquement
devTeleportEndless(n)	(number) → Promise<{ok, error}>	Dev uniquement
syncMovementState(x, y, vx, vy, source, force, area, extra)	multiple	Envoi position (géré par le jeu)
useTownDoor(index)	(number) → Promise	Entrer/sortir d'un bâtiment en town
fallIntoWell()	() → Promise	Retour place de town (puits)
sendChatMessage(...)		Chat
startResearch(id), startItemUpgrade(...), mineNode(...)		Actions de jeu

⚠️ Les callbacks setOn* (ex: setOnItemDrop) sont réservés au jeu lui-même : ils ne peuvent être revendiqués qu'une fois. Ne jamais les utiliser dans un userscript.
2.3 Maps connues

    town : hub principal, pas de portails vers les zones de jeu. Arrivée à (6120, 5110).

    home_exterior : alias historique qui redirige vers town côté serveur. Ne pas utiliser directement, préférer town.

    Maps de campagne : tutorial_forest, beginner_desert, …, ion_citadel (15 maps).

    Maps Endless : endless_1, endless_2, … (générées).

2.4 Mécaniques de déplacement (deux systèmes distincts)

    Portails in-world : pour passer d'une zone de campagne à une autre (ou entre endless). Le joueur marche jusqu'au portail, le traverse, la map change. Aucun portail ne relie town aux zones de jeu.

    Bouton menu « Home » : seul moyen de rentrer en town depuis une zone. Appelle changeMap("town", player.x, player.y). Le jeu mémorise la map de départ (homeDeparture) pour le bouton « Retour », mais ce champ n'est pas exposé dans l'API publique.

2.5 Validation serveur

changeMap est validé côté serveur :

    La position passée doit être valide pour la map cible (cohérence avec les murs, portails, etc.)

    changeMap("endless_8", ...) depuis town échoue avec "Move closer to the portal" — il faut passer par le picker de voyage (mécanique UI)

    changeMap("town", player.x, player.y) depuis n'importe où fonctionne (c'est le bouton Home natif)

3. Le problème du CSP et sa solution
3.1 Le CSP du site

Le site impose :
text

script-src 'self' 'unsafe-eval'

Conséquences :

    ❌ Les scripts injectés dynamiquement (<script src="...">, <script>inline</script>) sont bloqués, même depuis la console DevTools.

    ❌ GM_addElement('script', {...}) de Tampermonkey est bloqué sur Chrome et Firefox.

    ❌ unsafeWindow.eval(...) depuis un userscript classique est bloqué.

    ✅ 'unsafe-eval' autorise eval() dans le contexte de la page, mais pas dans la sandbox isolée du userscript.

3.2 Isolation Tampermonkey

Par défaut, un userscript tourne dans une sandbox dont window est un proxy isolé de la vraie window de la page. unsafeWindow pointe vers la vraie window, mais :

    Sur Chrome : unsafeWindow est un proxy qui ne propage pas les ajouts dynamiques (Object.defineProperty faits après l'exécution du userscript ne sont pas visibles).

    Sur Firefox : unsafeWindow est soumis à la Xray Vision qui cache aussi les ajouts dynamiques.

3.3 ✅ La solution qui marche (Firefox) : @sandbox JavaScript

Firefox uniquement. Crée un contexte USERSCRIPT_WORLD qui bypass le CSP et donne accès à la vraie page via unsafeWindow.wrappedJSObject.

En-tête Tampermonkey :
text

// @sandbox JavaScript
// @grant unsafeWindow

Code d'accès :
js

const pageWindow = typeof unsafeWindow !== 'undefined'
  ? (unsafeWindow.wrappedJSObject || unsafeWindow)
  : window;

const getCoop = () => pageWindow.wildstatCoop || pageWindow.wildwoodCoop || null;

Attendre que l'API soit prête :
js

function waitForCoopReady() {
  return new Promise((resolve) => {
    const check = () => {
      const c = getCoop();
      if (c && c.isConnected && c.isConnected()) return resolve(c);
      setTimeout(check, 300);
    };
    check();
  });
}

3.4 ❌ Ce qui ne marche pas (à ne pas réessayer)
Tentative	Firefox	Chrome
@grant none + window.wildstatCoop	❌ sandbox	❌ sandbox
@grant unsafeWindow + unsafeWindow.wildstatCoop	❌ Xray	❌ proxy
GM_addElement('script', {textContent})	❌ CSP	❌ CSP
unsafeWindow.eval(code)	❌ CSP	❌ CSP
Injection <script> inline	❌ CSP	❌ CSP
Injection <script src="data:...">	❌ CSP	❌ CSP
Blob + <script src="blob:...">	❌ CSP	❌ CSP
3.5 Chrome — non résolu

Sur Chrome, @sandbox JavaScript n'existe pas. Le CSP bloque toutes les méthodes d'injection. Statut : non supporté pour l'instant.

Pistes futures :

    Extension Chrome dédiée (utilisant chrome.scripting.executeScript avec world: 'MAIN')

    Attendre que Tampermonkey expose un équivalent Chrome de @sandbox JavaScript

4. Le bot actuel (V8.0 — Firefox)
4.1 Architecture

    Fichier unique : WildPote.user.js (Tampermonkey)

    Pas d'injection externe : tout le code est dans le userscript (contourne le CSP par @sandbox JavaScript)

    Pas d'interception WebSocket : on utilise l'API wildstatCoop directement

    Pas de callbacks réservés : on ne touche à aucun setOn*, donc compatible avec WildBot et autres scripts

4.2 Fonctionnalités
Bouton	Action	Mécanique
🏠 Home	changeMap('town', x, y)	Identique au bouton menu natif
🗺️ Voyage	Détecte le picker natif ouvert	Nécessite de marcher jusqu'au portail (peu fiable en bot)
📍 État	Affichage live de localState()	Polling 500ms
4.3 Limitations connues

    Voyage picker peu fiable : le picker ne s'ouvre qu'en marchant sur le portail de town (4780, 3635). Un bot ne peut pas s'y rendre facilement sans simuler le clavier.

    Pas de retour automatique : le champ homeDeparture n'est pas exposé ; le bot doit mémoriser lui-même la map de départ s'il veut proposer un « Retour ».

    Chrome non supporté : voir §3.5.

5. Développement — workflow
5.1 Tester une modification

    Éditer WildPote.user.js dans Tampermonkey (icône → Edit → Ctrl+S)

    Recharger la page du jeu (F5)

    Ouvrir la console (F12) → logs [WildPote]

    L'UI apparaît en haut à gauche

5.2 Debug dans la console de la page

Pendant que le userscript tourne, la console DevTools n'a pas accès à unsafeWindow (c'est un objet Tampermonkey). Mais elle a accès à window.wildstatCoop directement (c'est le contexte de la page). Donc pour tester des appels :
js

// Dans la console DevTools de la page (pas Tampermonkey)
window.wildstatCoop.isConnected()
window.wildstatCoop.localState()
await window.wildstatCoop.changeMap('town', 100, 100)

⚠️ Redéclaration : si tu fais plusieurs tests, const c = window.wildstatCoop plante la 2e fois. Utilise (async () => { ... })() pour isoler.
5.3 Erreurs courantes
Message	Cause	Solution
Content-Security-Policy : ... script-src-elem	Injection <script> bloquée	Utiliser @sandbox JavaScript (Firefox)
wildstatCoop: undefined	API pas encore exposée ou sandbox isolée	Attendre (waitForCoopReady) ou passer en @sandbox JavaScript
Move closer to the portal	changeMap vers une map de jeu sans portail proche	Seul changeMap('town', ...) marche depuis n'importe où
Invalid teleport position	Position invalide pour la map cible	Passer player.x, player.y actuels
6. Pistes d'extension
6.1 Auto-farm (complexe)

Nécessite de simuler le clavier (KeyboardEvent sur document) pour déclencher les déplacements. Le jeu a son propre auto-farm natif — mieux vaut le configurer via ses switches que réinventer.
6.2 Voyage automatisé (moyen)

Simuler le clavier pour marcher jusqu'au portail de town, puis laisser le picker s'ouvrir et cliquer sur une destination. Fragile.
6.3 Actions directes (simple)

Utiliser les reducers exposés :

    startResearch(id) — lancer une recherche

    startItemUpgrade(slot, itemId, position) — upgrade un item

    mineNode(x, y) — miner

    sendChatMessage(...) — chat

6.4 Lecture d'état (simple)

    gemBalance(), inventorySlotsUnlocked(), savedProgress(), prestige(), activeResearch(), etc.

    Toutes ces méthodes sont sûres (lecture seule) et ne sont pas des callbacks réservés.

7. Historique des décisions
Version	Décision	Raison
V1	Interception WebSocket via patch prototype.send	❌ Ne fonctionne pas (CSP + timing)
V2-V5	Injection <script> externe (raw.githack)	❌ Bloqué par CSP
V6	GM_addElement	❌ Bloqué par CSP
V7	unsafeWindow.eval	❌ Bloqué par CSP
V8	@sandbox JavaScript + unsafeWindow.wrappedJSObject	✅ Seule méthode fonctionnelle sur Firefox
8. Ressources

    Code du bot : WildPote.user.js

    Ancien bot (référence pour les hooks et techniques) : WildBot.user.js (v12.9.3)

    Dépôt GitHub : github.com/vincentzell/WildPote

    Documentation SpacetimeDB : spacetimedb.com/docs

    Documentation Tampermonkey : tampermonkey.net/documentation

    Doc MDN sur la Xray Vision Firefox : developer.mozilla.org/en-US/docs/Mozilla/Gecko/Script_security#Xray_vision
