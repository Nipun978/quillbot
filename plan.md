Copy and save the specification below as `plan.md` (or `SPEC.md`) in the root of your repository. It is structured specifically for AI coding agents (Cursor, Windsurf, Claude Code, Cline), providing exact package versions, file schemas, LanceDB BM25 + Vector hybrid queries, local ONNX reranking in Node.js, and step-by-step implementation milestones so your coding agent builds the entire system without hallucinating APIs.

```markdown
# Quillbot â€” Production Specification & Architecture Plan (`plan.md`)

## 1. Project Overview
**Quillbot** is a global, interactive, turn-based Node.js CLI story-writing agent launched via the `quillbot` terminal command. It operates on the user's current working directory (the novel workspace), combining **Groq cloud inference** (`openai/gpt-oss-20b` for fast routing/summarization and `openai/gpt-oss-120b` for planning and prose generation) with a **100% local RAG pipeline** powered by **Ollama embeddings** (`embeddinggemma`), **LanceDB** (Vector Search + BM25 Full-Text Search), and a **local CPU ONNX Cross-Encoder Reranker**.

### Core Design Pillars
1. **Story Bible as Absolute Source of Truth:** All lore, character sheets, and world rules live in a flat `story-bible/` folder (`.md` and `.txt` files, no subfolders).
2. **Hybrid Retrieval (Vector + BM25 + Local Reranking):** Every retrieval pass runs semantic vector search (via Ollama `embeddinggemma`) AND BM25 keyword search (via LanceDB FTS) across `story-bible/`, `project/`, and `conversations/`, merges results via Reciprocal Rank Fusion (RRF), and reranks the top candidates locally.
3. **Beat-by-Beat Chapter Writing with Human-in-the-Loop:** Chapters are planned into structured beats (`project/chapter-XX/plan.md`) and written one beat at a time (`project/chapter-XX/chapter.md`) with interactive `[A]ccept`, `[R]etry with feedback`, and `[E]dit` controls.
4. **Zero-Config Startup & Lazy File Sync:** Running `quillbot` in an uninitialized folder triggers an interactive setup wizard to create `.quillbot/config.json`. File edits in `story-bible/` or `project/` are tracked via SHA-256 hashes in `.quillbot/state.json` and automatically re-indexed on change.

---

## 2. Tech Stack & Dependencies (`package.json`)

- **Runtime:** Node.js >= 20.0.0 (ES Modules `"type": "module"`)
- **Language:** Vanilla JavaScript (ES2024+)
- **CLI Entrypoint:** `"bin": { "quillbot": "./bin/quillbot.js" }`

### Required `package.json`
```json
{
  "name": "quillbot-cli",
  "version": "1.0.0",
  "description": "Interactive CLI Story Writing Agent with Local Hybrid RAG and Groq Inference",
  "type": "module",
  "bin": {
    "quillbot": "./bin/quillbot.js"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "@huggingface/transformers": "^3.1.0",
    "@inquirer/prompts": "^7.0.0",
    "@lancedb/lancedb": "^0.15.0",
    "apache-arrow": "^17.0.0",
    "chalk": "^5.3.0",
    "chokidar": "^4.0.0",
    "dotenv": "^16.4.5",
    "groq-sdk": "^0.8.0",
    "marked": "^14.1.0",
    "marked-terminal": "^7.2.0",
    "ora": "^8.1.0"
  }
}

```

> **Note on Local Reranker in Node.js:** Python's `flashrank` uses quantized ONNX cross-encoders under the hood. In Node.js, use `@huggingface/transformers` with `Xenova/ms-marco-MiniLM-L-6-v2` (a 23MB local ONNX cross-encoder that runs on CPU in <40ms without Python).

---

## 3. Directory Structures

### 3.1 Quillbot CLI Application Source Code Structure

```text
quillbot-cli/
â”œâ”€â”€ package.json
â”œâ”€â”€ bin/
â”‚   â””â”€â”€ quillbot.js              # Executable entry point (#!/usr/bin/env node)
â””â”€â”€ src/
    â”œâ”€â”€ index.js                 # Bootstrapping, config check, REPL startup
    â”œâ”€â”€ config/
    â”‚   â”œâ”€â”€ configManager.js     # Reads/writes .quillbot/config.json & first-run wizard
    â”‚   â””â”€â”€ stateManager.js      # Reads/writes .quillbot/state.json (hashes, active chapter/beat)
    â”œâ”€â”€ rag/
    â”‚   â”œâ”€â”€ embedder.js          # Calls local Ollama /api/embed with Gemma model
    â”‚   â”œâ”€â”€ chunker.js           # Markdown/text chunking with context header injection
    â”‚   â”œâ”€â”€ vectorStore.js       # LanceDB setup, Vector Search + BM25 FTS + RRF fusion
    â”‚   â”œâ”€â”€ reranker.js          # Local ONNX cross-encoder reranker (@huggingface/transformers)
    â”‚   â””â”€â”€ fileSync.js          # Chokidar watcher + SHA-256 hash diffing for incremental indexing
    â”œâ”€â”€ llm/
    â”‚   â”œâ”€â”€ groqClient.js        # Streaming & JSON calls for gpt-oss-20b and gpt-oss-120b
    â”‚   â””â”€â”€ prompts.js           # System prompts, Truth Hierarchy XML templates, Beat templates
    â”œâ”€â”€ workflows/
    â”‚   â”œâ”€â”€ initProject.js       # "Story in a nutshell" -> auto-generates story-bible/*.md files
    â”‚   â”œâ”€â”€ chatBible.js         # /bible slash command & conversational RAG loop
    â”‚   â”œâ”€â”€ planChapter.js       # /plan <num> -> generates project/chapter-XX/plan.md
    â”‚   â”œâ”€â”€ writeChapter.js      # /write <num> -> beat-by-beat loop with Accept/Retry/Edit
    â”‚   â””â”€â”€ conversationMgr.js   # Manages conversations/current.json & archive/ summaries
    â””â”€â”€ ui/
        â”œâ”€â”€ repl.js              # Turn-based chat loop with Tab slash-command autocomplete
        â”œâ”€â”€ reviewPrompt.js      # Interactive [A]ccept / [R]etry / [E]dit handler + $EDITOR spawn
        â””â”€â”€ renderer.js          # Streaming markdown terminal output & status spinners

```

### 3.2 User Workspace Structure (Created inside the User's Novel Folder)

When the user runs `quillbot` inside any directory, Quillbot manages this exact structure:

```text
<user-novel-workspace>/
â”œâ”€â”€ .quillbot/
â”‚   â”œâ”€â”€ config.json              # API keys, model IDs, RAG & generation parameters
â”‚   â”œâ”€â”€ instructions.md          # Global prose rules, POV, tense, style guidelines
â”‚   â”œâ”€â”€ state.json               # File SHA-256 hashes, active chapter, current beat index
â”‚   â””â”€â”€ index/                   # Local LanceDB storage directory
â”œâ”€â”€ story-bible/                 # FLAT directory (.md and .txt only, NO subfolders) - Tier 1 Truth
â”‚   â”œâ”€â”€ characters.md
â”‚   â”œâ”€â”€ world-and-lore.md
â”‚   â”œâ”€â”€ locations.md
â”‚   â””â”€â”€ plot-overview.md
â”œâ”€â”€ conversations/
â”‚   â”œâ”€â”€ current.json             # Active session messages + rolling summary
â”‚   â””â”€â”€ archive/                 # Past conversations (session-<timestamp>.json + summary.md)
â””â”€â”€ project/
    â”œâ”€â”€ chapter-01/
    â”‚   â”œâ”€â”€ plan.md              # Chapter summary + structured numbered Beats
    â”‚   â”œâ”€â”€ chapter.md           # Accepted prose concatenated beat-by-beat
    â”‚   â””â”€â”€ summary.md           # Auto-generated 250-word canonical recap of finished chapter
    â””â”€â”€ chapter-02/
        â””â”€â”€ ...

```

---

## 4. Core File Schemas

### 4.1 `.quillbot/config.json`

```json
{
  "groqApiKey": "gsk_...",
  "models": {
    "small": "openai/gpt-oss-20b",
    "large": "openai/gpt-oss-120b"
  },
  "ollama": {
    "baseUrl": "[http://127.0.0.1:11434](http://127.0.0.1:11434)",
    "embeddingModel": "embeddinggemma",
    "embeddingDimensions": 768
  },
  "rag": {
    "chunkSizeTokens": 400,
    "chunkOverlapTokens": 60,
    "vectorTopK": 15,
    "bm25TopK": 15,
    "rerankTopK": 5,
    "rerankerModel": "Xenova/ms-marco-MiniLM-L-6-v2",
    "rrfK": 60
  },
  "generation": {
    "temperaturePlan": 0.6,
    "temperatureWrite": 0.75,
    "continuityTailWords": 350,
    "slidingChatWindowTurns": 8
  },
  "editor": "nano"
}

```

*(Note: If the user's Groq account aliases the models as `gpt-oss-20b` or `openai/gpt-oss-20b`, the user can edit `config.json` directly or via `/config`.)*

### 4.2 `.quillbot/state.json`

```json
{
  "initialized": true,
  "activeChapter": 1,
  "activeBeat": 1,
  "activeConversationId": "conv_20261020_120000",
  "fileHashes": {
    "story-bible/characters.md": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
}

```

### 4.3 `project/chapter-XX/plan.md` Schema

The `/plan` command must output this exact markdown format so `/write` can deterministically parse individual beats using regex (`/^### Beat (\d+): (.+)$/gm`):

```markdown
# Chapter 1: [Chapter Title]

## Chapter Summary
[1-paragraph overview of the chapter's narrative arc, pacing, and emotional shift.]

## Beats

### Beat 1: [Short Beat Title]
- **Characters:** [Comma-separated names matching story-bible]
- **Location:** [Location name matching story-bible]
- **Action:** [Detailed description of what happens in this beat]
- **Goal/Hook:** [How this beat transitions into the next beat]

### Beat 2: [Short Beat Title]
- **Characters:** [...]
- **Location:** [...]
- **Action:** [...]
- **Goal/Hook:** [...]

```

---

## 5. Local Hybrid RAG Engine Specification (`src/rag/`)

### 5.1 Smart Chunking with Context Header Injection (`chunker.js`)

1. **Enforce Flat `story-bible/` Constraint:** When scanning `story-bible/`, read only top-level `.md` and `.txt` files. Ignore any subdirectories or hidden files.
2. **Header-Aware Splitting:**
* Split `.md` files first by Markdown headings (`#`, `##`, `###`), keeping each section together if under `chunkSizeTokens` (~400 tokens / ~1,600 chars).
* If a section exceeds `chunkSizeTokens`, split by double newline (`\n\n`) with a 60-token overlap.


3. **Context Header Prepending (Critical for BM25 & Vector Accuracy):**
* Every chunk's `text` field MUST be prefixed with its source metadata before embedding and BM25 indexing:
`\n<raw_chunk_text>`



### 5.2 Local Ollama Gemma Embeddings (`embedder.js`)

* Call `POST ${config.ollama.baseUrl}/api/embed` with:
```json
{
  "model": "embeddinggemma",
  "input": ["chunk 1 text", "chunk 2 text"]
}

```


* Verify on startup that Ollama is running and the configured Gemma embedding model is pulled. If missing, display a clear CLI prompt offering to run `ollama pull embeddinggemma` or let the user specify their local Ollama Gemma embedding tag.

### 5.3 LanceDB Schema, Vector Search & BM25 Keyword Search (`vectorStore.js`)

Store a unified table `quillbot_chunks` inside `.quillbot/index`:

* **Columns:**
* `id` (string): `${relativePath}#chunk_${index}`
* `source_path` (string): e.g., `story-bible/characters.md`
* `source_type` (string): `"story-bible"` | `"chapter"` | `"chapter-summary"` | `"conversation"`
* `authority_tier` (number): `1` (story-bible), `2` (project chapters/summaries), `3` (past conversations)
* `chapter_num` (number): `0` for non-chapters, `1..N` for chapters
* `section_title` (string): Extracted Markdown heading
* `updated_at` (number): File modification epoch timestamp (`mtimeMs`)
* `text` (string): Context-prefixed chunk text
* `vector` (float32 array): Embedding vector from Ollama


* **Index Creation:**
After inserting or updating rows, build/update the BM25 Full-Text Search index on the `text` column:
```javascript
import * as lancedb from "@lancedb/lancedb";
await table.createIndex("text", {
  config: lancedb.Index.fts({ withPosition: true })
});

```


* **Dual Query Execution + Reciprocal Rank Fusion (RRF):**
For every search query:
1. **Vector Search:**
```javascript
const vectorHits = await table
  .vectorSearch(queryVector)
  .limit(config.rag.vectorTopK)
  .toArray();

```


2. **BM25 Keyword Search:**
```javascript
const bm25Hits = await table
  .search(queryText, "fts")
  .limit(config.rag.bm25TopK)
  .toArray();

```


3. **Combine via Reciprocal Rank Fusion (RRF):**
Compute combined score for each unique chunk `id` using `k = 60`:

$$\text{RRF\_Score}(d) = w_{\text{tier}} \times \left( \frac{1}{k + \text{rank}_{\text{vector}}(d)} + \frac{1}{k + \text{rank}_{\text{bm25}}(d)} \right)$$



Apply a tier boost multiplier $w_{\text{tier}}$:
* `story-bible` (Tier 1): `1.25x` boost
* `project` chapters/summaries (Tier 2): `1.10x` boost
* `conversations` (Tier 3): `1.00x` boost





### 5.4 Local ONNX Reranker (`reranker.js`)

* Lazy-load `@huggingface/transformers` pipeline (`AutoTokenizer` and `AutoModelForSequenceClassification`) with `Xenova/ms-marco-MiniLM-L-6-v2`.
* Take the top 15 RRF-fused chunks, score each `(queryText, chunk.text)` pair through the local cross-encoder, apply the authority tier boost, and return the top `rerankTopK` (default 5) chunks.

### 5.5 Incremental File Sync (`fileSync.js`)

* Compute SHA-256 hash of every `.md` and `.txt` file in `story-bible/`, `project/chapter-*/`, and `conversations/archive/`.
* Compare against `.quillbot/state.json -> fileHashes`.
* If a file was modified or deleted:
* Run `await table.delete(\`source_path = '${relativePath}'`)` in LanceDB.
* Re-chunk, re-embed, and `await table.add(newRows)` for modified/new files.
* Rebuild FTS index and save updated hashes to `state.json`.


* Also attach a background `chokidar` watcher on `story-bible/` while the CLI is open so dropping a new `.md` or `.txt` file into `story-bible/` triggers immediate background indexing.

---

## 6. CLI User Experience & Slash Commands (`src/ui/` & `src/workflows/`)

### 6.1 Startup & Fresh Onboarding Flow

When the user runs `quillbot` in their terminal:

1. **Check `.quillbot/config.json`:**
* If missing, launch an interactive setup wizard (`@inquirer/prompts`):
1. Prompt for **Groq API Key** (masked input).
2. Prompt for **Small Model ID** (default: `openai/gpt-oss-20b`).
3. Prompt for **Large Model ID** (default: `openai/gpt-oss-120b`).
4. Prompt for **Ollama Base URL** (default: `http://127.0.0.1:11434`) & **Ollama Gemma Embedding Model** (default: `embeddinggemma`).
5. Create `.quillbot/`, `story-bible/`, `conversations/archive/`, and `project/` directories.
6. Create default `.quillbot/instructions.md` and `.quillbot/config.json`.




2. **Check if `story-bible/` is empty:**
* Ask the user: *"Your story-bible/ is empty. Would you like to initialize your project by pasting your story in a nutshell? (Y/n)"*
* If Yes, run the **Project Initialization Workflow** (`/init`).



### 6.2 Turn-Based Chat REPL with Slash Command Autocomplete (`repl.js`)

Use Node's native `node:readline/promises` configured with a custom `completer` function:

```javascript
const SLASH_COMMANDS = [
  '/init', '/bible', '/plan', '/write',
  '/chat', '/load', '/new', '/sync', '/config', '/status', '/help', '/exit'
];

function completer(line) {
  if (line.startsWith('/')) {
    const hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
    return [hits.length ? hits : SLASH_COMMANDS, line];
  }
  return [[], line];
}

```

* Typing `/` and pressing `Tab` autocompletes slash commands cleanly.
* Typing regular text without a slash command sends a message in the active conversation mode (defaults to chatting with the Story Bible + project context).

### 6.3 Slash Command Specifications

#### 1. `/init` â€” Seed Story Bible from "Story in a Nutshell"

* Prompts the user to paste their story synopsis (supports multi-line paste).
* Calls **Groq Large Model (`openai/gpt-oss-120b`)** to generate four foundational markdown files inside `story-bible/`:
* `story-bible/characters.md`
* `story-bible/world-and-lore.md`
* `story-bible/locations.md`
* `story-bible/plot-overview.md`


* Presents each generated file or the combined overview with **`[A]ccept / [R]etry / [E]dit`**.
* Once accepted, writes files to `story-bible/` and runs `fileSync` to index them into LanceDB.

#### 2. `/bible [question or brainstorm]` â€” Chat with Story Bible

* Switches mode to Story Bible consultation (or answers a one-off query).
* **Step 1 (Query Rewriting):** Calls **Groq Small Model (`openai/gpt-oss-20b`)** with the last 4 turns of `conversations/current.json` to rewrite vague pronouns (*"What is his relation to her?"*) into an explicit search query (*"Debu relationship with Amba in story-bible"*).
* **Step 2 (Hybrid Retrieval):** Runs Vector + BM25 search across `story-bible/` (Tier 1), `project/` (Tier 2), and `conversations/archive/` (Tier 3), reranked locally.
* **Step 3 (Response):** Streams response from `openai/gpt-oss-120b` citing the exact `` files used.
* **Sub-command `/bible save`:** Extracts any newly agreed lore from the recent chat turns, proposes an update/append to a `story-bible/*.md` file, and prompts `[A]ccept / [R]etry / [E]dit`.

#### 3. `/plan <chapter_number>` â€” Plan a Chapter in Beats

* Example: `/plan 1` or `/plan 2`.
* **Context Assembled:**
1. `.quillbot/instructions.md`
2. All previous chapter summaries (`project/chapter-01/summary.md`, etc.)
3. Hybrid RAG results from `story-bible/` and `conversations/current.json` matching the user's chapter guidance.


* **Generation:** Calls `openai/gpt-oss-120b` to draft `project/chapter-XX/plan.md` following the strict Beat Schema (Section 4.3).
* **Review Loop:** Displays the rendered plan in the terminal and triggers the **`[A]ccept / [R]etry / [E]dit`** menu:
* **Accept:** Saves `project/chapter-XX/plan.md`, indexes it, and sets `activeChapter = XX, activeBeat = 1` in `state.json`.
* **Retry:** Prompts *"What would you like to change in this plan?"*, feeds current draft + user feedback back to `openai/gpt-oss-120b`, and re-renders.
* **Edit:** Opens `project/chapter-XX/plan.md` in the user's system editor (`$EDITOR` or `config.editor`), waits for save/close, validates beat headers, and saves.



#### 4. `/write <chapter_number>` â€” Beat-by-Beat Prose Engine

* Reads `project/chapter-XX/plan.md` and parses all `### Beat N:` blocks.
* Checks `state.json` (or existing `chapter.md` markers) to resume from the first unwritten beat.
* **For each Beat $N$:**
1. **Targeted Hybrid RAG:** Extracts the `Characters`, `Location`, and `Action` lines from Beat $N$. Runs a hybrid Vector + BM25 search against `story-bible/` and past chapters to pull the top 5 relevant character/lore/chapter chunks.
2. **Continuity Window:**
* Pulls summaries of Beats $1 \dots N-1$ (if $N > 1$).
* Pulls the **verbatim last 350 words** of `project/chapter-XX/chapter.md` so prose style, rhythm, and scene continuity flow seamlessly.


3. **Prompt Assembly (Optimized for Groq Prefix Caching):**
* **Top (Static Prefix across all beats in the chapter):** `.quillbot/instructions.md` + Full `plan.md`.
* **Bottom (Dynamic Suffix per beat):** Retrieved `story-bible/` chunks + Past Chapter context + Verbatim last 350 words + Target Beat $N$ directive.


4. **Streaming Generation:** Streams the prose for Beat $N$ using `openai/gpt-oss-120b`.
5. **Interactive `[A]ccept / [R]etry / [E]dit / [P]ause` Gate:**
* `[A]ccept`: Appends the beat prose to `project/chapter-XX/chapter.md` (with an optional HTML comment `<!-- BEAT N -->` for tracking), updates `state.json`, and moves to Beat $N+1$.
* `[R]etry`: Asks user for revision notes (e.g., *"Slow down the pacing, add more sensory detail about the rain"*), regenerates Beat $N$ with the previous attempt + feedback.
* `[E]dit`: Spawns `$EDITOR` with a temporary file pre-filled with Beat $N$'s prose. When the user saves and exits the editor, reads the edited text, appends it to `chapter.md`, and advances to Beat $N+1$.
* `[P]ause`: Saves progress at Beat $N$ and returns to the main chat prompt.




* **Chapter Completion Hook:**
* When the final beat of Chapter $X$ is accepted, automatically call `openai/gpt-oss-20b` to generate a canonical 250-word `project/chapter-XX/summary.md` and trigger `fileSync` so the entire completed chapter and its summary are indexed in LanceDB.



#### 5. `/load` and `/new` â€” Conversation Management

* **Rolling Window in `conversations/current.json`:** Keeps the last 8 raw turns in memory. Whenever turns exceed 8, `openai/gpt-oss-20b` compresses the oldest 4 turns into a `rollingSummary` string stored inside `current.json`.
* **`/new`:** Archives `conversations/current.json` into `conversations/archive/conv-<timestamp>.json`, uses `openai/gpt-oss-20b` to write a distilled markdown decision log (`conversations/archive/conv-<timestamp>.md`), indexes that markdown summary into LanceDB (Tier 3), and starts a fresh `current.json`.
* **`/load`:** Lists archived conversations from `conversations/archive/` using an interactive `@inquirer/prompts` selector and restores the selected session into `conversations/current.json`.

---

## 7. Prompt Engineering & Hierarchy of Truth (`src/llm/prompts.js`)

Every RAG-augmented prompt sent to Groq MUST enforce the **Hierarchy of Truth** using explicit XML delimiters:

```xml
<system_instructions>
{{instructions_md_content}}
</system_instructions>

<hierarchy_of_truth_rules>
You must strictly obey the following source hierarchy when answering or writing:
1. TIER 1 (ABSOLUTE CANON - STORY BIBLE): Facts inside <story_bible_canon> are absolute law. Never contradict them.
2. TIER 2 (ESTABLISHED MANUSCRIPT - PAST CHAPTERS): Events inside <past_chapters> have already occurred in the story. Maintain strict continuity with them unless overridden by Tier 1.
3. TIER 3 (PAST CONVERSATIONS): Notes inside <past_conversations> represent earlier brainstorming. Ignore them if they conflict with Tier 1 or Tier 2.
</hierarchy_of_truth_rules>

<story_bible_canon>
{{tier_1_chunks}}
</story_bible_canon>

<past_chapters>
{{previous_chapter_summaries_and_tier_2_chunks}}
</past_chapters>

<past_conversations>
{{tier_3_chunks_and_rolling_summary}}
</past_conversations>

```

---

## 8. Step-by-Step Implementation Order for the Coding Agent

Execute the build in these exact phases and verify each phase before moving to the next:

1. **Phase 1: Scaffolding & Configuration Wizard**
* Initialize `package.json`, `bin/quillbot.js` (`chmod +x`), and `src/config/configManager.js` + `stateManager.js`.
* Build the first-run onboarding wizard that creates `.quillbot/config.json`, `.quillbot/instructions.md`, `.quillbot/state.json`, `story-bible/`, `conversations/archive/`, and `project/`.


2. **Phase 2: Groq Client & Ollama Embedding Client**
* Implement `src/llm/groqClient.js` supporting streaming chat completions and structured responses for both `openai/gpt-oss-20b` and `openai/gpt-oss-120b`.
* Implement `src/rag/embedder.js` connecting to local Ollama (`/api/embed`) using `embeddinggemma`.


3. **Phase 3: Local Hybrid RAG (LanceDB Vector + BM25 + Local Reranker + FileSync)**
* Implement `src/rag/chunker.js` (header-aware splitting + `` prefixing).
* Implement `src/rag/vectorStore.js` with LanceDB table creation, `Index.fts()` BM25 indexing, parallel Vector + BM25 queries, and Reciprocal Rank Fusion (RRF) with Authority Tier boosts.
* Implement `src/rag/reranker.js` using `@huggingface/transformers` (`Xenova/ms-marco-MiniLM-L-6-v2`).
* Implement `src/rag/fileSync.js` with SHA-256 hash comparison and `chokidar` watching on `story-bible/`.


4. **Phase 4: Interactive UI, Review Helper & Autocomplete REPL**
* Implement `src/ui/reviewPrompt.js` providing the reusable `[A]ccept / [R]etry / [E]dit` workflow (spawning `$EDITOR` on temp files for `[E]dit`).
* Implement `src/ui/repl.js` with Tab slash-command autocomplete and streaming markdown rendering.


5. **Phase 5: Core Workflows (`/init`, `/bible`, `/plan`, `/write`, `/load`, `/new`)**
* Implement `initProject.js`, `chatBible.js`, `planChapter.js`, `writeChapter.js`, and `conversationMgr.js`.
* Test the full end-to-end flow: `quillbot` -> fresh setup -> `/init` story synopsis -> `/bible` lore query -> `/plan 1` -> `/write 1` beat-by-beat with Accept/Retry/Edit.



```

<FollowUp label="Want a starter `.quillbot/instructions.md` tailored for literary fiction and beat-by-beat pacing?" query="Write a production-ready default .quillbot/instructions.md file that stops the AI from rushing beats or using cliched AI prose."/>

```
