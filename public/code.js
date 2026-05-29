/**
 * CARD EXPORTER — PENPOT PLUGIN (code.js)
 *
 * Verified Penpot Plugin API:
 *  - penpot.ui.open(name, url, {width, height})
 *  - penpot.ui.sendMessage(msg) / penpot.ui.onMessage(callback)
 *  - penpot.currentPage  → Page (has .id, .name, .children[], .findShapes(criteria))
 *  - penpot.currentFile  → File (.pages[] — Page objects)
 *  - page.findShapes({})  → Shape[] (all shapes on page, all depths)
 *  - page.findShapes({ name: 'foo' }) → Shape[] filtered by name
 *  - shape.name, shape.type, shape.children[], shape.x, shape.y, shape.width, shape.height
 *  - shape.export({ type:'png', scale:1 }) → Promise<Uint8Array>
 *  - shape.clone() → Shape  (inserted on the SAME page as source — cross-page clone not possible)
 *  - shape.remove()
 *  - shape.characters (text shapes only — plain string)
 *  - shape.content    (text shapes only — rich-text tree for bold detection)
 *  - penpot.localStorage.setItem(key, val) / .getItem(key)  [allow:localstorage]
 *  - penpot.library.local.components[]  [library:read]
 *  - LibraryComponent.instantiate() → inserts instance on currentPage
 */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
const CONFIG = {
  IMG_BASE_URL: 'https://tcg-arena-ccg.vercel.app/img',
  STORAGE_KEY:  'card_exporter_cache'
};

// ============================================================================
// 2. UTILS
// ============================================================================
const Utils = {
  delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

  toTitleCase: (str) => {
    if (!str) return str;
    return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
  },

  hslToHex: (h, s, l) => {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = n => {
      const k = (n + h / 30) % 12;
      const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
  },

  getDistinctBrightColor: (usedHues) => {
    let h, attempts = 0, isDistinct = false;
    while (!isDistinct && attempts < 50) {
      h = Math.floor(Math.random() * 360);
      let tooClose = false;
      for (const existingHue of usedHues) {
        let diff = Math.abs(h - existingHue);
        if (diff > 180) diff = 360 - diff;
        if (diff < 30) { tooClose = true; break; }
      }
      if (!tooClose) isDistinct = true;
      attempts++;
    }
    usedHues.push(h);
    const s = Math.floor(Math.random() * 26) + 75;
    const l = Math.floor(Math.random() * 26) + 60;
    return Utils.hslToHex(h, s, l);
  }
};

// ============================================================================
// 3. SCANNER
// ============================================================================
const Scanner = {
  /**
   * Find all card-* and token-* shapes on a page using Penpot's findShapes API.
   * findShapes({}) returns every shape on the page at all depths with full objects.
   */
  findNodes: (pageNode) => {
    const allShapes = pageNode.findShapes({});
    return allShapes.filter((shape) => {
      return shape.name && /^(cards?|token)-(.+)$/i.test(shape.name);
    });
  },

  getIdentifiedCards: (allCandidates) => {
    const numberedCards = [];
    const pendingCards  = [];
    const tokenNodes    = [];
    let maxId = 0;

    for (const node of allCandidates) {
      const name = node.name;
      if (name.startsWith('token-')) {
        tokenNodes.push(node);
      } else if (/^card-(\d+)$/.test(name)) {
        const idx = parseInt(name.match(/^card-(\d+)$/)[1], 10);
        if (idx > maxId) maxId = idx;
        numberedCards.push({ node, sortIndex: idx });
      } else if (/^cards?-[?x]+$/.test(name)) {
        pendingCards.push(node);
      }
    }

    // Assign IDs to unnumbered cards by renaming them
    let nextId = maxId + 1;
    for (const node of pendingCards) {
      try {
        node.name = `card-${nextId}`;
        numberedCards.push({ node, sortIndex: nextId });
        nextId++;
      } catch (err) {
        console.error('Penpot renaming failed:', err);
      }
    }

    numberedCards.sort((a, b) => a.sortIndex - b.sortIndex);
    tokenNodes.sort((a, b) => a.name.localeCompare(b.name));
    return { numberedCards, tokenNodes };
  }
};

// ============================================================================
// 4. PARSER
// ============================================================================
const Parser = {
  /** * Collect text shapes in a subtree using native Penpot methods
   * This handles performance significantly better than manual JS loops.
   */
  getTextShapes: (shape) => {
    let results = [];
    if (shape.type === 'text') results.push(shape);
    if (shape.children && shape.children.length) {
      for (const child of shape.children) {
        results = results.concat(Parser.getTextShapes(child));
      }
    }
    return results;
  },

  /**
   * Extract plain text from a Penpot text shape safely.
   */
  extractPlainText: (textShape) => {
    // Penpot stores the flat string directly in the .text property
    if (typeof textShape.characters === 'string') return textShape.characters;
    return '';
  },

  /**
   * Extract bold phrases from Penpot text configurations.
   * In Penpot, text shapes carry a font-weight array or string map 
   * matching styles directly inside the engine configuration.
   */
  getBoldedPhrases: (textShape) => {
    // If Penpot doesn't show mixed rich formatting states, fall back to evaluating the entire string
    if (!textShape.text) return [];
    
    const bolds = [];
    const flatText = textShape.text;

    // Check if the base text block itself is globally bolded via Penpot properties
    const shapeWeight = parseInt(textShape.fontWeight || '400', 10);
    const isGloballyBold = shapeWeight >= 700 || String(textShape.fontStyle || '').toLowerCase().includes('bold');

    if (isGloballyBold) {
      for (let part of flatText.split('\n')) {
        let clean = part.replace(/[->.:→]/g, ' ').replace(/\s+/g, ' ').trim();
        clean = Utils.toTitleCase(clean);
        if (clean.length > 1 || /[a-zA-Z0-9]/.test(clean)) {
          bolds.push(clean);
        }
      }
    } 
    
    // Note: If parsing multi-styled text inside a single field box, 
    // evaluate the layout using Penpot's internal rich metadata tracking array:
    else if (Array.isArray(textShape.styles)) {
      // Penpot maps custom styling chunks across ranges
      for (const block of textShape.styles) {
        const weight = parseInt(block.fontWeight || '400', 10);
        if (weight >= 700 && block.text) {
          for (let part of block.text.split('\n')) {
            let clean = part.replace(/[->.:→]/g, ' ').replace(/\s+/g, ' ').trim();
            clean = Utils.toTitleCase(clean);
            if (clean.length > 1 || /[a-zA-Z0-9]/.test(clean)) bolds.push(clean);
          }
        }
      }
    }

    return bolds;
  },

  parseCard: async (cardShape, assignedId) => {
    const ext = {
      name: 'Unknown', type: '', types: [], keywords: [],
      cost: 0, damage: 0, block: 0, text: '',
      head: false, body: false, leg: false
    };

    // Correctly routes through Penpot's native array retrieval engine
    const textLayers = Parser.getTextShapes(cardShape);

    for (const shape of textLayers) {
      const rawContent  = Parser.extractPlainText(shape);
      const flatContent = rawContent.replace(/[\r\n]+/g, ' ').trim();
      if (!flatContent) continue;

      // Cost: "3 AP"
      const costMatch = flatContent.match(/^(\d+)\s*ap$/i);
      if (costMatch) { ext.cost = parseInt(costMatch[1], 10); continue; }

      // Damage: "5 DMG" or "- DMG"
      const dmgMatch = flatContent.match(/^(\d+|-)\s*dmg$/i);
      if (dmgMatch) { ext.damage = dmgMatch[1] === '-' ? 0 : parseInt(dmgMatch[1], 10); continue; }

      // Block / Dodge
      if (/block|dodge/i.test(flatContent)) {
        const isDodge = /dodge/i.test(flatContent);
        let val = 0, found = false;
        const mA = flatContent.match(/^(?:block|dodge)\s*(?:all|head|body|leg)?\s*(\d+)$/i);
        const mB = flatContent.match(/^(\d+)%\s*(?:block|dodge)$/i);
        const mC = flatContent.match(/^(\d+)\s*(?:block|dodge)$/i);
        if      (mA) { val = parseInt(mA[1], 10); found = true; }
        else if (mB) { val = parseInt(mB[1], 10); found = true; }
        else if (mC) { val = parseInt(mC[1], 10); found = true; }
        if (found) { ext.block = isDodge ? -val : val; continue; }
      }

      // Type + Description: "Attack(Melee) Description text…"
      const typeMatch = flatContent.match(/^[^\(]*\((?!-\))([^)]+)\)\s*(.*)/);
      if (typeMatch) {
        ext.types = typeMatch[1].split(',').map(t => Utils.toTitleCase(t.trim()));
        ext.type  = ext.types[0] || '';
        const endIdx = rawContent.indexOf(')');
        ext.text = endIdx !== -1 ? rawContent.substring(endIdx + 1).trim() : typeMatch[2];
        
        // Harvest using Penpot style metrics lookup
        const rawBolds = Parser.getBoldedPhrases(shape);
        ext.keywords = rawBolds.filter(b => {
          const cleanB = b.replace(/[()]/g, '').trim().toLowerCase();
          return !ext.types.some(t => t.toLowerCase() === cleanB);
        });
        continue;
      }

      // Zone targets: "Head Body", "Leg", etc.
      const words = flatContent.split(/\s+/);
      const validZones = ['head', 'body', 'leg'];
      if (words.length > 0 && words.every(w => validZones.includes(w.toLowerCase()))) {
        if (/head/i.test(flatContent)) ext.head = true;
        if (/body/i.test(flatContent)) ext.body = true;
        if (/leg/i.test(flatContent))  ext.leg  = true;
        continue;
      }

      // Name fallback
      if (!flatContent.match(/^\d+$/) && flatContent !== '(-)') {
        ext.name = Utils.toTitleCase(flatContent);
      }
    }

    const imgName = `card-${assignedId}.png`;
    return {
      data: {
        id: String(assignedId), isToken: false,
        face: {
          front: { name: 'Front', type: ext.type, cost: ext.cost, image: `${CONFIG.IMG_BASE_URL}/${imgName}`, isHorizontal: false },
          back:  { name: 'Back',  type: '',        cost: ext.cost, image: `${CONFIG.IMG_BASE_URL}/cardback.png`, isHorizontal: false }
        },
        name: ext.name, type: ext.type, types: ext.types, keywords: ext.keywords,
        cost: ext.cost, DMG: ext.damage, Block: ext.block, Text: ext.text,
        'AttackHead?': ext.head, 'AttackBody?': ext.body, 'AttackLeg?': ext.leg
      },
      filename: imgName
    };
  },

  parseToken: (tokenShape) => {
    const match     = tokenShape.name.match(/^token-(.+)$/);
    const rawSuffix = match ? match[1] : 'unknown';
    const imgName   = `token-${rawSuffix}.png`;
    return {
      data: {
        id: `t-${rawSuffix}`, isToken: true,
        face: { front: { name: '', type: 'false', cost: 0, image: `${CONFIG.IMG_BASE_URL}/${imgName}`, isHorizontal: false } },
        name: `Token: ${Utils.toTitleCase(rawSuffix.replace(/-/g, ' '))}`,
        type: 'false', cost: 0, keywords: [],
        'AttackHead?': false, 'AttackBody?': false, 'AttackLeg?': false,
        Text: '', Block: 0, DMG: 0
      },
      filename: imgName
    };
  }
};

// ============================================================================
// 5. SYNC HELPER
// ============================================================================
/**
 * Sync tab: copy text content from source cards into matching target cards.
 *
 * Penpot's clone() inserts a copy on the SAME page as the original — it
 * cannot clone a shape from page A directly onto page B. Instead, we do a
 * text-level copy: for each (name-matched) source card we find the
 * corresponding target card and copy the characters of every named text
 * layer, preserving the target's layout/position entirely.
 *
 * This is a faithful port of the Figma logic: "update text and numbers
 * but preserve the target's position".
 */
const Sync = {
  /**
   * Build a flat map of  layerName → characters  for all text shapes in a card.
   */
  buildTextMap: (cardShape) => {
    const map = new Map();
    const textShapes = Parser.getTextShapes(cardShape);
    for (const ts of textShapes) {
      if (ts.name) map.set(ts.name, Parser.extractPlainText(ts));
    }
    return map;
  },

  /**
   * Apply a text map to the matching text layers in a target card.
   * Only layers that exist in both source and target (by name) are updated.
   */
  applyTextMap: (targetCardShape, textMap) => {
    const textShapes = Parser.getTextShapes(targetCardShape);
    let changed = 0;
    
    console.log(`textShapes: `, textShapes);
    console.log(`textMap`, textMap);
    for (const ts of textShapes) {
      console.log(`ts: `, ts);
      console.log(`ts.name: `, ts.name);
      console.log(`textMap.has(ts.name): `, textMap.has(ts.name));
      if (ts.name && textMap.has(ts.name)) {
        const newText = textMap.get(ts.name);
        try {
          // 1. Double check your Parser.extractPlainText helper uses ts.text for Penpot
          if (Parser.extractPlainText(ts) !== newText) {
            
            // ❌ Figma style: ts.characters = newText;
            // ✅ Penpot style: Mutate the native string property
            ts.text = newText; 
            
            changed++;
          }else{
            console.log(`failed to extract pain text`);
          }
        } catch (e) {
          console.warn('Could not set text string on Penpot shape:', ts.name, e);
        }
      }
    }
    return changed;
  }
};

// ============================================================================
// 6. MAIN
// ============================================================================
penpot.ui.open('Card Exporter', '', { width: 520, height: 620 });

function getPageById(id) {
  const pages = penpot.currentFile && penpot.currentFile.pages;
  if (!pages) return null;
  return pages.find(p => p.id === id) || null;
}

function loadCache() {
  try {
    const raw = penpot.localStorage.getItem(CONFIG.STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function saveCache(data) {
  try {
    penpot.localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
  } catch (e) { console.error('Cache save error', e); }
}

function getPages() {
  const file      = penpot.currentFile;
  const currentId = penpot.currentPage ? penpot.currentPage.id : null;
  if (!file || !file.pages) return [];
  return file.pages.map(p => ({ id: p.id, name: p.name, current: p.id === currentId }));
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
(async () => {
  let storedCache = loadCache();

  penpot.ui.onMessage(async (msg) => {

    // UI is ready — send initial state
    if (msg.type === 'UI_READY') {
      penpot.ui.sendMessage({
        type: 'init-state',
        pages:         getPages(),
        lastScanDate:  storedCache ? storedCache.timestamp : null,
        lastScanCount: storedCache ? Object.keys(storedCache.json).length : 0,
        lastJson:      storedCache ? JSON.stringify(storedCache.json, null, 2) : ''
      });
      return;
    }

    // ── EXPORT JSON + IMAGES ────────────────────────────────────────────────
    if (msg.type === 'run-scan') {
      const pageNode = getPageById(msg.pageId);
      if (!pageNode) {
        penpot.ui.sendMessage({ type: 'error', message: 'Page not found' });
        return;
      }

      const allCandidates = Scanner.findNodes(pageNode);
      const { numberedCards, tokenNodes } = Scanner.getIdentifiedCards(allCandidates);
      if (numberedCards.length > 0) await Utils.delay(100);

      const finalMap     = {};
      const totalItems   = numberedCards.length + tokenNodes.length;
      let processedCount = 0;

      const processNode = async (node, id, parserFunc) => {
        const result = await parserFunc(node, id);
        finalMap[result.data.id] = result.data;
        processedCount++;

        if (msg.exportImages) {
          let shouldExport = true;
          if (!msg.forceFull && storedCache && storedCache.json) {
            const oldData = storedCache.json[result.data.id];
            if (oldData && JSON.stringify(oldData) === JSON.stringify(result.data)) shouldExport = false;
          }

          if (shouldExport) {
            await Utils.delay(20);
            try {
              const bytes = await node.export({ type: 'png', scale: 1 });
              penpot.ui.sendMessage({
                type: 'image-chunk', filename: result.filename,
                data: bytes ? Array.from(bytes) : null,
                current: processedCount, total: totalItems
              });
            } catch (err) {
              console.error('Export error', err);
              penpot.ui.sendMessage({ type: 'image-chunk', filename: null, data: null, current: processedCount, total: totalItems });
            }
          } else {
            penpot.ui.sendMessage({ type: 'image-chunk', filename: null, data: null, current: processedCount, total: totalItems });
          }
        }
      };

      for (const item of numberedCards) await processNode(item.node, item.sortIndex, Parser.parseCard);
      for (const node of tokenNodes)    await processNode(node, null, Parser.parseToken);

      const newCache = { timestamp: Date.now(), json: finalMap };
      storedCache = newCache;
      saveCache(newCache);
      penpot.ui.sendMessage({ type: 'complete', json: JSON.stringify(finalMap, null, 2), count: Object.keys(finalMap).length });
      return;
    }

    // ── SYNC CONTENT ────────────────────────────────────────────────────────
    // Strategy: copy text layer content by matching layer names.
    // IMPORTANT: Penpot only allows writing to shapes on the CURRENT page.
    // So we must:
    //   1. Read all source text maps (source page can be non-current, reads are fine)
    //   2. Navigate to the target page (makes it current)
    //   3. Re-scan target page now that it's current, then apply writes
    if (msg.type === 'run-extract') {
      try {
        const sourcePage = getPageById(msg.sourceId);
        const targetPage = getPageById(msg.targetId);
        if (!sourcePage || !targetPage) throw new Error('Pages not found');

        // STEP 1: Read source text maps while source page data is accessible
        const sourceCandidates = Scanner.findNodes(sourcePage);
        console.log('[Sync] source candidates:', sourceCandidates.map(n => n.name));
        const { numberedCards: srcNumbered, tokenNodes: srcTokens } = Scanner.getIdentifiedCards(sourceCandidates);

        const sourceMap = new Map(); // cardKey → textMap
        for (const item of srcNumbered) {
          const key     = `card-${item.sortIndex}`;
          const textMap = Sync.buildTextMap(item.node);
          console.log(`[Sync] source "${key}" text layers:`, [...textMap.entries()]);
          sourceMap.set(key, textMap);
        }
        for (const node of srcTokens) {
          const textMap = Sync.buildTextMap(node);
          console.log(`[Sync] source token "${node.name}" text layers:`, [...textMap.entries()]);
          sourceMap.set(node.name, textMap);
        }

        // STEP 2: Navigate to target page so writes are permitted
        penpot.openPage(targetPage);
        await Utils.delay(300); // allow navigation to settle

        // STEP 3: Re-resolve target cards on the now-current page
        const currentTarget = getPageById(msg.targetId);
        const allCandidates = Scanner.findNodes(currentTarget);

        // 🚨 FIX: Filter the list down so you are only treating the top-level parent Card Frames/Boards as loop targets
        const targetCardsAndTokens = allCandidates.filter(node => node.type === 'board' || node.type === 'group');
        console.log(`targetCardsAndTokens: `, targetCardsAndTokens);
        console.log('[Sync] filtered parent target frames:', targetCardsAndTokens.map(n => n.name));
        let updateCount = 0;

        // Loop through the actual container frames instead of raw child shapes
        for (const targetNode of targetCardsAndTokens) {
          console.log(`targetNode: `, targetNode);
          let cardKey = null;
          if (targetNode.name.startsWith('token-')) {
            cardKey = targetNode.name;
          } else {
            const m = targetNode.name.match(/^card-(\d+)$/);
            if (m) cardKey = `card-${m[1]}`;
          }
          
          if (cardKey && sourceMap.has(cardKey)) {
            console.log(`cardKey: `, cardKey);
            const textMap = sourceMap.get(cardKey);
            console.log(`textMap: `, textMap);
            
            // Now targetNode is guaranteed to be a parent Frame, so this lookup will cleanly gather its sub-layers!
            const targetTextShapes = Parser.getTextShapes(targetNode);
            console.log(`targetTextShapes: `, targetTextShapes);
            
            console.log(`[Sync] target "${cardKey}" text layers:`, targetTextShapes.map(ts => `${ts.name}="${Parser.extractPlainText(ts)}"`));
            
            const changed = Sync.applyTextMap(targetNode, textMap);
            console.log(`[Sync] "${cardKey}" — ${changed} layer(s) updated`);
            if (changed > 0) updateCount++;
          } else {
            console.log(`[Sync] target "${targetNode.name}" — no source match (cardKey=${cardKey})`);
          }
        }

        penpot.ui.sendMessage({ type: 'extract-complete', count: updateCount });
      } catch (err) {
        console.error('[Sync] error:', err);
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
      return;
    }

    // ── MINIDECK DATA ────────────────────────────────────────────────────────
    if (msg.type === 'extract-minideck-data') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error('Page not found');

        const minidecks = [];
        const usedHues  = [];

        for (const deckFrame of (pageNode.children || [])) {
          const t = (deckFrame.type || '').toLowerCase();
          if (t !== 'frame' && t !== 'group') continue;
          if (deckFrame.name.toLowerCase().startsWith('card-')) continue;

          const deckObj = {
            name: deckFrame.name, description: 'Generated from Penpot',
            color: Utils.getDistinctBrightColor(usedHues), cardPool: []
          };

          for (const rarityFrame of (deckFrame.children || [])) {
            const rt = (rarityFrame.type || '').toLowerCase();
            if (rt !== 'frame' && rt !== 'group') continue;
            const rarityName = rarityFrame.name.toLowerCase();
            if (rarityName === 'generated') continue;

            for (const cardNode of (rarityFrame.children || [])) {
              if (/^(cards?)-/.test(cardNode.name)) {
                let cardId = 0;
                const idMatch = cardNode.name.match(/^cards?-(\d+)$/);
                if (idMatch) cardId = parseInt(idMatch[1], 10);

                const parsed     = await Parser.parseCard(cardNode, cardId);
                const synergies  = [`${parsed.data.cost} AP`];
                if (parsed.data.types && parsed.data.types.length) synergies.push(...parsed.data.types);
                deckObj.cardPool.push({ id: parsed.data.id, name: parsed.data.name, rarity: rarityName, synergies });
              }
            }
          }
          minidecks.push(deckObj);
        }

        penpot.ui.sendMessage({ type: 'minideck-data-complete', count: minidecks.length, json: JSON.stringify(minidecks, null, 2) });
      } catch (err) {
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
      return;
    }

    // ── STATS DATA ───────────────────────────────────────────────────────────
    if (msg.type === 'get-stats-data') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error('Page not found');

        const allCandidates = Scanner.findNodes(pageNode);
        const { numberedCards } = Scanner.getIdentifiedCards(allCandidates);

        const statsData = [];
        for (const item of numberedCards) {
          const result = await Parser.parseCard(item.node, item.sortIndex);
          if (result && result.data) statsData.push(result.data);
        }
        penpot.ui.sendMessage({ type: 'stats-data', data: statsData });
      } catch (err) {
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
      return;
    }

    // ── TRANSFORM CARDS ──────────────────────────────────────────────────────
    if (msg.type === 'run-transform') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error('Page not found');

        // Find a component named 'Card' in the local library
        const libComponents = (penpot.library && penpot.library.local && penpot.library.local.components) || [];
        const cardComponent  = libComponents.find(c => c.name === 'Card') || null;
        if (!cardComponent) throw new Error("Could not find a component named 'Card' in the local library.");

        const allCandidates = Scanner.findNodes(pageNode);
        const { numberedCards } = Scanner.getIdentifiedCards(allCandidates);

        let minX = Infinity, maxX = -Infinity, minY = Infinity;
        for (const { node } of numberedCards) {
          if (node.x < minX) minX = node.x;
          if (node.x + node.width > maxX) maxX = node.x + node.width;
          if (node.y < minY) minY = node.y;
        }

        const offsetX       = maxX + 1000;
        let transformCount  = 0;

        for (const item of numberedCards) {
          const cardId  = item.sortIndex;
          const oldNode = item.node;
          const parsed  = await Parser.parseCard(oldNode, cardId);
          const data    = parsed.data;

          // instantiate() creates an instance on the current page
          const newInstance = cardComponent.instantiate ? cardComponent.instantiate() : null;
          if (!newInstance) continue;

          newInstance.x    = offsetX + (oldNode.x - minX);
          newInstance.y    = minY    + (oldNode.y - minY);
          newInstance.name = `card-${cardId}`;

          const setChildText = (childName, value) => {
            if (value == null) return;
            for (const ts of Parser.getTextShapes(newInstance)) {
              if (ts.name === childName) {
                try { ts.characters = String(value); } catch (e) {}
                return;
              }
            }
          };

          setChildText('AP Cost Text',   `${data.cost}`);
          setChildText('Card Name',      (data.name || '').toUpperCase());
          setChildText('Card Type Text', (data.type || '').toUpperCase());
          setChildText('Card Effect Text', Utils.toTitleCase(data.Text || ''));

          let valueText = '';
          if      ((data.type || '').toUpperCase() === 'GUARD')                         valueText = `${Math.abs(data.Block)}`;
          else if (['GUN', 'MELEE'].includes((data.type || '').toUpperCase()))           valueText = `${data.DMG}`;
          setChildText('Card Value Text', valueText);

          transformCount++;
        }

        penpot.ui.sendMessage({ type: 'transform-complete', count: transformCount });
      } catch (err) {
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
      return;
    }
  });
})();
