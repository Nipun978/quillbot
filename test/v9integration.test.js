import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { GroqClient } from '../src/llm/groqClient.js';
import { enhanceWritingStyleWithAi } from '../src/config/configManager.js';
import { chunkDocument } from '../src/rag/chunker.js';
import { OllamaEmbedder } from '../src/rag/embedder.js';
import { VectorStore } from '../src/rag/vectorStore.js';
import { CrossEncoderReranker } from '../src/rag/reranker.js';
import { syncAllFiles, startFileWatcher } from '../src/rag/fileSync.js';
import { runWriteChapterWorkflow, runContinuityCritic } from '../src/workflows/writeChapter.js';
import { runGeneralQuery, handleBibleSave } from '../src/workflows/chatBible.js';
import { ConversationManager } from '../src/workflows/conversationMgr.js';
import { replInputPrompt } from '../src/ui/repl.js';

/**
 * Starts a real local OpenAI/Groq-compatible TCP HTTP server on 127.0.0.1:0.
 * Drives the unmodified groq-sdk inside GroqClient over real HTTP sockets.
 */
async function startLocalGroqServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }
    requests.push({ url: req.url, method: req.method, body });

    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      try {
        await handler(body, req, res, requests.length);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not Found' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

function sendJsonCompletion(res, {
  content = 'ok',
  finishReason = 'stop',
  model = 'openai/gpt-oss-20b',
  promptTokens = 20,
  completionTokens = 10
} = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: finishReason
        }
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    })
  );
}

function sendSseCompletion(res, {
  deltas = ['Hello', ' world.'],
  model = 'openai/gpt-oss-120b',
  promptTokens = 40,
  completionTokens = 15
} = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  for (const delta of deltas) {
    const chunk = {
      id: `chatcmpl-stream-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  const finalChunk = {
    id: `chatcmpl-stream-end-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

test('Real GroqClient HTTP integration: reasoning_effort auto-low, length recovery, 503 retry, json empty guard, and style enhancement', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-v9-http-'));
  let mode = 'condense';
  let transientCount = 0;

  const server = await startLocalGroqServer(async (body, _req, res) => {
    if (mode === 'condense') {
      sendJsonCompletion(res, { content: 'Beat 1 (Dawn): Debu launches his ferry.', model: body.model });
      return;
    }

    if (mode === 'length_then_recover') {
      if (Number(body.max_tokens) <= 150) {
        sendJsonCompletion(res, { content: '', finishReason: 'length', model: body.model });
      } else {
        sendJsonCompletion(res, { content: 'Recovered full summary after length boost.', finishReason: 'stop', model: body.model });
      }
      return;
    }

    if (mode === 'transient_503') {
      transientCount++;
      if (transientCount === 1) {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'x-should-retry': 'false'
        });
        res.end(JSON.stringify({ error: { message: 'Temporary upstream 503 unavailable' } }));
        return;
      }
      sendJsonCompletion(res, { content: 'Succeeded after retry.', model: body.model });
      return;
    }

    if (mode === 'empty_json') {
      sendJsonCompletion(res, { content: '', finishReason: 'stop', model: body.model });
      return;
    }

    if (mode === 'enhance_style') {
      sendJsonCompletion(res, {
        content: '<think>Consider noir tropes.</think>\nUse clipped sentences, rain-slicked sensory imagery, and brooding first-person cadence.',
        finishReason: 'stop',
        model: body.model
      });
    }
  });

  try {
    const config = {
      groqApiKey: 'test-local-key',
      groqBaseUrl: server.baseUrl,
      retryBaseDelayMs: 10,
      paidTier: true,
      cooldownSeconds: 0,
      models: {
        small: 'openai/gpt-oss-20b',
        large: 'openai/gpt-oss-120b'
      }
    };

    const client = new GroqClient(config, tmpDir);

    // 1. Utility reasoning workflow automatically sets reasoning_effort = 'low'
    mode = 'condense';
    const condenseOut = await client.chatCompletion({
      model: 'small',
      messages: [{ role: 'user', content: 'Condense beat 1.' }],
      maxTokens: 512,
      workflow: 'CONDENSE_BEAT'
    });
    assert.ok(condenseOut.includes('Debu launches'));
    assert.equal(server.requests[0].body.reasoning_effort, 'low');

    // 2. Empty response with finish_reason === 'length' auto-retries with boosted max_tokens and reasoning_effort = 'low'
    mode = 'length_then_recover';
    const beforeLenIdx = server.requests.length;
    const recoveredOut = await client.chatCompletion({
      model: 'small',
      messages: [{ role: 'user', content: 'Summarize overview.' }],
      maxTokens: 150,
      workflow: 'INIT_OVERVIEW'
    });
    assert.equal(recoveredOut, 'Recovered full summary after length boost.');
    assert.equal(server.requests.length - beforeLenIdx, 2);
    assert.equal(server.requests[beforeLenIdx].body.max_tokens, 150);
    assert.ok(server.requests[beforeLenIdx + 1].body.max_tokens >= 2048);
    assert.equal(server.requests[beforeLenIdx + 1].body.reasoning_effort, 'low');

    // 3. Transient 503 with x-should-retry: false exercises GroqClient._executeWithRetry
    mode = 'transient_503';
    const retryOut = await client.chatCompletion({
      model: 'small',
      messages: [{ role: 'user', content: 'Ping.' }],
      workflow: 'BIBLE_QUERY'
    });
    assert.equal(retryOut, 'Succeeded after retry.');
    assert.equal(transientCount, 2);

    // 4. Empty jsonCompletion throws explicitly instead of masking failure as {}
    mode = 'empty_json';
    await assert.rejects(
      () =>
        client.jsonCompletion({
          model: 'small',
          messages: [{ role: 'user', content: 'Return continuity JSON.' }],
          workflow: 'CONTINUITY_CRITIC'
        }),
      /Empty JSON response/
    );

    // 5. Real Continuity Critic surfaces honest skipped=true on empty JSON failure
    const criticRes = await runContinuityCritic({
      draftProse: 'Debu steered the wooden skiff past Padmaghat.',
      targetBeat: { num: 1, title: 'Crossing' },
      groqClient: client,
      rerankedBibleChunks: []
    });
    assert.equal(criticRes.skipped, true);
    assert.equal(criticRes.missingCanon, true);
    assert.ok(criticRes.skipReason);

    // 6. Real enhanceWritingStyleWithAi over HTTP strips <think> blocks and requests >= 1024 tokens
    mode = 'enhance_style';
    const enhanced = await enhanceWritingStyleWithAi({
      projectTitle: 'Padmaghat',
      writingStyle: 'rainy detective noir',
      groqApiKey: 'test-local-key',
      model: 'openai/gpt-oss-20b',
      baseUrl: server.baseUrl
    });
    const lastStyleReq = server.requests[server.requests.length - 1].body;
    assert.ok(lastStyleReq.max_tokens >= 1024);
    assert.equal(lastStyleReq.reasoning_effort, 'low');
    assert.equal(enhanced.includes('<think>'), false);
    assert.ok(enhanced.includes('rain-slicked sensory imagery'));
  } finally {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Real Ollama + LanceDB + ONNX CrossEncoder + HTTP GroqClient: Padmaghat canon, progress isolation, writing & watcher', { timeout: 120000 }, async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-v9-e2e-'));
  let vectorStore = null;
  let watcher = null;
  const capturedWorkflows = [];

  // Verify live Ollama server and embeddinggemma are present upfront (non-mocked dependency)
  const embedder = new OllamaEmbedder({
    ollama: { baseUrl: 'http://127.0.0.1:11434', embeddingModel: 'embeddinggemma', embeddingDimensions: 768 }
  });
  const ollamaCheck = await embedder.checkConnection({ autoStart: false });
  if (!ollamaCheck.ok) {
    if (typeof t?.skip === 'function') {
      t.skip(`Skipping real Ollama test (Ollama not running): ${ollamaCheck.error || ''}`);
      await fs.rm(tmpDir, { recursive: true, force: true });
      return;
    }
  }

  const server = await startLocalGroqServer(async (body, _req, res) => {
    const sysMsg = body.messages?.[0]?.content || '';
    const userMsg = body.messages?.[body.messages.length - 1]?.content || '';
    capturedWorkflows.push({
      stream: Boolean(body.stream),
      sysMsg,
      userMsg,
      model: body.model
    });

    if (body.stream) {
      if (sysMsg.includes('friendly novel writing assistant')) {
        sendSseCompletion(res, {
          deltas: ['Hello! ', 'How can I help with Padmaghat today?'],
          model: body.model
        });
        return;
      }

      if (sysMsg.includes('consulting across all project sources')) {
        sendSseCompletion(res, {
          deltas: ['Written so far: ', 'In Chapter 1, Debu launched his skiff at dawn and spoke with Amba.'],
          model: body.model
        });
        return;
      }

      // WRITE_BEAT stream
      sendSseCompletion(res, {
        deltas: [
          'Debu dipped his copper-banded oar into the cold Hooghly current ',
          'while Amba watched from the banyan jetty.'
        ],
        model: body.model
      });
      return;
    }

    if (sysMsg.includes('search query improviser')) {
      if (userMsg.includes('till now')) {
        sendJsonCompletion(res, { content: 'story so far written chapter 1 Debu summary progress', model: body.model });
      } else {
        sendJsonCompletion(res, { content: 'Debu Amba Padmaghat ferry character canon', model: body.model });
      }
      return;
    }

    if (sysMsg.includes('continuity and canon editor')) {
      sendJsonCompletion(res, {
        content: JSON.stringify({ passed: true, severity: 'none', issues: [] }),
        model: body.model
      });
      return;
    }

    if (sysMsg.includes('continuity fiction editor')) {
      sendJsonCompletion(res, {
        content: 'Beat 1 (Morning Ferry): Debu rowed across the misty river while Amba tended the jetty tea stall.',
        model: body.model
      });
      return;
    }

    if (sysMsg.includes('continuity archivist')) {
      sendJsonCompletion(res, {
        content: '- Debu rowed the morning ferry past Amba stall.',
        model: body.model
      });
      return;
    }

    sendJsonCompletion(res, { content: 'Mocked non-empty fallback.', model: body.model });
  });

  let autoAcceptTimer = null;
  try {
    // 1. Setup full novel workspace mimicking the Padmaghat scenario
    await fs.mkdir(path.join(tmpDir, '.quillbot'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'story-bible'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'project', 'chapter-01'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'project', 'chapter-02'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.condensed'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'conversations', 'archive'), { recursive: true });

    const charactersMd = `# Characters
## Protagonist
### **Debu**
Debu is a weathered ferryman at Padmaghat with a bronze amulet and copper-banded wooden oar. He rises before dawn to ferry pilgrims across the misty river.

### **Amba**
Amba runs the clay-oven tea stall beside the ancient banyan shrine at Padmaghat jetty and knows every traveler by voice.`;

    await fs.writeFile(path.join(tmpDir, 'story-bible', 'characters.md'), charactersMd, 'utf8');

    // Verify orphan heading elimination cleanly merges "## Protagonist" into "### **Debu**"
    const charChunks = chunkDocument({ relativePath: 'story-bible/characters.md', content: charactersMd });
    const orphanHeadingChunks = charChunks.filter((c) => c.raw_text.trim() === '## Protagonist');
    assert.equal(orphanHeadingChunks.length, 0, 'Heading-only "## Protagonist" must merge forward instead of forming an orphan chunk');
    assert.ok(charChunks.some((c) => c.text.includes('## Protagonist') && c.text.includes('Debu is a weathered ferryman')));

    await fs.writeFile(
      path.join(tmpDir, 'story-bible', 'locations.md'),
      `# Locations\n## Padmaghat Ferry Crossing\nA mist-draped stone jetty lined with banyan roots, mooring posts, and earthen tea lanterns.`,
      'utf8'
    );

    await fs.writeFile(
      path.join(tmpDir, 'story-bible', 'plot-overview.md'),
      `# Plot Overview\n## Act III Climax (Unwritten Future)\nA massive cyclone shatters Padmaghat during the monsoon betrayal when the harbor magistrate burns the ferry boats.`,
      'utf8'
    );

    await fs.writeFile(
      path.join(tmpDir, 'project', 'chapter-01', 'plan.md'),
      `# Chapter 1: First Mist\n## Beats\n### Beat 1: Dawn Departure\n- **Characters:** Debu, Amba\n- **Location:** Padmaghat Ferry Crossing\n- **Action:** Debu unties the skiff at dawn while Amba hands him spiced chai.\n- **Goal/Hook:** Establish calm daily rhythm before trouble begins.\n- **Instructions:** Keep tone quiet and grounded.`,
      'utf8'
    );

    await fs.writeFile(
      path.join(tmpDir, 'project', 'chapter-01', 'chapter.md'),
      `<!-- BEAT 1 -->\nDebu coiled the wet hemp rope while Amba poured boiling tea from a blackened kettle.\n`,
      'utf8'
    );

    await fs.writeFile(
      path.join(tmpDir, 'project', 'chapter-01', 'summary.md'),
      `Debu untied his wooden skiff in the dawn mist and accepted morning tea from Amba at Padmaghat jetty. Calm weather held all morning with no storm or magistrate betrayal yet.`,
      'utf8'
    );

    await fs.writeFile(
      path.join(tmpDir, '.condensed', 'story-so-far.md'),
      `- Chapter 1: Debu launched his skiff at dawn after speaking with Amba at the jetty tea stall.`,
      'utf8'
    );

    // Chapter 2 plan intentionally mirrors Beat terminology heavily to test scoped Tier 1 retrieval isolation
    await fs.writeFile(
      path.join(tmpDir, 'project', 'chapter-02', 'plan.md'),
      `# Chapter 2: Midstream Current\n## Chapter Summary\nDebu ferries a silent passenger across Padmaghat while mist swallows the banks.\n\n## Beats\n### Beat 1: The Morning Ferry\n- **Characters:** Debu, Amba\n- **Location:** Padmaghat Ferry Crossing\n- **Action:** Debu rows away from Amba's banyan jetty into heavy river fog with the silent passenger.\n- **Goal/Hook:** Build eerie suspense midstream.\n- **Instructions:** Ground in water and wood textures.`,
      'utf8'
    );

    await fs.writeFile(
      path.join(tmpDir, '.quillbot', 'instructions.md'),
      `Write third-person limited past-tense literary fiction.`,
      'utf8'
    );

    const config = {
      groqApiKey: 'test-local-key',
      groqBaseUrl: server.baseUrl,
      retryBaseDelayMs: 10,
      paidTier: true,
      cooldownSeconds: 0,
      projectTitle: 'Padmaghat',
      models: {
        small: 'openai/gpt-oss-20b',
        large: 'openai/gpt-oss-120b'
      },
      rag: {
        chunkSizeTokens: 400,
        chunkOverlapTokens: 60,
        vectorTopK: 15,
        bm25TopK: 15,
        rrfK: 60,
        rerankTopK: 5
      }
    };

    vectorStore = new VectorStore(config, tmpDir);
    await vectorStore.init();
    const reranker = new CrossEncoderReranker(config);
    const groqClient = new GroqClient(config, tmpDir);
    const convMgr = new ConversationManager({ cwd: tmpDir, groqClient, config });
    await convMgr.init();

    // 2. Real syncAllFiles indexing into real LanceDB using real Ollama embeddinggemma vectors
    const syncRes = await syncAllFiles({ cwd: tmpDir, vectorStore, embedder, config });
    assert.equal(syncRes.hasChanges, true);
    assert.ok(syncRes.indexedCount >= 6);

    // 3. Real non-mocked /write flow: scoped Tier 1 Story Bible retrieval still gets Debu/Amba canon
    autoAcceptTimer = setInterval(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 50);

    await runWriteChapterWorkflow({
      chapterArg: '2 1',
      cwd: tmpDir,
      groqClient,
      vectorStore,
      embedder,
      reranker,
      conversationMgr: convMgr,
      config
    });

    clearInterval(autoAcceptTimer);
    autoAcceptTimer = null;

    const writeBeatCall = capturedWorkflows.find((w) => w.stream && w.sysMsg.includes('ONE BEAT at a time'));
    assert.ok(writeBeatCall, 'Real WRITE_BEAT call must execute over HTTP');
    assert.ok(
      writeBeatCall.userMsg.includes('<story_bible_lore>') &&
        (writeBeatCall.userMsg.includes('bronze amulet') || writeBeatCall.userMsg.includes('copper-banded wooden oar')),
      'Scoped Tier 1 retrieval must retrieve Debu Story Bible traits without being crowded out by plan.md'
    );

    const writtenCh2 = await fs.readFile(path.join(tmpDir, 'project', 'chapter-02', 'chapter.md'), 'utf8');
    assert.ok(writtenCh2.includes('Hooghly current'));

    // 4. Real non-mocked general query routing: greeting skips RAG, progress query injects written story-so-far
    const reqCountBeforeHi = capturedWorkflows.length;
    await runGeneralQuery({
      query: 'hi',
      cwd: tmpDir,
      groqClient,
      vectorStore,
      embedder,
      reranker,
      conversationMgr: convMgr,
      config
    });
    assert.equal(
      capturedWorkflows.length - reqCountBeforeHi,
      1,
      'Greeting "hi" must short-circuit directly without invoking IMPROVISE_GENERAL_QUERY'
    );

    const reqCountBeforeProgress = capturedWorkflows.length;
    await runGeneralQuery({
      query: 'what has happened in the story till now?',
      cwd: tmpDir,
      groqClient,
      vectorStore,
      embedder,
      reranker,
      conversationMgr: convMgr,
      config
    });

    const projectQueryCall = capturedWorkflows
      .slice(reqCountBeforeProgress)
      .find((w) => w.stream && w.sysMsg.includes('consulting across all project sources'));
    assert.ok(projectQueryCall, 'General progress query must run real RAG + streaming consultation');
    assert.ok(
      projectQueryCall.sysMsg.includes('Debu launched his skiff at dawn'),
      'Progress query must deterministically inject .condensed/story-so-far.md into <past_chapters>'
    );
    assert.ok(
      projectQueryCall.sysMsg.includes('Written Manuscript Status'),
      'Progress query must include explicit on-disk written chapter inventory'
    );

    // 5. Real chokidar file watcher detects edits to project/chapter-01/summary.md (beyond story-bible/)
    let watcherSynced = false;
    const syncDonePromise = new Promise((resolve) => {
      watcher = startFileWatcher({
        cwd: tmpDir,
        vectorStore,
        embedder,
        config,
        onSync: (res) => {
          watcherSynced = true;
          resolve(res);
        }
      });
    });

    await new Promise((r) => setTimeout(r, 400));
    await fs.writeFile(
      path.join(tmpDir, 'project', 'chapter-01', 'summary.md'),
      `Debu delivered a brass compass to Amba before launching his dawn skiff into calm Padmaghat mist.`,
      'utf8'
    );

    const watcherRes = await Promise.race([
      syncDonePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('File watcher did not sync updated summary.md in time')), 8000))
    ]);
    assert.equal(watcherSynced, true);
    assert.equal(watcherRes.hasChanges, true);

    const brassVec = await embedder.embedQuery('brass compass Amba dawn skiff');
    const foundUpdatedSummary = await vectorStore.hybridSearch({
      queryText: 'brass compass',
      queryVector: brassVec,
      vectorTopK: 10,
      bm25TopK: 10
    });
    assert.ok(
      foundUpdatedSummary.some((c) => c.source_path === 'project/chapter-01/summary.md' && c.text.includes('brass compass')),
      'Updated summary.md must be re-indexed into LanceDB by expanded chokidar watcher'
    );
  } finally {
    if (autoAcceptTimer) clearInterval(autoAcceptTimer);
    if (watcher) await watcher.close();
    if (vectorStore) await vectorStore.close();
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});

test('Real REPL mid-sentence slash input does not trigger slash menu & /bible save prevents path traversal', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quillbot-v9-repl-safe-'));
  let autoAcceptTimer = null;

  const server = await startLocalGroqServer(async (body, _req, res) => {
    sendJsonCompletion(res, {
      content: JSON.stringify({
        targetFile: '../../.quillbot/config.json',
        sectionTitle: 'River Tax Rule',
        markdownContent: 'Every ferryman pays three copper coins at the northern pier.',
        rationale: 'Canon river toll rule established during brainstorming.'
      }),
      model: body.model
    });
  });

  try {
    // 1. Mid-sentence '/' ("and/or") must submit normally as chat text, while leading '/' triggers slash menu
    setTimeout(() => {
      for (const ch of 'and/or') {
        process.stdin.emit('keypress', ch, { sequence: ch, name: ch === '/' ? 'slash' : ch });
      }
      process.stdin.emit('keypress', '\r', { name: 'return' });
    }, 30);
    const midSlashRes = await replInputPrompt({});
    assert.equal(midSlashRes.isSlashMenu, undefined);
    assert.equal(midSlashRes.input, 'and/or');

    setTimeout(() => {
      process.stdin.emit('keypress', '/', { sequence: '/', name: 'slash' });
    }, 30);
    const leadingSlashRes = await replInputPrompt({});
    assert.equal(leadingSlashRes.isSlashMenu, true);

    // 2. /bible save must confine targetFile inside story-bible/ even if model proposes ../../.quillbot/config.json
    await fs.mkdir(path.join(tmpDir, '.quillbot'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'story-bible'), { recursive: true });
    const originalConfigJson = JSON.stringify({ groqApiKey: 'preserve-me' }, null, 2);
    await fs.writeFile(path.join(tmpDir, '.quillbot', 'config.json'), originalConfigJson, 'utf8');
    await fs.writeFile(path.join(tmpDir, 'story-bible', 'world-and-lore.md'), '# World & Lore\nExisting lore.', 'utf8');

    const config = {
      groqApiKey: 'test-local-key',
      groqBaseUrl: server.baseUrl,
      retryBaseDelayMs: 10,
      paidTier: true,
      cooldownSeconds: 0,
      models: { small: 'openai/gpt-oss-20b', large: 'openai/gpt-oss-120b' }
    };
    const groqClient = new GroqClient(config, tmpDir);
    const embedder = new OllamaEmbedder(config);
    const vectorStore = new VectorStore(config, tmpDir);
    await vectorStore.init();

    const convMgr = new ConversationManager({ cwd: tmpDir, groqClient, config });
    await convMgr.init();
    await convMgr.addTurn('user', 'Let us set the Padmaghat river tax at three copper coins.');

    autoAcceptTimer = setInterval(() => {
      process.stdin.emit('keypress', 'a', { sequence: 'a', name: 'a' });
    }, 50);

    try {
      await handleBibleSave({
        cwd: tmpDir,
        groqClient,
        vectorStore,
        embedder,
        conversationMgr: convMgr,
        config
      });
    } finally {
      clearInterval(autoAcceptTimer);
      autoAcceptTimer = null;
      await vectorStore.close();
    }

    const configAfter = await fs.readFile(path.join(tmpDir, '.quillbot', 'config.json'), 'utf8');
    assert.equal(configAfter, originalConfigJson, 'Path traversal target outside story-bible/ must NEVER be modified');

    const loreAfter = await fs.readFile(path.join(tmpDir, 'story-bible', 'world-and-lore.md'), 'utf8');
    assert.ok(loreAfter.includes('### River Tax Rule'));
    assert.ok(loreAfter.includes('three copper coins'));
  } finally {
    if (autoAcceptTimer) clearInterval(autoAcceptTimer);
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});
