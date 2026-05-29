'PLUGINEOF'
/**
 * CARD EXPORTER — PENPOT PLUGIN (code.js)
 *
 * Penpot plugin API key facts (verified from official docs):
 *  - penpot.ui.open(name, url, {width, height})
 *  - penpot.ui.sendMessage(msg)  /  penpot.ui.onMessage(callback)
 *  - penpot.currentPage  → current Page object
 *  - penpot.currentFile  → File object with .pages[] array
 *  - page.id, page.name, page.children[] (top-level shapes)
 *  - shape.name, shape.type, shape.children[], shape.x, shape.y, shape.parent
 *  - shape.export({ type: 'png', scale: 1 }) → Promise<Uint8Array>
 *  - shape.clone() → Shape,  shape.remove()
 *  - Text shape: shape.type === 'text', shape.characters (plain string)
 *  - shape.content = rich-text tree (paragraphs → spans with fontWeight etc.)
 *  - penpot.localStorage.setItem(key, value) / .getItem(key) — requires allow:localstorage
 *  - NO penpot.getPage(), NO penpot.root, NO penpot.clientStorage
 */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
const CONFIG = {
  DEFAULT_SEARCH_DEPTH: 3,
  IMG_BASE_URL: "https://tcg-arena-ccg.vercel.app/img",
  STORAGE_KEY: "card_exporter_cache"
};

// ============================================================================
// 2. UTILS
// ============================================================================
const Utils = {
  delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

  toTitleCase: (str) => {
    if (!str) return str;
    return str.replace(/\w\S*/g, (txt) =>
      txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
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
  findNodes: (shape, currentDepth, maxDepth) => {
    let results = [];
    if (shape.name && /^(cards?|token)-(.+)$/i.test(shape.name)) {
      results.push(shape);
    }
    if (currentDepth < maxDepth && shape.children && shape.children.length) {
      for (const child of shape.children) {
        results = results.concat(Scanner.findNodes(child, currentDepth + 1, maxDepth));
      }
    }
    return results;
  },

  getIdentifiedCards: (allCandidates) => {
    let numberedCards = [], pendingCards = [], tokenNodes = [], maxId = 0;

    for (const node of allCandidates) {
      const name = node.name;
      if (name.startsWith("token-")) {
        tokenNodes.push(node);
      } else if (/^card-(\d+)$/.test(name)) {
        const idx = parseInt(name.match(/^card-(\d+)$/)[1], 10);
        if (idx > maxId) maxId = idx;
        numberedCards.push({ node, sortIndex: idx });
      } else if (/^cards?-[?x]+$/.test(name)) {
        pendingCards.push(node);
      }
    }

    let nextId = maxId + 1;
    for (const node of pendingCards) {
      try {
        node.name = `card-${nextId}`;
        numberedCards.push({ node, sortIndex: nextId });
        nextId++;
      } catch (err) { console.error("Renaming failed", err); }
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
  /**
   * Collect all text shapes in a subtree.
   * In Penpot, text shapes have shape.type === 'text'.
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
   * Get the plain-text string from a Penpot text shape.
   * Penpot exposes shape.characters as a flat string — use it directly.
   * If that's unavailable, fall back to walking shape.content (rich-text tree).
   */
  extractPlainText: (textShape) => {
    // Primary: .characters is the simplest flat representation
    if (typeof textShape.characters === 'string') {
      return textShape.characters;
    }
    // Fallback: walk rich-text content tree
    if (!textShape.content) return '';
    const parts = [];
    const walk = (node) => {
      if (typeof node.text === 'string') {
        parts.push(node.text);
      } else if (node.children) {
        const isBlock = node.type === 'paragraph';
        if (isBlock && parts.length > 0) parts.push('\n');
        for (const child of node.children) walk(child);
      }
    };
    walk(textShape.content);
    return parts.join('');
  },

  /**
   * Extract bold phrases from a text shape.
   * Penpot's rich-text content tree has leaf nodes with fontWeight (number)
   * and/or fontStyle. Bold = fontWeight >= 700.
   */
  getBoldedPhrases: (textShape) => {
    if (!textShape.content) return [];
    const bolds = [];
    const walk = (node) => {
      if (typeof node.text === 'string' && node.text.trim()) {
        const fw = parseInt(node.fontWeight || '400', 10);
        const isBold = fw >= 700 || (node.fontStyle || '').toLowerCase().includes('bold');
        if (isBold) {
          for (let part of node.text.split('\n')) {
            let clean = part.replace(/[->.:→]/g, ' ').replace(/\s+/g, ' ').trim();
            clean = Utils.toTitleCase(clean);
            if (clean.length > 1 || /[a-zA-Z0-9]/.test(clean)) bolds.push(clean);
          }
        }
      }
      if (node.children) node.children.forEach(walk);
    };
    walk(textShape.content);
    return bolds;
  },

  parseCard: async (cardShape, assignedId) => {
    const extracted = {
      name: "Unknown", type: "", types: [], keywords: [],
      cost: 0, damage: 0, block: 0, text: "",
      head: false, body: false, leg: false
    };

    const textShapes = Parser.getTextShapes(cardShape);

    for (const shape of textShapes) {
      const rawContent = Parser.extractPlainText(shape);
      const flatContent = rawContent.replace(/[\r\n]+/g, ' ').trim();
      if (!flatContent) continue;

      // 1. Cost
      const costMatch = flatContent.match(/^(\d+)\s*ap$/i);
      if (costMatch) { extracted.cost = parseInt(costMatch[1], 10); continue; }

      // 2. Damage
      const dmgMatch = flatContent.match(/^(\d+|-)\s*dmg$/i);
      if (dmgMatch) { extracted.damage = dmgMatch[1] === '-' ? 0 : parseInt(dmgMatch[1], 10); continue; }

      // 3. Block / Dodge
      if (/block|dodge/i.test(flatContent)) {
        const isDodge = /dodge/i.test(flatContent);
        let val = 0, foundMatch = false;
        const mA = flatContent.match(/^(?:block|dodge)\s*(?:all|head|body|leg)?\s*(\d+)$/i);
        const mB = flatContent.match(/^(\d+)%\s*(?:block|dodge)$/i);
        const mC = flatContent.match(/^(\d+)\s*(?:block|dodge)$/i);
        if (mA) { val = parseInt(mA[1], 10); foundMatch = true; }
        else if (mB) { val = parseInt(mB[1], 10); foundMatch = true; }
        else if (mC) { val = parseInt(mC[1], 10); foundMatch = true; }
        if (foundMatch) { extracted.block = isDodge ? -1 * val : val; continue; }
      }

      // 4. Type + Description
      const typeTextMatch = flatContent.match(/^[^\(]*\((?!-\))([^)]+)\)\s*(.*)/);
      if (typeTextMatch) {
        extracted.types = typeTextMatch[1].split(',').map(t => Utils.toTitleCase(t.trim()));
        extracted.type = extracted.types[0] || '';
        const typeEndIndex = rawContent.indexOf(')');
        extracted.text = typeEndIndex !== -1
          ? rawContent.substring(typeEndIndex + 1).trim()
          : typeTextMatch[2];
        const rawBolds = Parser.getBoldedPhrases(shape);
        extracted.keywords = rawBolds.filter(b => {
          const cleanB = b.replace(/[()]/g, '').trim().toLowerCase();
          return !extracted.types.some(t => t.toLowerCase() === cleanB);
        });
        continue;
      }

      // 5. Zones
      const words = flatContent.split(/\s+/);
      const validZones = ['head', 'body', 'leg'];
      if (words.length > 0 && words.every(w => validZones.includes(w.toLowerCase()))) {
        if (/head/i.test(flatContent)) extracted.head = true;
        if (/body/i.test(flatContent)) extracted.body = true;
        if (/leg/i.test(flatContent)) extracted.leg = true;
        continue;
      }

      // 6. Name fallback
      if (!flatContent.match(/^\d+$/) && flatContent !== '(-)') {
        extracted.name = Utils.toTitleCase(flatContent);
      }
    }

    const imgName = `card-${assignedId}.png`;
    return {
      data: {
        id: String(assignedId), isToken: false,
        face: {
          front: { name: 'Front', type: extracted.type, cost: extracted.cost, image: `${CONFIG.IMG_BASE_URL}/${imgName}`, isHorizontal: false },
          back:  { name: 'Back',  type: '',             cost: extracted.cost, image: `${CONFIG.IMG_BASE_URL}/cardback.png`,  isHorizontal: false }
        },
        name: extracted.name, type: extracted.type, types: extracted.types,
        keywords: extracted.keywords, cost: extracted.cost,
        DMG: extracted.damage, Block: extracted.block, Text: extracted.text,
        'AttackHead?': extracted.head, 'AttackBody?': extracted.body, 'AttackLeg?': extracted.leg
      },
      filename: imgName
    };
  },

  parseToken: (tokenShape) => {
    const match = tokenShape.name.match(/^token-(.+)$/);
    const rawSuffix = match ? match[1] : 'unknown';
    const displayName = Utils.toTitleCase(rawSuffix.replace(/-/g, ' '));
    const imgName = `token-${rawSuffix}.png`;
    return {
      data: {
        id: `t-${rawSuffix}`, isToken: true,
        face: { front: { name: '', type: 'false', cost: 0, image: `${CONFIG.IMG_BASE_URL}/${imgName}`, isHorizontal: false } },
        name: `Token: ${displayName}`, type: 'false', cost: 0, keywords: [],
        'AttackHead?': false, 'AttackBody?': false, 'AttackLeg?': false,
        Text: '', Block: 0, DMG: 0
      },
      filename: imgName
    };
  }
};

// ============================================================================
// 5. MAIN
// ============================================================================

// Open the plugin panel — second arg is the URL; empty string = same origin /ui.html
penpot.ui.open('Card Exporter', '', { width: 520, height: 620 });

/**
 * Look up a page by id from currentFile.pages[].
 * Returns null if not found.
 */
function getPageById(id) {
  const pages = penpot.currentFile && penpot.currentFile.pages;
  if (!pages) return null;
  return pages.find(p => p.id === id) || null;
}

/** Serialize cache to string for localStorage */
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

// Build page list for UI init
function getPages() {
  const file = penpot.currentFile;
  const currentId = penpot.currentPage ? penpot.currentPage.id : null;
  if (!file || !file.pages) return [];
  return file.pages.map(p => ({ id: p.id, name: p.name, current: p.id === currentId }));
}

// --- BOOT ---
(async () => {
  let storedCache = loadCache();

  penpot.ui.sendMessage({
    type: 'init-state',
    pages: getPages(),
    lastScanDate: storedCache ? storedCache.timestamp : null,
    lastScanCount: storedCache ? Object.keys(storedCache.json).length : 0,
    lastJson: storedCache ? JSON.stringify(storedCache.json, null, 2) : ''
  });

  penpot.ui.onMessage(async (msg) => {

    // ── EXPORT JSON + IMAGES ──────────────────────────────────────────────
    if (msg.type === 'run-scan') {
      const pageNode = getPageById(msg.pageId);
      if (!pageNode) {
        penpot.ui.sendMessage({ type: 'error', message: 'Page not found' });
        return;
      }

      const scanDepth = msg.scanDepth || CONFIG.DEFAULT_SEARCH_DEPTH;
      const allCandidates = Scanner.findNodes(pageNode, 0, scanDepth);
      const { numberedCards, tokenNodes } = Scanner.getIdentifiedCards(allCandidates);
      if (numberedCards.length > 0) await Utils.delay(100);

      const finalMap = {};
      const totalItems = numberedCards.length + tokenNodes.length;
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
      for (const node of tokenNodes) await processNode(node, null, Parser.parseToken);

      const newCache = { timestamp: Date.now(), json: finalMap };
      storedCache = newCache;
      saveCache(newCache);
      penpot.ui.sendMessage({ type: 'complete', json: JSON.stringify(finalMap, null, 2), count: Object.keys(finalMap).length });
    }

    // ── SYNC CONTENT ──────────────────────────────────────────────────────
    else if (msg.type === 'run-extract') {
      try {
        const sourcePage = getPageById(msg.sourceId);
        const targetPage = getPageById(msg.targetId);
        if (!sourcePage || !targetPage) throw new Error('Pages not found');

        const sourceCandidates = Scanner.findNodes(sourcePage, 0, CONFIG.DEFAULT_SEARCH_DEPTH);
        const { numberedCards: srcNumbered, tokenNodes: srcTokens } = Scanner.getIdentifiedCards(sourceCandidates);

        const sourceMap = new Map();
        srcNumbered.forEach(item => sourceMap.set(`card-${item.sortIndex}`, item.node));
        srcTokens.forEach(node => sourceMap.set(node.name, node));

        const targetCandidates = Scanner.findNodes(targetPage, 0, CONFIG.DEFAULT_SEARCH_DEPTH);
        let updateCount = 0;

        for (const targetNode of targetCandidates) {
          let targetId = null;
          if (targetNode.name.startsWith('token-')) {
            targetId = targetNode.name;
          } else {
            const m = targetNode.name.match(/^card-(\d+)$/);
            if (m) targetId = `card-${m[1]}`;
          }

          if (targetId && sourceMap.has(targetId)) {
            const sourceNode = sourceMap.get(targetId);
            const newShape = sourceNode.clone();
            // Preserve target position
            newShape.x = targetNode.x;
            newShape.y = targetNode.y;
            targetNode.remove();
            updateCount++;
          }
        }

        penpot.ui.sendMessage({ type: 'extract-complete', count: updateCount });
      } catch (err) {
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
    }

    // ── MINIDECK DATA ─────────────────────────────────────────────────────
    else if (msg.type === 'extract-minideck-data') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error('Page not found');

        const minidecks = [];
        const usedHues = [];

        for (const deckFrame of (pageNode.children || [])) {
          const t = (deckFrame.type || '').toLowerCase();
          if (t !== 'frame' && t !== 'group' && t !== 'bool') continue;
          if (deckFrame.name.toLowerCase().startsWith('card-')) continue;

          const uniqueColor = Utils.getDistinctBrightColor(usedHues);
          const deckObj = { name: deckFrame.name, description: 'Generated from Penpot', color: uniqueColor, cardPool: [] };

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

                const parsed = await Parser.parseCard(cardNode, cardId);
                const synergies = [`${parsed.data.cost} AP`];
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
    }

    // ── STATS DATA ────────────────────────────────────────────────────────
    else if (msg.type === 'get-stats-data') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error('Page not found');

        const allCandidates = Scanner.findNodes(pageNode, 0, CONFIG.DEFAULT_SEARCH_DEPTH);
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
    }

    // ── TRANSFORM CARDS ───────────────────────────────────────────────────
    else if (msg.type === 'run-transform') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error('Page not found');

        // Find a component named 'Card' in the library
        const libComponents = penpot.library && penpot.library.local
          ? penpot.library.local.components
          : [];
        const cardComponent = libComponents.find(c => c.name === 'Card') || null;

        if (!cardComponent) throw new Error("Could not find a component named 'Card' in the local library.");

        const allCandidates = Scanner.findNodes(pageNode, 0, CONFIG.DEFAULT_SEARCH_DEPTH);
        const { numberedCards } = Scanner.getIdentifiedCards(allCandidates);

        let minX = Infinity, minY = Infinity, maxX = -Infinity;
        for (const { node } of numberedCards) {
          if (node.x < minX) minX = node.x;
          if (node.x + node.width > maxX) maxX = node.x + node.width;
          if (node.y < minY) minY = node.y;
        }

        const offsetX = maxX + 1000;
        let transformCount = 0;

        for (const item of numberedCards) {
          const cardId = item.sortIndex;
          const oldNode = item.node;
          const parsed = await Parser.parseCard(oldNode, cardId);
          const data = parsed.data;

          const newInstance = cardComponent.createInstance
            ? cardComponent.createInstance()
            : null;
          if (!newInstance) continue;

          newInstance.x = offsetX + (oldNode.x - minX);
          newInstance.y = minY + (oldNode.y - minY);
          newInstance.name = `card-${cardId}`;

          // Update named text children
          const setChildText = (childName, value) => {
            if (value === undefined || value === null) return;
            const textShapes = Parser.getTextShapes(newInstance);
            for (const ts of textShapes) {
              if (ts.name === childName) {
                try { ts.characters = String(value); } catch (e) {}
                return;
              }
            }
          };

          setChildText('AP Cost Text', `${data.cost}`);
          let valueText = '';
          if ((data.type || '').toUpperCase() === 'GUARD') valueText = `${Math.abs(data.Block)}`;
          else if (['GUN', 'MELEE'].includes((data.type || '').toUpperCase())) valueText = `${data.DMG}`;
          setChildText('Card Value Text', valueText);
          setChildText('Card Name', (data.name || '').toUpperCase());
          setChildText('Card Type Text', (data.type || '').toUpperCase());
          setChildText('Card Effect Text', Utils.toTitleCase(data.Text || ''));

          transformCount++;
        }

        penpot.ui.sendMessage({ type: 'transform-complete', count: transformCount });
      } catch (err) {
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
    }
  });
})();
PLUGINEOF