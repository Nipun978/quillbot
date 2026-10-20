import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

const TABLE_NAME = 'quillbot_chunks';

export class VectorStore {
  constructor(config = {}, cwd = process.cwd()) {
    this.config = config;
    this.cwd = cwd;
    this.dbPath = path.join(cwd, '.quillbot', 'index');
    this.db = null;
    this.table = null;
  }

  async init() {
    this.db = await lancedb.connect(this.dbPath);
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      this.table = null;
    }
    return this;
  }

  async close() {
    if (this.table) {
      try {
        if (typeof this.table.close === 'function') {
          await this.table.close();
        }
      } catch {}
      this.table = null;
    }
    if (this.db) {
      try {
        if (typeof this.db.close === 'function') {
          await this.db.close();
        }
      } catch {}
      this.db = null;
    }
  }

  async _ensureTable(initialRows = []) {
    if (this.table) return this.table;

    if (!initialRows || initialRows.length === 0) {
      // Create empty/dummy schema row to initialize table
      const dummyDim = this.config.ollama?.embeddingDimensions || 768;
      const dummyRow = {
        id: '__schema_init__',
        source_path: '__init__',
        source_type: 'init',
        authority_tier: 0,
        chapter_num: 0,
        section_title: 'init',
        updated_at: Date.now(),
        text: '__init__',
        vector: new Array(dummyDim).fill(0)
      };
      this.table = await this.db.createTable(TABLE_NAME, [dummyRow], { mode: 'overwrite' });
      await this.table.delete("id = '__schema_init__'");
    } else {
      this.table = await this.db.createTable(TABLE_NAME, initialRows, { mode: 'overwrite' });
    }

    await this.rebuildFtsIndex();
    return this.table;
  }

  async rebuildFtsIndex() {
    if (!this.table) return;
    try {
      const rowCount = await this.table.countRows();
      if (rowCount > 0) {
        await this.table.createIndex('text', {
          config: lancedb.Index.fts({ withPosition: true }),
          replace: true
        });
      }
    } catch (err) {
      // If index already exists or FTS not available, log warning
      // but do not crash
    }
  }

  async addChunks(chunksWithVectors = []) {
    if (!chunksWithVectors || chunksWithVectors.length === 0) return;

    const rows = chunksWithVectors.map((c) => ({
      id: c.id,
      source_path: c.source_path,
      source_type: c.source_type,
      authority_tier: Number(c.authority_tier) || 1,
      chapter_num: Number(c.chapter_num) || 0,
      section_title: c.section_title || '',
      updated_at: Date.now(),
      text: c.text,
      vector: Array.from(c.vector)
    }));

    if (!this.table) {
      await this._ensureTable(rows);
    } else {
      await this.table.add(rows);
      await this.rebuildFtsIndex();
    }
  }

  async deleteBySourcePath(relativePath) {
    if (!this.table) return;
    const normalized = relativePath.replace(/\\/g, '/');
    try {
      // Escape single quotes for SQL filter
      const escaped = normalized.replace(/'/g, "''");
      await this.table.delete(`source_path = '${escaped}'`);
    } catch {
      // Table may be empty
    }
  }

  async hybridSearch({
    queryText,
    queryVector,
    vectorTopK = 15,
    bm25TopK = 15,
    rrfK = 60,
    authorityBoosts = { 1: 1.25, 2: 1.10, 3: 1.00 }
  }) {
    if (!this.table) {
      return [];
    }

    const rowCount = await this.table.countRows();
    if (rowCount === 0) {
      return [];
    }

    // 1. Vector Search
    let vectorHits = [];
    if (queryVector && queryVector.length > 0) {
      try {
        vectorHits = await this.table
          .vectorSearch(queryVector)
          .limit(vectorTopK)
          .toArray();
      } catch (err) {
        vectorHits = [];
      }
    }

    // 2. BM25 Full-Text Search
    let bm25Hits = [];
    if (queryText && queryText.trim()) {
      try {
        // Clean query text for FTS search
        const cleanQuery = queryText.replace(/[^\w\s]/g, ' ').trim();
        if (cleanQuery) {
          bm25Hits = await this.table
            .search(cleanQuery, 'fts')
            .limit(bm25TopK)
            .toArray();
        }
      } catch (err) {
        bm25Hits = [];
      }
    }

    // 3. Reciprocal Rank Fusion (RRF) with Authority Tier Boosts
    const fusedMap = new Map();

    // Map ranks (1-indexed)
    vectorHits.forEach((hit, idx) => {
      const rank = idx + 1;
      const existing = fusedMap.get(hit.id) || {
        chunk: hit,
        vectorRank: Infinity,
        bm25Rank: Infinity
      };
      existing.vectorRank = rank;
      existing.chunk = hit;
      fusedMap.set(hit.id, existing);
    });

    bm25Hits.forEach((hit, idx) => {
      const rank = idx + 1;
      const existing = fusedMap.get(hit.id) || {
        chunk: hit,
        vectorRank: Infinity,
        bm25Rank: Infinity
      };
      existing.bm25Rank = rank;
      existing.chunk = hit;
      fusedMap.set(hit.id, existing);
    });

    const candidates = [];
    for (const [id, entry] of fusedMap.entries()) {
      const tier = Number(entry.chunk.authority_tier) || 3;
      const tierBoost = authorityBoosts[tier] ?? 1.0;

      const vScore = entry.vectorRank !== Infinity ? 1 / (rrfK + entry.vectorRank) : 0;
      const bScore = entry.bm25Rank !== Infinity ? 1 / (rrfK + entry.bm25Rank) : 0;
      const rrfScore = tierBoost * (vScore + bScore);

      candidates.push({
        ...entry.chunk,
        rrfScore,
        vectorRank: entry.vectorRank,
        bm25Rank: entry.bm25Rank
      });
    }

    // Sort descending by RRF score
    candidates.sort((a, b) => b.rrfScore - a.rrfScore);
    return candidates;
  }
}
