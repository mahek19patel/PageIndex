# PageIndex RAG 🌲

A **vectorless, reasoning-based RAG system** that builds a hierarchical tree index from PDF documents and uses LLMs to reason over it for precise retrieval — inspired by [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex).

## Features
- 🌲 **Tree Indexing** — builds a hierarchical TOC tree from any PDF
- 🧠 **LLM Reasoning** — AI navigates the tree to find relevant sections (no vectors!)
- 🎯 **Precise Retrieval** — page-cited answers with full search path visibility
- 👁️ **Visual Tree Search** — watch the AI reason through your document in real-time (D3.js)
- ⚡ **50/50 Split UI** — interactive tree on the left, chat on the right

## Setup

```bash
# 1. Clone
git clone https://github.com/mahek19patel/PageIndex.git
cd PageIndex

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set your OpenAI API key
echo "OPENAI_API_KEY=your_key_here" > .env

# 4. Run
python app.py
# Open http://localhost:5000
```

## How It Works

1. **Upload** a PDF → text is extracted page by page  
2. **Tree Build** → LLM analyzes the document and creates a hierarchical index (like a Table of Contents)  
3. **Tree Search** → when you ask a question, the LLM *reasons* through the tree to find relevant sections  
4. **Answer** → retrieved context is used to generate a precise, cited response  

## Tech Stack
- **Backend**: Flask + OpenAI GPT-4o-mini + PyMuPDF  
- **Frontend**: Vanilla JS + D3.js (tree visualization)  
- **No vector DB required**

## Credits
Inspired by [PageIndex by VectifyAI](https://github.com/VectifyAI/PageIndex) — achieves 98.7% accuracy on FinanceBench.
