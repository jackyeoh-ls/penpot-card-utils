/**
 * CARD EXPORTER — PENPOT PLUGIN
 *
 * STRUCTURE:
 * 1. CONFIG   - Global settings
 * 2. UTILS    - Helper functions (colors, text formatting)
 * 3. SCANNER  - Logic for finding shapes in the Penpot tree
 * 4. PARSER   - Logic for extracting text/data from cards
 * 5. MAIN     - Entry point and message handler
 *
 * Penpot API notes vs Figma:
 *  - penpot.currentPage  →  figma.currentPage
 *  - penpot.getPage(id)  →  figma.getNodeByIdAsync(id)   (sync in Penpot)
 *  - shape.name, shape.children, shape.type
 *  - shape.type values: 'frame','group','text','rect','circle','path','image','component','instance'
 *  - Text content: shape.content  (rich-text document) — we walk characters blocks
 *  - Export: shape.export({ type:'png', scale:1 }) → Uint8Array
 *  - Storage: penpot.clientStorage  (same API as Figma)
 *  - Pages: penpot.root.children (each is a Page)  /  penpot.currentPage
 *  - Clone: shape.clone()  — same concept
 *  - Rename: shape.name = newName
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
    let h;
    let attempts = 0;
    let isDistinct = false;
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
    const s = Math.floor(Math.random() * (100 - 75 + 1)) + 75;
    const l = Math.floor(Math.random() * (85 - 60 + 1)) + 60;
    return Utils.hslToHex(h, s, l);
  }
};


// ============================================================================
// 3. SCANNER (Shape Traversal)
// ============================================================================
const Scanner = {
  /**
   * Recursively finds shapes named "card-*" or "token-*".
   * Penpot shapes have .name and .children (array or undefined).
   */
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

  /** Sorts candidates into numbered cards, pending cards, and tokens. */
  getIdentifiedCards: (allCandidates) => {
    let numberedCards = [];
    let pendingCards = [];
    let tokenNodes = [];
    let maxId = 0;

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

    // Assign IDs to unnumbered cards
    let nextId = maxId + 1;
    for (const node of pendingCards) {
      const newName = `card-${nextId}`;
      try {
        node.name = newName;
        numberedCards.push({ node, sortIndex: nextId });
        nextId++;
      } catch (err) {
        console.error("Renaming failed", err);
      }
    }

    numberedCards.sort((a, b) => a.sortIndex - b.sortIndex);
    tokenNodes.sort((a, b) => a.name.localeCompare(b.name));

    return { numberedCards, tokenNodes };
  }
};


// ============================================================================
// 4. PARSER (Data Extraction)
// ============================================================================
const Parser = {
  /**
   * Extracts all plain text strings from a shape tree.
   * Penpot text shapes store content as a rich-text document:
   *   shape.content = { type:'root', children:[{ type:'paragraph', children:[{ text:'...' }] }] }
   * We walk it to collect text segments along with bold info.
   */
  getTextShapes: (shape) => {
    let results = [];
    if (shape.type === 'text' || shape.type === 'TEXT') {
      results.push(shape);
    }
    if (shape.children && shape.children.length) {
      for (const child of shape.children) {
        results = results.concat(Parser.getTextShapes(child));
      }
    }
    return results;
  },

  /**
   * Given a Penpot text shape, returns the plain-text string
   * by walking the rich-text content tree.
   */
  extractPlainText: (textShape) => {
    if (!textShape.content) return textShape.characters || "";
    const lines = [];
    const walk = (node) => {
      if (node.text !== undefined) {
        lines.push(node.text);
      } else if (node.children) {
        let isBlock = node.type === 'paragraph' || node.type === 'root';
        if (isBlock && lines.length > 0 && node.type === 'paragraph') {
          lines.push("\n");
        }
        for (const child of node.children) walk(child);
      }
    };
    walk(textShape.content);
    return lines.join("").replace(/^\n/, "");
  },

  /**
   * Extracts bold phrases from a Penpot text shape's rich-text content.
   * Bold segments have fontStyle containing 'bold', 'heavy', or 'black'.
   */
  getBoldedPhrases: (textShape) => {
    if (!textShape.content) return [];
    const bolds = [];

    const walk = (node) => {
      if (node.text !== undefined) {
        const style = (node.fontStyle || node.fontWeight || "").toString().toLowerCase();
        const isBold = style.includes('bold') || style.includes('700') ||
                       style.includes('800') || style.includes('900') ||
                       style.includes('heavy') || style.includes('black');
        // Also check fontStyle property on the segment level
        const segBold = (node.bold === true) || (node.fontWeight && parseInt(node.fontWeight) >= 700);
        if (isBold || segBold) {
          const parts = node.text.split('\n');
          for (let part of parts) {
            let clean = part.replace(/[->.:→]/g, " ").replace(/\s+/g, " ").trim();
            clean = Utils.toTitleCase(clean);
            if (clean.length > 1 || /[a-zA-Z0-9]/.test(clean)) {
              bolds.push(clean);
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) walk(child);
      }
    };

    walk(textShape.content);
    return bolds;
  },

  // --- MAIN CARD PARSING ---
  parseCard: async (cardShape, assignedId) => {
    const extracted = {
      name: "Unknown",
      type: "",
      types: [],
      keywords: [],
      cost: 0,
      damage: 0,
      block: 0,
      text: "",
      head: false, body: false, leg: false
    };

    const textShapes = Parser.getTextShapes(cardShape);

    for (const shape of textShapes) {
      const rawContent = Parser.extractPlainText(shape);
      const flatContent = rawContent.replace(/[\r\n]+/g, " ").trim();
      if (!flatContent) continue;

      // 1. Cost (e.g. "3 AP")
      const costMatch = flatContent.match(/^(\d+)\s*ap$/i);
      if (costMatch) { extracted.cost = parseInt(costMatch[1], 10); continue; }

      // 2. Damage (e.g. "5 DMG" or "- DMG")
      const dmgMatch = flatContent.match(/^(\d+|-)\s*dmg$/i);
      if (dmgMatch) { extracted.damage = dmgMatch[1] === "-" ? 0 : parseInt(dmgMatch[1], 10); continue; }

      // 3. Block / Dodge
      if (/block|dodge/i.test(flatContent)) {
        let val = 0;
        let foundMatch = false;
        const isDodge = /dodge/i.test(flatContent);
        const matchA = flatContent.match(/^(?:block|dodge)\s*(?:all|head|body|leg)?\s*(\d+)$/i);
        const matchB = flatContent.match(/^(\d+)%\s*(?:block|dodge)$/i);
        const matchC = flatContent.match(/^(\d+)\s*(?:block|dodge)$/i);
        if (matchA) { val = parseInt(matchA[1], 10); foundMatch = true; }
        else if (matchB) { val = parseInt(matchB[1], 10); foundMatch = true; }
        else if (matchC) { val = parseInt(matchC[1], 10); foundMatch = true; }
        if (foundMatch) { extracted.block = isDodge ? -1 * val : val; continue; }
      }

      // 4. Type + Description (e.g. "Attack(Melee, Gun) Description text...")
      const typeTextMatch = flatContent.match(/^[^\(]*\((?!-\))([^)]+)\)\s*(.*)/);
      if (typeTextMatch) {
        const rawTypeStr = typeTextMatch[1];
        extracted.types = rawTypeStr.split(',').map(t => Utils.toTitleCase(t.trim()));
        extracted.type = extracted.types[0] || "";

        // Preserve newlines for description
        const typeEndIndex = rawContent.indexOf(')');
        if (typeEndIndex !== -1) {
          extracted.text = rawContent.substring(typeEndIndex + 1).trim();
        } else {
          extracted.text = typeTextMatch[2];
        }

        // Detect bold keywords
        const rawBolds = Parser.getBoldedPhrases(shape);
        extracted.keywords = rawBolds.filter(b => {
          const cleanB = b.replace(/[()]/g, '').trim().toLowerCase();
          return !extracted.types.some(t => t.toLowerCase() === cleanB);
        });
        continue;
      }

      // 5. Zone targets (e.g. "Head Body", "Head", "Body Leg")
      const words = flatContent.split(/\s+/);
      const validZones = ["head", "body", "leg"];
      if (words.length > 0 && words.every(w => validZones.includes(w.toLowerCase()))) {
        if (/Head/i.test(flatContent)) extracted.head = true;
        if (/Body/i.test(flatContent)) extracted.body = true;
        if (/Leg/i.test(flatContent)) extracted.leg = true;
        continue;
      }

      // 6. Name (fallback — anything that isn't a bare number or "(-)")
      if (!flatContent.match(/^\d+$/) && flatContent !== "(-)") {
        extracted.name = Utils.toTitleCase(flatContent);
      }
    }

    const imgName = `card-${assignedId}.png`;
    return {
      data: {
        id: String(assignedId),
        isToken: false,
        face: {
          front: {
            name: "Front", type: extracted.type, cost: extracted.cost,
            image: `${CONFIG.IMG_BASE_URL}/${imgName}`,
            isHorizontal: false
          },
          back: {
            name: "Back", type: "", cost: extracted.cost,
            image: `${CONFIG.IMG_BASE_URL}/cardback.png`,
            isHorizontal: false
          }
        },
        name: extracted.name,
        type: extracted.type,
        types: extracted.types,
        keywords: extracted.keywords,
        cost: extracted.cost,
        DMG: extracted.damage,
        Block: extracted.block,
        Text: extracted.text,
        "AttackHead?": extracted.head,
        "AttackBody?": extracted.body,
        "AttackLeg?": extracted.leg
      },
      filename: imgName
    };
  },

  parseToken: (tokenShape) => {
    const match = tokenShape.name.match(/^token-(.+)$/);
    const rawSuffix = match ? match[1] : "unknown";
    const displayName = Utils.toTitleCase(rawSuffix.replace(/-/g, ' '));
    const imgName = `token-${rawSuffix}.png`;
    return {
      data: {
        id: `t-${rawSuffix}`,
        isToken: true,
        face: {
          front: {
            name: "", type: "false", cost: 0,
            image: `${CONFIG.IMG_BASE_URL}/${imgName}`,
            isHorizontal: false
          }
        },
        name: `Token: ${displayName}`,
        type: "false", cost: 0, keywords: [],
        "AttackHead?": false, "AttackBody?": false, "AttackLeg?": false,
        Text: "", Block: 0, DMG: 0
      },
      filename: imgName
    };
  }
};


// ============================================================================
// 5. MAIN CONTROLLER
// ============================================================================

/**
 * Get a page by its ID from the current document.
 * Penpot: penpot.getPage(id) returns the page synchronously.
 */
function getPageById(id) {
  try {
    return penpot.getPage(id);
  } catch (e) {
    return null;
  }
}

/**
 * Export a shape as PNG bytes.
 * Penpot: shape.export({ type: 'png', scale: 1 }) → Uint8Array (async in some versions)
 * We wrap it to always return a Promise<Uint8Array|null>.
 */
async function exportShapeAsPng(shape) {
  try {
    const result = await shape.export({ type: 'png', scale: 1 });
    return result;
  } catch (err) {
    console.error("Export error", err);
    return null;
  }
}

// Open the plugin panel
penpot.ui.open("Card Exporter", "", { width: 520, height: 620 });

// Gather all pages for the init message
function getPages() {
  return penpot.root.children.map(p => ({
    id: p.id,
    name: p.name,
    current: p.id === penpot.currentPage.id
  }));
}

// Load persistent cache
async function loadCache() {
  try {
    return await penpot.clientStorage.getItem(CONFIG.STORAGE_KEY);
  } catch (e) {
    return null;
  }
}

async function saveCache(data) {
  try {
    await penpot.clientStorage.setItem(CONFIG.STORAGE_KEY, data);
  } catch (e) {
    console.error("Cache save error", e);
  }
}

// Boot — send init state to UI
(async () => {
  const pages = getPages();
  let storedCache = await loadCache();

  penpot.ui.sendMessage({
    type: 'init-state',
    pages,
    lastScanDate: storedCache ? storedCache.timestamp : null,
    lastScanCount: storedCache ? Object.keys(storedCache.json).length : 0,
    lastJson: storedCache ? JSON.stringify(storedCache.json, null, 2) : ""
  });

  // ── Message handler ──
  penpot.ui.onMessage(async (msg) => {

    // ── EXPORT JSON + IMAGES ──
    if (msg.type === 'run-scan') {
      const pageNode = getPageById(msg.pageId);
      if (!pageNode) {
        penpot.ui.sendMessage({ type: 'error', message: "Page not found" });
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
            if (oldData && JSON.stringify(oldData) === JSON.stringify(result.data)) {
              shouldExport = false;
            }
          }

          if (shouldExport) {
            await Utils.delay(20);
            const bytes = await exportShapeAsPng(node);
            penpot.ui.sendMessage({
              type: 'image-chunk',
              filename: result.filename,
              data: bytes ? Array.from(bytes) : null,
              current: processedCount,
              total: totalItems
            });
          } else {
            penpot.ui.sendMessage({
              type: 'image-chunk',
              filename: null,
              data: null,
              current: processedCount,
              total: totalItems
            });
          }
        }
      };

      for (const item of numberedCards) await processNode(item.node, item.sortIndex, Parser.parseCard);
      for (const node of tokenNodes) await processNode(node, null, Parser.parseToken);

      const newCache = { timestamp: Date.now(), json: finalMap };
      storedCache = newCache;
      await saveCache(newCache);

      penpot.ui.sendMessage({
        type: 'complete',
        json: JSON.stringify(finalMap, null, 2),
        count: Object.keys(finalMap).length
      });
    }

    // ── SYNC CONTENT ──
    else if (msg.type === 'run-extract') {
      try {
        const sourcePage = getPageById(msg.sourceId);
        const targetPage = getPageById(msg.targetId);
        if (!sourcePage || !targetPage) throw new Error("Pages not found");

        // Index source cards
        const sourceCandidates = Scanner.findNodes(sourcePage, 0, CONFIG.DEFAULT_SEARCH_DEPTH);
        const { numberedCards: srcNumbered, tokenNodes: srcTokens } = Scanner.getIdentifiedCards(sourceCandidates);

        const sourceMap = new Map();
        srcNumbered.forEach(item => sourceMap.set(`card-${item.sortIndex}`, item.node));
        srcTokens.forEach(node => sourceMap.set(node.name, node));

        // Scan target page
        const targetCandidates = Scanner.findNodes(targetPage, 0, CONFIG.DEFAULT_SEARCH_DEPTH);
        let updateCount = 0;

        for (const targetNode of targetCandidates) {
          let targetId = null;
          if (targetNode.name.startsWith("token-")) {
            targetId = targetNode.name;
          } else {
            const match = targetNode.name.match(/^card-(\d+)$/);
            if (match) targetId = `card-${match[1]}`;
          }

          if (targetId && sourceMap.has(targetId)) {
            const sourceNode = sourceMap.get(targetId);
            const newInstance = sourceNode.clone();

            // Preserve target position
            newInstance.x = targetNode.x;
            newInstance.y = targetNode.y;

            // Insert at same z-order, remove old node
            const parent = targetNode.parent;
            if (parent) {
              parent.appendChild(newInstance);
              targetNode.remove();
            }
            updateCount++;
          }
        }

        penpot.ui.sendMessage({ type: 'extract-complete', count: updateCount });
      } catch (err) {
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
    }

    // ── MINIDECK DATA ──
    else if (msg.type === 'extract-minideck-data') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error("Page not found");

        const minidecks = [];
        const usedHues = [];

        for (const deckFrame of pageNode.children) {
          const t = (deckFrame.type || "").toLowerCase();
          if (t !== 'frame' && t !== 'group' && t !== 'section') continue;
          if (deckFrame.name.toLowerCase().startsWith("card-")) continue;

          const uniqueColor = Utils.getDistinctBrightColor(usedHues);
          const deckObj = {
            name: deckFrame.name,
            description: "Generated from Penpot",
            color: uniqueColor,
            cardPool: []
          };

          if (deckFrame.children) {
            for (const rarityFrame of deckFrame.children) {
              const rt = (rarityFrame.type || "").toLowerCase();
              if (rt !== 'frame' && rt !== 'group') continue;
              const rarityName = rarityFrame.name.toLowerCase();
              if (rarityName === "generated") continue;

              if (rarityFrame.children) {
                for (const cardNode of rarityFrame.children) {
                  if (/^(cards?)-/.test(cardNode.name)) {
                    let cardId = 0;
                    const idMatch = cardNode.name.match(/^cards?-(\d+)$/);
                    if (idMatch) cardId = parseInt(idMatch[1], 10);

                    const parsed = await Parser.parseCard(cardNode, cardId);
                    const synergies = [];
                    synergies.push(`${parsed.data.cost} AP`);
                    if (parsed.data.types && parsed.data.types.length > 0) synergies.push(...parsed.data.types);
                    deckObj.cardPool.push({
                      id: parsed.data.id,
                      name: parsed.data.name,
                      rarity: rarityName,
                      synergies
                    });
                  }
                }
              }
            }
          }
          minidecks.push(deckObj);
        }

        penpot.ui.sendMessage({
          type: 'minideck-data-complete',
          count: minidecks.length,
          json: JSON.stringify(minidecks, null, 2)
        });
      } catch (err) {
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
    }

    // ── STATS DATA ──
    else if (msg.type === 'get-stats-data') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error("Page not found");

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

    // ── TRANSFORM CARDS (Apply "Card" component template) ──
    else if (msg.type === 'run-transform') {
      try {
        const pageNode = getPageById(msg.pageId);
        if (!pageNode) throw new Error("Page not found");

        // Find a component named "Card" anywhere in the document
        let cardComponent = null;
        const findComponent = (shape) => {
          if (cardComponent) return;
          if ((shape.type === 'component' || shape.type === 'componentSet') && shape.name === 'Card') {
            cardComponent = shape;
            return;
          }
          if (shape.children) shape.children.forEach(findComponent);
        };
        penpot.root.children.forEach(page => {
          if (page.children) page.children.forEach(findComponent);
        });

        if (!cardComponent) {
          throw new Error("Could not find a Component named 'Card' in this document.");
        }

        const allCandidates = Scanner.findNodes(pageNode, 0, CONFIG.DEFAULT_SEARCH_DEPTH);
        const { numberedCards } = Scanner.getIdentifiedCards(allCandidates);

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const item of numberedCards) {
          const n = item.node;
          if (n.x < minX) minX = n.x;
          if (n.x + n.width > maxX) maxX = n.x + n.width;
          if (n.y < minY) minY = n.y;
          if (n.y + n.height > maxY) maxY = n.y + n.height;
        }

        const offsetX = maxX + 1000;
        const offsetY = minY;
        let transformCount = 0;

        for (const item of numberedCards) {
          const cardId = item.sortIndex;
          const oldNode = item.node;
          const parsed = await Parser.parseCard(oldNode, cardId);
          const data = parsed.data;

          // Create an instance of the Card component
          const newInstance = cardComponent.createInstance
            ? cardComponent.createInstance()
            : cardComponent.clone();

          pageNode.appendChild(newInstance);

          const relX = oldNode.x - minX;
          const relY = oldNode.y - minY;
          newInstance.x = offsetX + relX;
          newInstance.y = offsetY + relY;
          newInstance.name = `card-${cardId}`;

          // Update text layers inside the instance by name
          const setChildText = (childName, value) => {
            if (value === undefined || value === null) return;
            const textShapes = Parser.getTextShapes(newInstance);
            for (const ts of textShapes) {
              if (ts.name === childName) {
                try { ts.characters = String(value); } catch (e) { }
                return;
              }
            }
          };

          setChildText("AP Cost Text", `${data.cost}`);

          let valueText = "";
          if ((data.type || "").toUpperCase() === "GUARD") valueText = `${Math.abs(data.Block)}`;
          else if (["GUN", "MELEE"].includes((data.type || "").toUpperCase())) valueText = `${data.DMG}`;
          setChildText("Card Value Text", valueText);

          setChildText("Card Name", (data.name || "").toUpperCase());
          setChildText("Card Type Text", (data.type || "").toUpperCase());
          setChildText("Card Effect Text", Utils.toTitleCase(data.Text || ""));

          transformCount++;
        }

        penpot.ui.sendMessage({ type: 'transform-complete', count: transformCount });
      } catch (err) {
        penpot.ui.sendMessage({ type: 'error', message: err.message });
      }
    }
  });
})();
