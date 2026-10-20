import path from 'node:path';

const CHARS_PER_TOKEN = 4;

export function determineSourceMetadata(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');

  if (normalized.startsWith('story-bible/')) {
    return {
      source_type: 'story-bible',
      authority_tier: 1,
      chapter_num: 0
    };
  }

  if (normalized.startsWith('project/')) {
    const match = normalized.match(/chapter-(\d+)/i);
    const chapterNum = match ? parseInt(match[1], 10) : 0;
    const isSummary = normalized.endsWith('summary.md');
    return {
      source_type: isSummary ? 'chapter-summary' : 'chapter',
      authority_tier: 2,
      chapter_num: chapterNum
    };
  }

  if (normalized.startsWith('conversations/')) {
    return {
      source_type: 'conversation',
      authority_tier: 3,
      chapter_num: 0
    };
  }

  return {
    source_type: 'note',
    authority_tier: 3,
    chapter_num: 0
  };
}

export function chunkDocument({
  relativePath,
  content,
  chunkSizeTokens = 400,
  chunkOverlapTokens = 60
}) {
  if (!content || !content.trim()) {
    return [];
  }

  const { source_type, authority_tier, chapter_num } = determineSourceMetadata(relativePath);
  const maxChunkChars = chunkSizeTokens * CHARS_PER_TOKEN;
  const overlapChars = chunkOverlapTokens * CHARS_PER_TOKEN;

  // Split by markdown headings: #, ##, ###, ####
  const lines = content.split(/\r?\n/);
  const sections = [];
  let currentTitle = path.basename(relativePath, path.extname(relativePath));
  let currentBuffer = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      if (currentBuffer.length > 0) {
        sections.push({
          title: currentTitle,
          text: currentBuffer.join('\n').trim()
        });
        currentBuffer = [];
      }
      currentTitle = headingMatch[2].trim();
      currentBuffer.push(line);
    } else {
      currentBuffer.push(line);
    }
  }

  if (currentBuffer.length > 0) {
    sections.push({
      title: currentTitle,
      text: currentBuffer.join('\n').trim()
    });
  }

  const rawChunks = [];

  for (const section of sections) {
    if (!section.text) continue;

    if (section.text.length <= maxChunkChars) {
      rawChunks.push({
        title: section.title,
        text: section.text
      });
    } else {
      // Split by double newline (paragraphs)
      const paragraphs = section.text.split(/\n\s*\n/);
      let paragraphChunk = '';

      for (const para of paragraphs) {
        const trimmedPara = para.trim();
        if (!trimmedPara) continue;

        if ((paragraphChunk + '\n\n' + trimmedPara).length <= maxChunkChars) {
          paragraphChunk = paragraphChunk ? `${paragraphChunk}\n\n${trimmedPara}` : trimmedPara;
        } else {
          if (paragraphChunk) {
            rawChunks.push({
              title: section.title,
              text: paragraphChunk
            });
            // Overlap: retain tail of paragraphChunk
            const tail = paragraphChunk.slice(-overlapChars);
            paragraphChunk = `${tail}\n\n${trimmedPara}`;
          } else {
            // A single giant paragraph exceeds maxChunkChars, hard slice
            let start = 0;
            while (start < trimmedPara.length) {
              const slice = trimmedPara.slice(start, start + maxChunkChars);
              rawChunks.push({
                title: section.title,
                text: slice
              });
              start += maxChunkChars - overlapChars;
            }
            paragraphChunk = '';
          }
        }
      }

      if (paragraphChunk && paragraphChunk.trim()) {
        rawChunks.push({
          title: section.title,
          text: paragraphChunk.trim()
        });
      }
    }
  }

  // Inject Context Header
  const normalizedPath = relativePath.replace(/\\/g, '/');
  return rawChunks.map((chunk, idx) => {
    const contextHeader = `[File: ${normalizedPath} | Section: ${chunk.title} | Type: ${source_type} | Tier: ${authority_tier}]`;
    const fullText = `${contextHeader}\n${chunk.text}`;

    return {
      id: `${normalizedPath}#chunk_${idx}`,
      source_path: normalizedPath,
      source_type,
      authority_tier,
      chapter_num,
      section_title: chunk.title,
      raw_text: chunk.text,
      text: fullText
    };
  });
}
