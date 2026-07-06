# Memory: Cognitive Memory & Belief Graph Engine

A light-weight, edge-native cognitive memory and belief graph engine deployed on Cloudflare's serverless stack. This project is inspired by the architecture and concepts of [Supermemory](https://supermemory.ai).

---

## What is Done (Implemented Features)

### 1. Document Ingestion (`POST /v3/documents`)
* Splits raw content into overlapping chunks.
* Generates vector embeddings for chunks and saves them to Cloudflare Vectorize.
* Extracts atomic facts from chunks using Cloudflare Workers AI.
* Saves facts to the SQLite database and upserts their embeddings to Vectorize.

### 2. Document Retrieval (`GET /v3/documents/:id`)
* Retrieves the processing status and raw content of ingested documents.

### 3. Graph Chat Completion (`POST /v3/chat`)
* **Dual-Path Hybrid Retrieval:** Retrieves older memories via Vectorize search and combines them with a Direct SQL Fallback path for recently uploaded documents.
* **Recursive Graph Traversal:** Uses SQLite Common Table Expressions (CTEs) on Cloudflare D1 to traverse logical relationships (`Updates`, `Extends`, `Derives`) up to a user-defined depth.
* **Context Budgeting:** Limits background context injection to prevent LLM context-window overflow.

### 4. E2E Verification Tests
* Test suites located in `scratch/` verify the entire lifecycle from ingestion to recursive relationship matching.

---

## Getting Started

### 1. Install Dependencies
```bash
bun install
```

### 2. Local Database Migration
```bash
bun db:migrate:local
```

### 3. Start Local Development Server
```bash
bun dev
```


## Inspiration & License
This project is inspired by the design concepts of the [Supermemory](https://github.com/supermemoryai/supermemory) project.

