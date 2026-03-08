/**
 * PageIndex RAG — App Logic
 * Upload → Tree build → 50/50 split (D3 tree + chat)
 */

// ═══ State ═══════════════════════════════════════════════════════
const S = {
    sid: null,
    tree: null,
    viz: null,
    queries: 0,
    querying: false,
};

// ═══ Selectors ═══════════════════════════════════════════════════
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ═══ Init ════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", init);

function init() {
    // Hide loader
    setTimeout(() => {
        $("#loader").classList.add("hide");
        setTimeout(() => ($("#loader").style.display = "none"), 500);
    }, 1200);

    setupUpload();
    setupChat();
    setupTabs();
    setupResizer();
    setupControls();
    setupModal();
}

// ═══ Upload ══════════════════════════════════════════════════════
function setupUpload() {
    const zone = $("#drop-zone");
    const input = $("#file-input");

    zone.addEventListener("click", () => input.click());
    input.addEventListener("change", (e) => {
        if (e.target.files[0]) upload(e.target.files[0]);
    });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault(); zone.classList.remove("drag-over");
        if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
    });
}

async function upload(file) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
        toast("Please upload a PDF file", true);
        return;
    }

    const prog = $("#dz-progress");
    const content = $("#dz-content");
    const fill = $("#prog-fill");
    const txt = $("#prog-text");

    content.style.display = "none";
    prog.style.display = "block";
    txt.textContent = "Uploading…";
    fill.style.width = "30%";

    const fd = new FormData();
    fd.append("file", file);

    try {
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        if (!r.ok) throw new Error((await r.json()).error || "Upload failed");
        const d = await r.json();
        S.sid = d.session_id;
        fill.style.width = "60%";
        txt.textContent = "Uploaded! Building tree…";
        setTimeout(() => startProcessing(file.name), 400);
    } catch (e) {
        txt.textContent = "Error: " + e.message;
        fill.style.width = "0";
        setTimeout(() => { prog.style.display = "none"; content.style.display = ""; }, 2500);
    }
}

// ═══ Processing ══════════════════════════════════════════════════
function startProcessing(filename) {
    $("#view-upload").style.display = "none";
    const vp = $("#view-processing");
    vp.style.display = "flex";
    $("#proc-title").textContent = `Processing: ${filename}`;

    const steps = [
        { id: "extract", text: "Extracting text from PDF" },
        { id: "tree", text: "Building tree structure" },
        { id: "ids", text: "Assigning node identifiers" },
        { id: "summaries", text: "Generating summaries" },
        { id: "done", text: "Finalizing" },
    ];
    $("#proc-steps").innerHTML = steps.map((s, i) => `
        <div class="step" id="step-${s.id}">
            <div class="step-icon">${i === 0 ? '<div class="spinner-sm"></div>' : '○'}</div>
            <span>${s.text}</span>
        </div>
    `).join("");

    listenSSE();
    processDoc();
}

async function processDoc() {
    try {
        const r = await fetch(`/api/process/${S.sid}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "google/gemini-2.5-flash" }),
        });
        if (!r.ok) throw new Error((await r.json()).error || "Processing failed");
        const d = await r.json();
        S.tree = d.tree;
        showApp();
    } catch (e) {
        $("#proc-msg").textContent = "Error: " + e.message;
        $("#proc-msg").style.color = "var(--red)";
        setTimeout(() => {
            $("#view-processing").style.display = "none";
            $("#view-upload").style.display = "";
            $("#dz-progress").style.display = "none";
            $("#dz-content").style.display = "";
        }, 3000);
    }
}

function listenSSE() {
    if (!S.sid) return;
    const es = new EventSource(`/api/events/${S.sid}`);
    const phaseMap = { extract: "extract", tree: "tree", ids: "ids", summaries: "summaries" };

    es.onmessage = (e) => {
        try {
            const d = JSON.parse(e.data);
            if (d.type === "status" && d.data.phase) {
                const step = phaseMap[d.data.phase];
                if (step) activateStep(step);
                $("#proc-msg").textContent = d.data.msg || "";
            }
            if (d.type === "tree_complete") {
                activateStep("done");
                markDone("done");
            }
            if (d.type === "highlight") {
                highlightNode(d.data.node_id, d.data.status);
            }
            if (["tree_complete", "answer_done", "error"].includes(d.type)) {
                es.close();
            }
        } catch (_) { }
    };
    es.onerror = () => es.close();
}

function activateStep(id) {
    const all = $$("#proc-steps .step");
    let found = false;
    all.forEach((el) => {
        if (el.id === `step-${id}`) {
            found = true;
            el.classList.add("active");
            el.classList.remove("done");
            el.querySelector(".step-icon").innerHTML = '<div class="spinner-sm"></div>';
        } else if (!found) {
            el.classList.remove("active");
            el.classList.add("done");
            el.querySelector(".step-icon").textContent = "✓";
        }
    });
}

function markDone(id) {
    const el = $(`#step-${id}`);
    if (el) {
        el.classList.remove("active");
        el.classList.add("done");
        el.querySelector(".step-icon").textContent = "✓";
    }
}

// ═══ Show App (50/50 Split) ══════════════════════════════════════
function showApp() {
    $("#view-processing").style.display = "none";
    $("#view-upload").style.display = "none";
    const va = $("#view-app");
    va.style.display = "flex";

    const name = S.tree?.doc_name || "Document";
    $("#session-name").textContent = name;
    $("#session-pill").style.display = "flex";
    $("#doc-label").textContent = name;

    renderTree(S.tree);
    renderStructure(S.tree);
    updateStats();
    showSuggestions();
}

// ═══ D3 Tree Visualization ═══════════════════════════════════════
function renderTree(data) {
    if (!data || !data.structure) return;
    const container = $("#tree-canvas");
    container.innerHTML = "";

    const hier = {
        name: data.doc_name || "Document",
        node_id: "root",
        children: toHierarchy(data.structure),
    };

    const W = container.clientWidth || 600;
    const H = container.clientHeight || 400;

    const svg = d3.select(container)
        .append("svg")
        .attr("width", W)
        .attr("height", H);

    const g = svg.append("g");

    const zoom = d3.zoom()
        .scaleExtent([0.15, 4])
        .on("zoom", (e) => g.attr("transform", e.transform));
    svg.call(zoom);

    const tW = Math.max(W - 160, 500);
    const tH = Math.max(H - 80, 350);

    const layout = d3.tree()
        .size([tH, tW])
        .separation((a, b) => (a.parent === b.parent ? 1.5 : 2));

    const root = d3.hierarchy(hier);
    layout(root);

    // Initial center
    svg.call(zoom.transform, d3.zoomIdentity.translate(60, 30).scale(0.82));

    // Gradient defs
    const defs = svg.append("defs");
    const grad = defs.append("linearGradient").attr("id", "ng-root")
        .attr("x1", "0%").attr("y1", "0%").attr("x2", "100%").attr("y2", "100%");
    grad.append("stop").attr("offset", "0%").attr("stop-color", "#6366f1");
    grad.append("stop").attr("offset", "100%").attr("stop-color", "#a855f7");

    // Links
    const links = g.selectAll(".tree-link")
        .data(root.links()).enter()
        .append("path")
        .attr("class", "tree-link")
        .attr("d", d3.linkHorizontal().x((d) => d.y).y((d) => d.x))
        .attr("data-src", (d) => d.source.data.node_id)
        .attr("data-tgt", (d) => d.target.data.node_id);

    // Nodes
    const nodes = g.selectAll(".tree-node")
        .data(root.descendants()).enter()
        .append("g")
        .attr("class", (d) => `tree-node ${d.children ? "branch" : "leaf"}`)
        .attr("data-nid", (d) => d.data.node_id)
        .attr("transform", (d) => `translate(${d.y},${d.x})`);

    nodes.append("circle")
        .attr("r", (d) => (d.depth === 0 ? 14 : d.children ? 9 : 6))
        .attr("fill", (d) => {
            if (d.depth === 0) return "url(#ng-root)";
            if (d.children) return "#6366f1";
            return "#38bdf8";
        })
        .attr("stroke", (d) => (d.depth === 0 ? "rgba(139,92,246,.4)" : "none"))
        .attr("stroke-width", 3);

    // Labels
    nodes.append("text")
        .attr("dy", (d) => (d.children ? -16 : 4))
        .attr("dx", (d) => (d.children ? 0 : 14))
        .attr("text-anchor", (d) => (d.children ? "middle" : "start"))
        .text((d) => trunc(d.data.name, 28))
        .attr("font-size", (d) => (d.depth === 0 ? "12px" : "10px"))
        .attr("font-weight", (d) => (d.depth === 0 ? "700" : "400"));

    // Node IDs
    nodes.filter((d) => d.data.node_id && d.data.node_id !== "root")
        .append("text")
        .attr("dy", (d) => (d.children ? -28 : -10))
        .attr("dx", (d) => (d.children ? 0 : 14))
        .attr("text-anchor", (d) => (d.children ? "middle" : "start"))
        .text((d) => d.data.node_id)
        .attr("font-size", "8px")
        .attr("fill", "var(--text3)")
        .attr("font-family", "var(--mono)");

    // Tooltip
    const tip = d3.select(container).append("div").attr("class", "node-tooltip");
    nodes.on("mouseover", (e, d) => {
        const dd = d.data;
        tip.html(`
            <div class="tooltip-title">${dd.name}</div>
            ${dd.start_index ? `<div class="tooltip-pages">Pages ${dd.start_index}–${dd.end_index}</div>` : ""}
            ${dd.summary ? `<div class="tooltip-summary">${dd.summary}</div>` : ""}
        `);
        tip.classed("visible", true);
        const r = container.getBoundingClientRect();
        tip.style("left", e.pageX - r.left + 12 + "px").style("top", e.pageY - r.top - 8 + "px");
    });
    nodes.on("mousemove", (e) => {
        const r = container.getBoundingClientRect();
        tip.style("left", e.pageX - r.left + 12 + "px").style("top", e.pageY - r.top - 8 + "px");
    });
    nodes.on("mouseout", () => tip.classed("visible", false));

    // Animate
    nodes.attr("opacity", 0).transition().duration(400).delay((_, i) => i * 40).attr("opacity", 1);
    links.attr("opacity", 0).transition().duration(300).delay((_, i) => i * 30).attr("opacity", 1);

    S.viz = { svg, g, zoom, root, nodes, links };
}

function toHierarchy(arr) {
    if (!arr) return [];
    return arr.map((n) => ({
        name: n.title || "Untitled",
        node_id: n.node_id || "",
        start_index: n.start_index,
        end_index: n.end_index,
        summary: n.summary || "",
        children: n.nodes ? toHierarchy(n.nodes) : [],
    }));
}

function trunc(t, m) {
    return !t ? "" : t.length > m ? t.slice(0, m) + "…" : t;
}

function highlightNode(nid, status) {
    if (!S.viz) return;
    const node = d3.select(`[data-nid="${nid}"]`);
    if (!node.empty()) {
        node.classed("searching", status === "searching");
        node.classed("found", status === "found");

        const circle = node.select("circle");

        if (status === "searching" || status === "found") {
            // CSS classes .searching and .found will handle animation via transform scale now.
        } else {
            // Reset to default
            const originalR = node.node().__data__.depth === 0 ? 14 : (node.node().__data__.children ? 9 : 6);
            circle.transition().duration(200).attr("r", originalR);
        }

        if (status === "found" || status === "searching") {
            d3.selectAll(".tree-link").each(function (d) {
                if (d.target.data.node_id === nid) d3.select(this).classed("highlighted", true);
            });
        }
    }
}

function resetHighlights() {
    d3.selectAll(".tree-node").classed("searching", false).classed("found", false).each(function () {
        const nodeData = d3.select(this).node().__data__;
        const originalR = nodeData.depth === 0 ? 14 : (nodeData.children ? 9 : 6);
        d3.select(this).select("circle").transition().duration(200).attr("r", originalR);
    });
    d3.selectAll(".tree-link").classed("highlighted", false);
}

// ═══ Structure View ══════════════════════════════════════════════
function renderStructure(data) {
    if (!data || !data.structure) return;
    const el = $("#struct-content");
    el.innerHTML = `<div class="struct-heading">📄 ${esc(data.doc_name || "Document")}</div>` + buildStructHTML(data.structure, 0);
}

function buildStructHTML(nodes, depth) {
    if (!nodes) return "";
    return nodes.map((n) => {
        const isLeaf = !n.nodes || n.nodes.length === 0;
        return `
            <div style="padding-left:${depth * 18}px">
                <div class="struct-row" onclick="focusNode('${n.node_id}')">
                    <span class="struct-dot${isLeaf ? " leaf" : ""}"></span>
                    <span class="struct-title">${esc(n.title || "Untitled")}</span>
                    <span class="struct-pg">p.${n.start_index}–${n.end_index}</span>
                </div>
                ${!isLeaf ? buildStructHTML(n.nodes, depth + 1) : ""}
            </div>
        `;
    }).join("");
}

window.focusNode = function (nid) {
    if (!S.viz) return;
    const n = d3.select(`[data-nid="${nid}"]`);
    if (!n.empty()) {
        const c = n.select("circle");
        const orig = c.attr("fill");
        c.transition().duration(200).attr("r", 16).attr("fill", "#fbbf24")
            .transition().duration(400).attr("r", c.node().__data__.children ? 9 : 6).attr("fill", orig);
    }
};

// ═══ Chat ════════════════════════════════════════════════════════
function setupChat() {
    const input = $("#q-input");
    const btn = $("#btn-send");

    input.addEventListener("input", () => {
        btn.disabled = !input.value.trim();
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 100) + "px";
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (input.value.trim()) sendQuery();
        }
    });
    btn.addEventListener("click", () => {
        if (input.value.trim()) sendQuery();
    });
}

async function sendQuery() {
    const input = $("#q-input");
    const q = input.value.trim();
    if (!q || S.querying || !S.sid) return;

    S.querying = true;
    input.value = "";
    input.style.height = "auto";
    $("#btn-send").disabled = true;

    // Remove welcome
    const w = $("#messages .welcome");
    if (w) w.remove();

    addMsg(q, "user");
    resetHighlights();

    const typId = addTyping();

    // Listen for visual highlights
    listenSearchSSE();

    try {
        const r = await fetch(`/api/query/${S.sid}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: q, model: "google/gemini-2.5-flash" }),
        });
        removeTyping(typId);
        if (!r.ok) throw new Error((await r.json()).error || "Query failed");
        const d = await r.json();
        addMsg(d.answer, "ai", d.search_path, d.pages);
        addLog(q, d.search_path, d.pages);
        S.queries++;
        updateStats();
    } catch (e) {
        removeTyping(typId);
        addMsg("Sorry, an error occurred: " + e.message, "ai");
    }
    S.querying = false;
}

function listenSearchSSE() {
    if (!S.sid) return;
    const es = new EventSource(`/api/events/${S.sid}`);
    es.onmessage = (e) => {
        try {
            const d = JSON.parse(e.data);
            if (d.type === "highlight") highlightNode(d.data.node_id, d.data.status);
            if (["answer_done", "error"].includes(d.type)) es.close();
        } catch (_) { }
    };
    es.onerror = () => es.close();
}

function addMsg(text, role, path, pages) {
    const msgs = $("#messages");
    const div = document.createElement("div");
    div.className = `msg msg-${role}`;

    if (role === "user") {
        div.innerHTML = `<div class="bubble"><p>${esc(text)}</p></div>`;
    } else {
        let pathHtml = "";
        if (path && path.length) {
            pathHtml = `
                <div class="search-path">
                    <div class="sp-title">🔍 Search Path (${path.length} nodes)</div>
                    ${path.map((p) => `<div class="sp-item">→ <strong>${esc(p.title)}</strong> (${p.node_id})</div>`).join("")}
                    ${pages ? `<div class="sp-pages">📄 Pages: ${pages.join(", ")}</div>` : ""}
                </div>
            `;
        }
        div.innerHTML = `
            <div class="msg-avatar">🌲</div>
            <div class="bubble">${fmtMd(text)}${pathHtml}</div>
        `;
    }
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}

function addTyping() {
    const id = "typ-" + Date.now();
    const div = document.createElement("div");
    div.className = "msg msg-ai";
    div.id = id;
    div.innerHTML = `<div class="msg-avatar">🌲</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
    $("#messages").appendChild(div);
    $("#messages").scrollTop = $("#messages").scrollHeight;
    return id;
}

function removeTyping(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function showSuggestions() {
    const qs = [
        "What are the main topics covered?",
        "Summarize the key findings",
        "What methodology is used?",
        "Explain the conclusions",
    ];
    $("#suggestions").innerHTML = qs.map((q) =>
        `<button class="sug-btn" onclick="askSug('${q}')">${q}</button>`
    ).join("");
}

window.askSug = function (q) {
    $("#q-input").value = q;
    $("#btn-send").disabled = false;
    sendQuery();
};

// ═══ Search Log ══════════════════════════════════════════════════
function addLog(query, path, pages) {
    const el = $("#log-content");
    const empty = el.querySelector(".empty-msg");
    if (empty) empty.remove();

    const entry = document.createElement("div");
    entry.className = "log-entry";
    entry.innerHTML = `
        <div class="log-q">Q: ${esc(query)}</div>
        <div class="log-step"><span class="log-icon">🧠</span><span>Reasoning-based tree search</span></div>
        ${path.map((p) => `
            <div class="log-step">
                <span class="log-icon">→</span>
                <span><strong>${esc(p.title)}</strong> (${p.node_id})<br><em>${esc(p.reason || "")}</em></span>
            </div>
        `).join("")}
        ${pages ? `<div class="log-step"><span class="log-icon">📄</span><span>Pages: <strong>${pages.join(", ")}</strong></span></div>` : ""}
    `;
    el.prepend(entry);
}

// ═══ Tabs ════════════════════════════════════════════════════════
function setupTabs() {
    $$(".tab").forEach((t) => {
        t.addEventListener("click", () => {
            $$(".tab").forEach((x) => x.classList.remove("active"));
            t.classList.add("active");
            $$(".pane").forEach((p) => p.classList.remove("active"));
            $(`#pane-${t.dataset.tab}`).classList.add("active");
        });
    });
}

// ═══ Resizer ═════════════════════════════════════════════════════
function setupResizer() {
    const resizer = $("#resizer");
    const left = $("#left-panel");
    let active = false;

    resizer.addEventListener("mousedown", () => {
        active = true;
        resizer.classList.add("active");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", (e) => {
        if (!active) return;
        const app = $("#view-app");
        const rect = app.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        if (pct >= 25 && pct <= 75) {
            left.style.width = pct + "%";
            clearTimeout(S._rto);
            S._rto = setTimeout(() => { if (S.tree) renderTree(S.tree); }, 150);
        }
    });
    document.addEventListener("mouseup", () => {
        if (active) {
            active = false;
            resizer.classList.remove("active");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        }
    });
}

// ═══ Controls ════════════════════════════════════════════════════
function setupControls() {
    $("#btn-zoom-in")?.addEventListener("click", () => {
        if (S.viz) S.viz.svg.transition().duration(300).call(S.viz.zoom.scaleBy, 1.3);
    });
    $("#btn-zoom-out")?.addEventListener("click", () => {
        if (S.viz) S.viz.svg.transition().duration(300).call(S.viz.zoom.scaleBy, 0.7);
    });
    $("#btn-zoom-reset")?.addEventListener("click", () => {
        if (S.viz) {
            S.viz.svg.transition().duration(400).call(
                S.viz.zoom.transform,
                d3.zoomIdentity.translate(60, 30).scale(0.82)
            );
            resetHighlights();
        }
    });
}

// ═══ Modal ═══════════════════════════════════════════════════════
function setupModal() {
    $("#btn-info")?.addEventListener("click", () => ($("#modal").style.display = "flex"));
    $("#btn-close-modal")?.addEventListener("click", () => ($("#modal").style.display = "none"));
    $("#modal")?.addEventListener("click", (e) => {
        if (e.target === $("#modal")) $("#modal").style.display = "none";
    });
}

// ═══ Stats ═══════════════════════════════════════════════════════
function updateStats() {
    if (!S.tree) return;
    const st = S.tree.structure || [];
    let maxP = 0, cnt = 0, maxD = 0;

    function walk(nodes, d) {
        for (const n of nodes) {
            cnt++;
            if (n.end_index > maxP) maxP = n.end_index;
            if (d > maxD) maxD = d;
            if (n.nodes) walk(n.nodes, d + 1);
        }
    }
    walk(st, 1);

    $("#s-pages").textContent = maxP;
    $("#s-nodes").textContent = cnt;
    $("#s-depth").textContent = maxD;
    $("#s-queries").textContent = S.queries;
}

// ═══ Utilities ═══════════════════════════════════════════════════
function esc(t) {
    const d = document.createElement("div");
    d.textContent = t || "";
    return d.innerHTML;
}

function fmtMd(text) {
    let h = esc(text);
    h = h.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\[Page (\d+)\]/g, '<code>[Page $1]</code>');
    const paras = h.split("\n\n").filter((p) => p.trim());
    return paras.length > 1
        ? paras.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("")
        : `<p>${h.replace(/\n/g, "<br>")}</p>`;
}

function toast(msg, isErr) {
    const t = document.createElement("div");
    t.style.cssText = `
        position:fixed;bottom:20px;right:20px;padding:12px 20px;
        background:var(--bg2);border:1px solid ${isErr ? "var(--red)" : "var(--border)"};
        border-radius:var(--radius-md);color:var(--text);font-size:.85rem;
        z-index:2000;box-shadow:var(--shadow-lg);animation:msgIn .3s ease;
    `;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 3000);
}


