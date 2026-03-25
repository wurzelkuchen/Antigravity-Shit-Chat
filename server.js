/**
 * @file server.js
 * @description Main server for the Antigravity Mobile Monitor.
 * Provides a bridge between Antigravity (via CDP) and a mobile web interface (via WebSockets).
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @constant {number[]} PORTS - CDP ports to scan for Antigravity instances. */
const PORTS = [9000, 9001, 9002, 9003];

/** @constant {number} DISCOVERY_INTERVAL - Interval in ms to scan for new Antigravity instances. */
const DISCOVERY_INTERVAL = 10000;

/** @constant {number} POLL_INTERVAL - Interval in ms to poll for snapshots from active sessions. */
const POLL_INTERVAL = 3000;

/** @constant {string} PANEL_SELECTOR - CSS selector for the Antigravity chat panel. */
const PANEL_SELECTOR = '.antigravity-agent-side-panel';

// Application State
/** 
 * @type {Map<string, Object>} 
 * Stores active cascade sessions. 
 * Key: cascadeId (hashed CDP URL)
 * Value: { id, cdp: { ws, call, contexts, rootContextId }, metadata, snapshot, snapshotHash, css }
 */
let cascades = new Map();

/** @type {WebSocketServer|null} - The WebSocket server instance for client communication. */
let wss = null;

// --- Helpers ---

/**
 * Generates a simple alphanumeric hash for a given string.
 * @param {string} str - The string to hash.
 * @returns {string} The base-36 representation of the hash.
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

/**
 * Fetches JSON data from a URL with a timeout.
 * @param {string} url - The URL to fetch from.
 * @returns {Promise<any>} A promise resolving to the parsed JSON or an empty array on failure.
 */
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } // return empty on parse error
            });
        });
        req.on('error', () => resolve([])); // return empty on network error
        req.setTimeout(2000, () => {
            req.destroy();
            resolve([]);
        });
    });
}

// --- CDP Logic ---

/**
 * Connects to a Chrome DevTools Protocol (CDP) WebSocket URL.
 * Enables Runtime and tracks execution contexts.
 * @param {string} url - The CDP WebSocket URL.
 * @returns {Promise<Object>} Object containing the WebSocket, a call helper, and context tracking.
 */
async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 500)); // give time for contexts to load

    return { ws, call, contexts, rootContextId: null };
}

/**
 * Extracts session metadata (chat title, active state) from an Antigravity instance.
 * Scans all available execution contexts to find the chat panel.
 * @param {Object} cdp - The CDP connection object.
 * @returns {Promise<Object|null>} Metadata object or null if not found.
 */
async function extractMetadata(cdp) {
    const SCRIPT = `(() => {
        const cascade = document.querySelector('${PANEL_SELECTOR}');
        if (!cascade) return { found: false };
        
        let chatTitle = null;
        const possibleTitleSelectors = ['h1', 'h2', 'header', '[class*="title"]'];
        for (const sel of possibleTitleSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.length > 2 && el.textContent.length < 50) {
                chatTitle = el.textContent.trim();
                break;
            }
        }
        
        return {
            found: true,
            chatTitle: chatTitle || 'Agent',
            isActive: document.hasFocus()
        };
    })()`;

    // Try finding context first if not known
    if (cdp.rootContextId) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            if (res.result?.value?.found) return { ...res.result.value, contextId: cdp.rootContextId };
        } catch (e) { cdp.rootContextId = null; } // reset if stale
    }

    // Search all contexts
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: ctx.id });
            if (result.result?.value?.found) {
                return { ...result.result.value, contextId: ctx.id };
            }
        } catch (e) { }
    }
    return null;
}

/**
 * Captures all styles from the target page and namespaces them to the panel selector.
 * @param {Object} cdp - The CDP connection object.
 * @returns {Promise<string>} The namespaced CSS string.
 */
async function captureCSS(cdp) {
    const SCRIPT = `(() => {
        // Gather CSS and namespace it basic way to prevent leaks
        let css = '';
        for (const sheet of document.styleSheets) {
            try { 
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Naive scoping: replace body/html with panel locator
                    // This prevents the monitored app's global backgrounds from overriding our monitor's body
                    text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1${PANEL_SELECTOR}');
                    text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1${PANEL_SELECTOR}');
                    css += text + '\\n'; 
                }
            } catch (e) { }
        }
        return { css };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        return result.result?.value?.css || '';
    } catch (e) { return ''; }
}

/**
 * Captures a snapshot of the chat panel HTML and body styles.
 * @param {Object} cdp - The CDP connection object.
 * @returns {Promise<Object|null>} HTML snapshot and basic styles, or null on failure.
 */
async function captureHTML(cdp) {
    const SCRIPT = `(() => {
        const panel = document.querySelector('${PANEL_SELECTOR}');
        if (!panel) return { error: 'panel not found' };
        
        const origin = window.location.origin;
        const baseUrl = window.location.href;
        
        // Helper to generate a selector for an element in the target session
        const getSelector = (el) => {
            let path = [];
            let curr = el;
            while (curr && curr.nodeType === Node.ELEMENT_NODE) {
                let tag = curr.nodeName.toLowerCase();
                let index = Array.from(curr.parentNode.children).filter(c => c.nodeName.toLowerCase() === tag).indexOf(curr) + 1;
                path.unshift(tag + ':nth-of-type(' + index + ')');
                if (curr.id) { 
                    path = ['#' + curr.id]; 
                    break; 
                }
                curr = curr.parentNode;
                if (curr === document.body) break;
            }
            return path.join(' > ');
        };

        // Find dialogs/modals that might be outside the panel
        const dialogSelectors = [
            '[role="dialog"]', 
            '.monaco-dialog-box', 
            '.monaco-modal-block',
            '.overlay'
        ];
        const dialogs = [];
        dialogSelectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
                // Filter out non-visible or IDE-specific widgets
                if (el.offsetParent !== null && !panel.contains(el)) {
                    // Skip if this element IS a find/search widget or contains one
                    if (el.classList.contains('find-widget') || 
                        el.classList.contains('quick-input-widget') ||
                        el.querySelector('.find-widget, .quick-input-widget') ||
                        el.closest('.find-widget, .quick-input-widget')) return;
                    
                    const clone = el.cloneNode(true);
                    clone.setAttribute('data-target-selector', getSelector(el));
                    dialogs.push(clone);
                }
            });
        });

        const clone = panel.cloneNode(true);
        clone.setAttribute('data-target-selector', '${PANEL_SELECTOR}');
        
        const container = document.createElement('div');
        container.appendChild(clone);
        dialogs.forEach(d => container.appendChild(d));
        
        // Rewrite asset URLs
        container.querySelectorAll('*').forEach(el => {
            ['src', 'srcset', 'href'].forEach(attr => {
                const val = el.getAttribute(attr);
                if (val && !val.startsWith('data:') && !val.startsWith('http')) {
                    const absolute = new URL(val, baseUrl).href;
                    el.setAttribute(attr, '/asset-proxy?url=' + encodeURIComponent(absolute));
                }
            });
            
            const style = el.getAttribute('style');
            if (style && (style.includes('url(') || style.includes('mask-image'))) {
                const newStyle = style.replace(/url\\(['"]?((?!https?:|data:)[^'"]+)['"]?\\)/g, (match, path) => {
                    try {
                        const absolute = new URL(path, baseUrl).href;
                        return 'url("/asset-proxy?url=' + encodeURIComponent(absolute) + '")';
                    } catch (e) { return match; }
                });
                el.setAttribute('style', newStyle);
            }
            
            // Hide truly empty purely-layout elements that clutter the view
            // Targeted at leaf divs with no text inside the conversation area
            if (el.nodeName === 'DIV' && el.children.length === 0 && !el.textContent?.trim()) {
                if (el.closest('#conversation') && 
                    !el.hasAttribute('contenteditable') && 
                    el.getAttribute('role') !== 'textbox' && 
                    !el.hasAttribute('data-target-selector')) {
                    el.style.display = 'none';
                }
            }
        });
        
        const bodyStyles = window.getComputedStyle(document.body);

        return {
            html: container.innerHTML,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color
        };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        if (result.result?.value && !result.result.value.error) {
            return result.result.value;
        }
    } catch (e) { }
    return null;
}

// --- Main App Logic ---

/**
 * Discovers Antigravity targets across multiple ports.
 * Manages connections and session lifecycle (connect, refresh, cleanup).
 */
async function discover() {
    // 1. Find all targets
    const allTargets = [];
    await Promise.all(PORTS.map(async (port) => {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        const workbenches = list.filter(t => t.url?.includes('workbench.html') || t.title?.includes('workbench'));
        workbenches.forEach(t => allTargets.push({ ...t, port }));
    }));

    const newCascades = new Map();

    // 2. Connect/Refresh
    for (const target of allTargets) {
        const id = hashString(target.webSocketDebuggerUrl);

        // Reuse existing
        if (cascades.has(id)) {
            const existing = cascades.get(id);
            if (existing.cdp.ws.readyState === WebSocket.OPEN) {
                // Refresh metadata
                const meta = await extractMetadata(existing.cdp);
                if (meta) {
                    existing.metadata = { ...existing.metadata, ...meta };
                    if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
                    newCascades.set(id, existing);
                    continue;
                }
            }
        }

        // New connection
        try {
            console.log(`🔌 Connecting to ${target.title}`);
            const cdp = await connectCDP(target.webSocketDebuggerUrl);
            const meta = await extractMetadata(cdp);

            if (meta) {
                if (meta.contextId) cdp.rootContextId = meta.contextId;
                const cascade = {
                    id,
                    cdp,
                    metadata: {
                        windowTitle: target.title,
                        chatTitle: meta.chatTitle,
                        isActive: meta.isActive
                    },
                    snapshot: null,
                    css: await captureCSS(cdp), //only on init bc its huge
                    snapshotHash: null
                };
                newCascades.set(id, cascade);
                console.log(`✨ Added cascade: ${meta.chatTitle}`);
            } else {
                cdp.ws.close();
            }
        } catch (e) {
            // console.error(`Failed to connect to ${target.title}: ${e.message}`);
        }
    }

    // 3. Cleanup old
    for (const [id, c] of cascades.entries()) {
        if (!newCascades.has(id)) {
            console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
            try { c.cdp.ws.close(); } catch (e) { }
        }
    }

    const changed = cascades.size !== newCascades.size; // Simple check, could be more granular
    cascades = newCascades;

    if (changed) broadcastCascadeList();
}

/**
 * Updates snapshots for all active cascade sessions if content has changed.
 * Broadcasts updates to connected WebSocket clients.
 */
async function updateSnapshots() {
    // Parallel updates
    await Promise.all(Array.from(cascades.values()).map(async (c) => {
        try {
            const snap = await captureHTML(c.cdp); // Only capture HTML
            if (snap) {
                const hash = hashString(snap.html);
                if (hash !== c.snapshotHash) {
                    c.snapshot = snap;
                    c.snapshotHash = hash;
                    broadcast({ type: 'snapshot_update', cascadeId: c.id });
                    // console.log(`📸 Updated ${c.metadata.chatTitle}`);
                }
            }
        } catch (e) { }
    }));
}

/**
 * Broadcasts a message to all connected WebSocket clients.
 * @param {Object} msg - The message object to broadcast.
 */
function broadcast(msg) {
    if (!wss) return;
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
    });
}

/**
 * Broadcasts the current list of active cascade sessions to all clients.
 */
function broadcastCascadeList() {
    const list = Array.from(cascades.values()).map(c => ({
        id: c.id,
        title: c.metadata.chatTitle,
        window: c.metadata.windowTitle,
        active: c.metadata.isActive
    }));
    broadcast({ type: 'cascade_list', cascades: list });
}

// --- Server Setup ---

/**
 * Main application entry point.
 * Initializes Express, starts CDP discovery, and begins the snapshot poll loop.
 */
async function main() {
    const app = express();
    const server = http.createServer(app);
    wss = new WebSocketServer({ server });

    app.use(express.json());
    app.use(express.static(join(__dirname, 'public')));
    
    app.use((req, res, next) => {
        console.log(`[monitor] ${req.method} ${req.url}`);
        next();
    });

    // API Routes
    app.get('/cascades', (req, res) => {
        res.json(Array.from(cascades.values()).map(c => ({
            id: c.id,
            title: c.metadata.chatTitle,
            active: c.metadata.isActive
        })));
    });

    app.get('/snapshot/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c || !c.snapshot) return res.status(404).json({ error: 'Not found' });
        res.json(c.snapshot);
    });

    app.get('/styles/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json({ css: c.css || '' });
    });

    app.get('/asset-proxy', async (req, res) => {
        const url = req.query.url;
        if (!url) return res.status(400).send('Missing URL');
        
        try {
            const protocol = url.startsWith('https') ? https : http;
            const request = protocol.get(url, (assetRes) => {
                res.set('Content-Type', assetRes.headers['content-type']);
                assetRes.pipe(res);
            });
            request.on('error', (e) => res.status(500).send(e.message));
        } catch (e) {
            res.status(500).send(e.message);
        }
    });

    // Alias for simple single-view clients (returns first active or first available)
    app.get('/snapshot', (req, res) => {
        const active = Array.from(cascades.values()).find(c => c.metadata.isActive) || cascades.values().next().value;
        if (!active || !active.snapshot) return res.status(503).json({ error: 'No snapshot' });
        res.json(active.snapshot);
    });

    app.post('/send/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        // Re-using the injection logic logic would be long, 
        // but let's assume valid injection for brevity in this single-file request:
        // We'll trust the previous logic worked, just pointing it to c.cdp

        // ... (Injection logic here would be same as before, simplified for brevity of this file edit)
        // For now, let's just log it to prove flow works
        console.log(`Message to ${c.metadata.chatTitle}: ${req.body.message}`);
        // TODO: Port the full injection script back in if needed, 
        // but user asked for "update" which implies features, I'll assume I should include it.
        // See helper below.

        const result = await injectMessage(c.cdp, req.body.message);
        if (result.ok) res.json({ success: true });
        else res.status(500).json(result);
    });

    app.post('/click/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        const { path } = req.body;
        const SCRIPT = `(() => {
            const el = document.querySelector('${path}');
            if (el) {
                el.focus();
                const events = [
                    { name: 'pointerdown', type: PointerEvent },
                    { name: 'mousedown', type: MouseEvent },
                    { name: 'pointerup', type: PointerEvent },
                    { name: 'mouseup', type: MouseEvent },
                    { name: 'click', type: MouseEvent }
                ];
                events.forEach(ev => {
                    const event = new ev.type(ev.name, { bubbles: true, cancelable: true, view: window, buttons: 1 });
                    el.dispatchEvent(event);
                });
                return { ok: true, tag: el.tagName };
            }
            return { error: 'element not found: ${path}' };
        })()`;
        
        try {
            const result = await c.cdp.call("Runtime.evaluate", {
                expression: SCRIPT,
                returnByValue: true,
                contextId: c.cdp.rootContextId
            });
            res.json(result.result?.value || { error: 'Execution failed' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/type/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        const { key, code, shiftKey, ctrlKey } = req.body;
        try {
            // Use CDP Input.dispatchKeyEvent for reliable keystroke injection
            await c.cdp.call("Input.dispatchKeyEvent", {
                type: 'keyDown',
                key,
                code,
                modifiers: (shiftKey ? 8 : 0) | (ctrlKey ? 2 : 0)
            });
            if (key.length === 1) {
                await c.cdp.call("Input.dispatchKeyEvent", {
                    type: 'char',
                    text: key,
                    key,
                    code
                });
            }
            await c.cdp.call("Input.dispatchKeyEvent", {
                type: 'keyUp',
                key,
                code
            });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


    wss.on('connection', (ws) => {
        broadcastCascadeList(); // Send list on connect
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });

    // Start Loops
    discover();
    setInterval(discover, DISCOVERY_INTERVAL);
    setInterval(updateSnapshots, POLL_INTERVAL);
}

// Injection Helper (Moved down to keep main clear)
/**
 * Injects a message into the Antigravity chat interface.
 * Supports both contenteditable and textarea editors.
 * @param {Object} cdp - The CDP connection object.
 * @param {string} text - The message text to inject.
 * @returns {Promise<Object>} Success or failure details.
 */
async function injectMessage(cdp, text) {
    const SCRIPT = `(async () => {
        // Try contenteditable first, then textarea
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, "${text.replace(/"/g, '\\"')}");
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, "${text.replace(/"/g, '\\"')}");
        }
        
        await new Promise(r => setTimeout(r, 100));
        
        // Try multiple button selectors
        const btn = document.querySelector('button[class*="arrow"]') || 
                   document.querySelector('button[aria-label*="Send"]') ||
                   document.querySelector('button[type="submit"]');

        if (btn) {
            btn.click();
        } else {
             // Fallback to Enter key
             editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter" }));
        }
        return { ok: true };
    })()`;

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: cdp.rootContextId
        });
        return res.result?.value || { ok: false };
    } catch (e) { return { ok: false, reason: e.message }; }
}

main();
