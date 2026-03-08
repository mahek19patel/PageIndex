"""
PageIndex RAG System - Flask Backend
Tree-based, vectorless, reasoning-driven retrieval-augmented generation.
"""

import os
import json
import time
import uuid
import logging
from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

load_dotenv()

# ── Configuration ─────────────────────────────────────────────────
app = Flask(__name__, static_folder="static")
CORS(app)

UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), "uploads")
RESULTS_FOLDER = os.path.join(os.path.dirname(__file__), "results")
ALLOWED_EXT = {"pdf"}
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(RESULTS_FOLDER, exist_ok=True)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Global event queues per session
events = {}


# ── Helpers ───────────────────────────────────────────────────────
def allowed(fn):
    return "." in fn and fn.rsplit(".", 1)[1].lower() in ALLOWED_EXT


def emit(sid, etype, data):
    events.setdefault(sid, []).append({"type": etype, "data": data, "ts": time.time()})


def extract_pdf(path):
    """Extract text from each page of a PDF."""
    import pymupdf
    doc = pymupdf.open(path)
    pages = [doc[i].get_text() for i in range(len(doc))]
    doc.close()
    return pages

def call_llm(prompt, model="google/google/gemini-2.5-flash", temperature=0):
    """Call OpenRouter API."""
    import openai
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        raise ValueError("Set OPENROUTER_API_KEY in .env")

    client = openai.OpenAI(
        api_key=key,
        base_url="https://openrouter.ai/api/v1",
    )

    for attempt in range(4):
        try:
            r = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=temperature,
                max_tokens=4000,
            )
            return r.choices[0].message.content
        except Exception as e:
            err_str = str(e)
            log.error(f"LLM error attempt {attempt+1}: {err_str}")
            if "429" in err_str or "exhausted" in err_str.lower() or "quota" in err_str.lower():
                log.info("Rate limit exceeded, sleeping for 5 seconds...")
                time.sleep(5)
            elif attempt < 3:
                time.sleep(2 ** attempt)
            else:
                raise

def parse_json(text):
    """Robustly extract JSON from LLM response."""
    import re
    # Try to find JSON in code block
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    raw = m.group(1).strip() if m else text.strip()
    # Clean common issues
    raw = raw.replace("None", "null").replace("True", "true").replace("False", "false")
    raw = re.sub(r",\s*([}\]])", r"\1", raw)  # trailing commas
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Last resort: find first { to last }
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start:end])
            except:
                pass
        return {}


# ── Tree Builder ──────────────────────────────────────────────────
def build_tree(pdf_path, sid, model="google/gemini-2.5-flash"):
    """Build PageIndex hierarchical tree from a PDF document."""
    emit(sid, "status", {"msg": "📄 Extracting PDF text...", "phase": "extract"})
    pages = extract_pdf(pdf_path)
    n = len(pages)
    emit(sid, "status", {"msg": f"📄 Extracted {n} pages", "phase": "extract"})

    # Gather first ~15 pages for TOC / structure detection
    emit(sid, "status", {"msg": "🌲 Analyzing document structure...", "phase": "tree"})
    sample = "\n\n".join(
        [f"--- Page {i+1} ---\n{pages[i]}" for i in range(min(15, n))]
    )[:15000]

    prompt = f"""Analyze these PDF pages and extract the hierarchical structure of the document.

Pages:
{sample}

Total pages in document: {n}

Return a JSON object:
{{
  "doc_name": "document title",
  "structure": [
    {{
      "title": "Section Title",
      "start_index": 1,
      "end_index": 5,
      "summary": "1-2 sentence summary",
      "nodes": [
        {{
          "title": "Subsection",
          "start_index": 2,
          "end_index": 3,
          "summary": "summary",
          "nodes": []
        }}
      ]
    }}
  ]
}}

Rules:
- start_index / end_index are 1-based page numbers
- Every page (1 to {n}) must be covered by some section
- Create 2-3 levels of hierarchy
- Each node MUST have "nodes" key (empty array [] if leaf)
- Return ONLY valid JSON, no markdown, no explanation"""

    resp = call_llm(prompt, model=model)
    tree = parse_json(resp)

    if not tree or "structure" not in tree or not tree["structure"]:
        # Fallback: chunk into equal sections
        emit(sid, "status", {"msg": "🔄 Creating fallback structure...", "phase": "tree"})
        chunk = max(1, n // 5)
        sections = []
        for i in range(0, n, chunk):
            sections.append({
                "title": f"Section {len(sections)+1}",
                "start_index": i + 1,
                "end_index": min(i + chunk, n),
                "summary": f"Pages {i+1}–{min(i+chunk, n)}",
                "nodes": [],
            })
        tree = {"doc_name": os.path.basename(pdf_path), "structure": sections}

    # Assign node IDs
    emit(sid, "status", {"msg": "🔢 Assigning node IDs...", "phase": "ids"})
    _assign_ids(tree["structure"])

    # Enrich summaries where missing
    emit(sid, "status", {"msg": "📝 Generating summaries...", "phase": "summaries"})
    _enrich(tree["structure"], pages, model, sid)

    if "doc_name" not in tree or not tree["doc_name"]:
        tree["doc_name"] = os.path.basename(pdf_path)

    emit(sid, "tree_complete", {"tree": tree})
    return tree


def _assign_ids(nodes, counter=None):
    if counter is None:
        counter = [0]
    for node in (nodes if isinstance(nodes, list) else [nodes]):
        node["node_id"] = str(counter[0]).zfill(4)
        counter[0] += 1
        for child in node.get("nodes") or []:
            _assign_ids(child, counter)


def _enrich(nodes, pages, model, sid):
    for node in (nodes if isinstance(nodes, list) else [nodes]):
        if not node.get("summary"):
            s = max(0, node.get("start_index", 1) - 1)
            e = node.get("end_index", s + 1)
            txt = "\n".join(pages[s:e])[:3000]
            if txt.strip():
                try:
                    r = call_llm(
                        f'Summarize this section titled "{node.get("title","")}" in 1-2 sentences:\n\n{txt}\n\nReturn only the summary.',
                        model=model,
                    )
                    node["summary"] = r.strip()
                except Exception as err:
                    if "429" in str(err) or "exhausted" in str(err).lower() or "quota" in str(err).lower():
                        raise err # Re-raise rate limits so it can backoff
                    node["summary"] = f"Pages {s+1}–{e}"
            else:
                node["summary"] = f"Pages {s+1}–{e}"
        emit(sid, "node_done", {"id": node.get("node_id"), "title": node.get("title")})
        for child in node.get("nodes") or []:
            _enrich(child, pages, model, sid)


# ── Tree Search (Reasoning Retrieval) ────────────────────────────
def _find_node(structure, nid):
    for node in (structure if isinstance(structure, list) else [structure]):
        if node.get("node_id") == nid:
            return node
        for child in node.get("nodes") or []:
            found = _find_node(child, nid)
            if found:
                return found
    return None


def tree_search(query, tree, pages, sid, model="google/gemini-2.5-flash"):
    """Reasoning-based tree search: LLM navigates hierarchy to find relevant sections."""
    structure = tree.get("structure", [])
    if not structure:
        return [], []

    emit(sid, "search_start", {"query": query})

    # Level 1: reason over top-level sections
    top = [
        {
            "node_id": s["node_id"],
            "title": s["title"],
            "summary": s.get("summary", ""),
            "pages": f"{s['start_index']}-{s['end_index']}",
            "has_children": bool(s.get("nodes")),
        }
        for s in structure
    ]

    prompt1 = f"""You are navigating a document tree to find information for a query.

Query: "{query}"

Top-level sections:
{json.dumps(top, indent=2)}

Which sections are most likely to contain the answer? Return JSON:
{{
  "reasoning": "step by step reasoning",
  "relevant_ids": ["node_id1", "node_id2"]
}}

Return ONLY valid JSON."""

    emit(sid, "status", {"msg": "🧠 Reasoning over tree structure...", "phase": "search"})
    r1 = parse_json(call_llm(prompt1, model=model))
    relevant_ids = r1.get("relevant_ids") or r1.get("relevant_sections") or []

    search_path = []
    found_pages = set()

    for nid in relevant_ids:
        emit(sid, "highlight", {"node_id": nid, "status": "searching"})
        time.sleep(0.2)
        node = _find_node(structure, nid)
        if not node:
            continue
        search_path.append({"node_id": nid, "title": node["title"], "reason": "Top-level match"})

        children = node.get("nodes") or []
        if children:
            # Level 2: reason deeper
            emit(sid, "status", {"msg": f"🔎 Exploring '{node['title']}'...", "phase": "deep"})
            kids = [
                {
                    "node_id": c["node_id"],
                    "title": c["title"],
                    "summary": c.get("summary", ""),
                    "pages": f"{c['start_index']}-{c['end_index']}",
                }
                for c in children
            ]
            prompt2 = f"""Query: "{query}"

Subsections of "{node['title']}":
{json.dumps(kids, indent=2)}

Which subsections are relevant? Return JSON:
{{
  "relevant_ids": ["id1"]
}}"""
            r2 = parse_json(call_llm(prompt2, model=model))
            sub_ids = r2.get("relevant_ids") or r2.get("relevant_subsections") or []

            for sub_id in sub_ids:
                sub = _find_node(structure, sub_id)
                if sub:
                    emit(sid, "highlight", {"node_id": sub_id, "status": "found"})
                    search_path.append({"node_id": sub_id, "title": sub["title"], "reason": "Subsection match"})
                    for p in range(sub["start_index"], sub["end_index"] + 1):
                        found_pages.add(p)

            # If no subsections matched, use parent pages
            if not sub_ids:
                for p in range(node["start_index"], node["end_index"] + 1):
                    found_pages.add(p)
        else:
            for p in range(node["start_index"], node["end_index"] + 1):
                found_pages.add(p)

        emit(sid, "highlight", {"node_id": nid, "status": "found"})

    # Collect page text
    context = []
    for pg in sorted(found_pages):
        if 0 < pg <= len(pages):
            context.append(f"[Page {pg}]\n{pages[pg - 1]}")

    emit(sid, "search_done", {
        "path": search_path,
        "pages": sorted(found_pages),
        "reasoning": r1.get("reasoning", ""),
    })

    return context, search_path


def generate_answer(query, context, path, model="google/gemini-2.5-flash"):
    """Generate a cited answer from retrieved context."""
    ctx = "\n\n".join(context[:5])[:8000]
    path_desc = "\n".join([f"- {p['title']} (Node {p['node_id']})" for p in path])

    prompt = f"""Answer the question using ONLY the retrieved content below.

Search path through document tree:
{path_desc}

Retrieved content:
{ctx}

Question: {query}

Rules:
- Cite pages using [Page X]
- If info is not found, say so
- Provide a detailed and comprehensive explanation. Be generous with the amount of information you provide. Use bullet points if applicable to make it more readable and elaborate fully on the user's question.

Answer:"""
    return call_llm(prompt, model=model)


# ── Routes ────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:fn>")
def static_file(fn):
    return send_from_directory("static", fn)


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    if not f.filename or not allowed(f.filename):
        return jsonify({"error": "Only PDF allowed"}), 400
    sid = str(uuid.uuid4())
    fn = secure_filename(f.filename)
    path = os.path.join(UPLOAD_FOLDER, f"{sid}_{fn}")
    f.save(path)
    events[sid] = []
    return jsonify({"session_id": sid, "filename": fn})


@app.route("/api/process/<sid>", methods=["POST"])
def process(sid):
    files = [f for f in os.listdir(UPLOAD_FOLDER) if f.startswith(sid)]
    if not files:
        return jsonify({"error": "File not found"}), 404
    path = os.path.join(UPLOAD_FOLDER, files[0])
    model = (request.json or {}).get("model", "google/gemini-2.5-flash")
    try:
        tree = build_tree(path, sid, model)
        with open(os.path.join(RESULTS_FOLDER, f"{sid}.json"), "w", encoding="utf-8") as f:
            json.dump(tree, f, indent=2, ensure_ascii=False)
        return jsonify({"tree": tree})
    except Exception as e:
        log.error(f"Process error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/query/<sid>", methods=["POST"])
def query(sid):
    data = request.json or {}
    q = data.get("query", "").strip()
    if not q:
        return jsonify({"error": "No query"}), 400

    tree_path = os.path.join(RESULTS_FOLDER, f"{sid}.json")
    if not os.path.exists(tree_path):
        return jsonify({"error": "Document not processed"}), 404

    with open(tree_path, "r", encoding="utf-8") as f:
        tree = json.load(f)

    files = [f for f in os.listdir(UPLOAD_FOLDER) if f.startswith(sid)]
    if not files:
        return jsonify({"error": "PDF not found"}), 404

    pages = extract_pdf(os.path.join(UPLOAD_FOLDER, files[0]))
    model = data.get("model", "google/gemini-2.5-flash")

    try:
        context, path = tree_search(q, tree, pages, sid, model)
        emit(sid, "status", {"msg": "✍️ Generating answer...", "phase": "answer"})
        answer = generate_answer(q, context, path, model)

        # Collect referenced pages
        ref_pages = set()
        for sp in path:
            node = _find_node(tree.get("structure", []), sp["node_id"])
            if node:
                for p in range(node["start_index"], node["end_index"] + 1):
                    ref_pages.add(p)

        emit(sid, "answer_done", {"answer": answer})
        return jsonify({"answer": answer, "search_path": path, "pages": sorted(ref_pages)})
    except Exception as e:
        log.error(f"Query error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/events/<sid>")
def sse(sid):
    def stream():
        idx = 0
        t0 = time.time()
        while time.time() - t0 < 300:
            if sid in events:
                while idx < len(events[sid]):
                    evt = events[sid][idx]
                    yield f"data: {json.dumps(evt)}\n\n"
                    idx += 1
                    if evt["type"] in ("tree_complete", "answer_done", "error"):
                        return
            time.sleep(0.1)

    return Response(stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no",
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
