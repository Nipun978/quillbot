import path from 'node:path';

/**
 * Accurately estimates token count based on subwords, punctuation, whitespace, and Unicode.
 * Standard BPE tokenizers split on whitespace, punctuation, contractions, numbers, and multi-byte Unicode.
 */
export function estimateTokenCount(text = '') {
  if (!text) return 0;
  const tokens = text.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?|[^\s\p{L}\p{N}]+|\s+/gu);
  if (!tokens) return 0;

  let count = 0;
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      count += Math.floor(token.length / 4);
    } else if (token.length > 8) {
      count += Math.ceil(token.length / 4);
    } else {
      count += 1;
    }
  }
  return Math.max(1, count);
}

export function determineSourceMetadata(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');

  if (normalized.startsWith('story-bible/')) {
    if (normalized.startsWith('story-bible/references/')) {
      return {
        source_type: 'story-bible-reference',
        authority_tier: 1,
        chapter_num: 0
      };
    }
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

  if (normalized.startsWith('.condensed/')) {
    const match = normalized.match(/chapter-(\d+)/i);
    const chapterNum = match ? parseInt(match[1], 10) : 0;
    let sourceType = 'condensed';
    if (normalized.endsWith('story-so-far.md')) {
      sourceType = 'condensed-story-so-far';
    } else if (normalized.endsWith('plan.md')) {
      sourceType = 'condensed-plan';
    } else if (normalized.endsWith('prose.md')) {
      sourceType = 'condensed-prose';
    }
    return {
      source_type: sourceType,
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

  // Split by markdown headings: #, ##, ###, ####
  const lines = content.split(/\r?\n/);
  const sections = [];
  let currentTitle = path.basename(relativePath, path.extname(relativePath));
  let currentBuffer = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      if (currentBuffer.length > 0) {
        const cleanSectionText = currentBuffer.join('\n').replace(/^\s*---\s*$/gm, '').trim();
        if (cleanSectionText) {
          sections.push({
            title: currentTitle,
            text: cleanSectionText
          });
        }
        currentBuffer = [];
      }
      currentTitle = headingMatch[2].trim();
      currentBuffer.push(line);
    } else {
      currentBuffer.push(line);
    }
  }

  if (currentBuffer.length > 0) {
    const cleanSectionText = currentBuffer.join('\n').replace(/^\s*---\s*$/gm, '').trim();
    if (cleanSectionText) {
      sections.push({
        title: currentTitle,
        text: cleanSectionText
      });
    }
  }

  // Merge heading-only sections (e.g., "## Protagonist" immediately followed by "### **Debu**")
  // forward into the following content section so parent headings never become 2-token orphan chunks.
  const mergedSections = [];
  let pendingHeadingPrefix = [];
  for (const section of sections) {
    if (!section.text) continue;
    const isHeadingOnly = /^(?:#{1,6}\s+[^\n]+(?:\n+|$))+$/.test(section.text.trim());
    if (isHeadingOnly) {
      pendingHeadingPrefix.push(section.text.trim());
    } else if (pendingHeadingPrefix.length > 0) {
      mergedSections.push({
        title: section.title,
        text: `${pendingHeadingPrefix.join('\n')}\n${section.text}`
      });
      pendingHeadingPrefix = [];
    } else {
      mergedSections.push(section);
    }
  }
  if (pendingHeadingPrefix.length > 0) {
    if (mergedSections.length > 0) {
      const last = mergedSections[mergedSections.length - 1];
      last.text = `${last.text}\n\n${pendingHeadingPrefix.join('\n')}`;
    } else {
      mergedSections.push({
        title: currentTitle,
        text: pendingHeadingPrefix.join('\n')
      });
    }
  }

  const rawChunks = [];

  for (const section of mergedSections) {
    if (!section.text) continue;

    if (estimateTokenCount(section.text) <= chunkSizeTokens) {
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

        const candidate = paragraphChunk ? `${paragraphChunk}\n\n${trimmedPara}` : trimmedPara;
        if (estimateTokenCount(candidate) <= chunkSizeTokens) {
          paragraphChunk = candidate;
        } else {
          if (paragraphChunk) {
            const isOnlyHeading = /^(?:#{1,6}\s+[^\n]+(?:\n+|$))+$/.test(paragraphChunk.trim());
            if (isOnlyHeading || estimateTokenCount(paragraphChunk) < 20) {
              // Don't orphan short headings or tiny intros into a 2-word standalone chunk
              paragraphChunk = `${paragraphChunk}\n\n${trimmedPara}`;
            } else {
              rawChunks.push({
                title: section.title,
                text: paragraphChunk
              });

              // Calculate overlap from tail sentences to preserve sentence integrity
              const sentences = paragraphChunk.split(/(?<=[.!?])\s+/);
              let overlapText = '';
              for (let i = sentences.length - 1; i >= 0; i--) {
                const candOverlap = sentences.slice(i).join(' ');
                if (estimateTokenCount(candOverlap) <= chunkOverlapTokens) {
                  overlapText = candOverlap;
                } else {
                  break;
                }
              }
              paragraphChunk = overlapText ? `${overlapText}\n\n${trimmedPara}` : trimmedPara;
            }
          }

          // If single paragraph (or paragraph with overlap) exceeds chunkSizeTokens, split by sentences
          if (estimateTokenCount(paragraphChunk) > chunkSizeTokens) {
            const sentences = paragraphChunk.split(/(?<=[.!?])\s+/);
            let sentenceChunk = '';

            for (const sentence of sentences) {
              const trimmedSentence = sentence.trim();
              if (!trimmedSentence) continue;

              const sentCandidate = sentenceChunk ? `${sentenceChunk} ${trimmedSentence}` : trimmedSentence;
              if (estimateTokenCount(sentCandidate) <= chunkSizeTokens) {
                sentenceChunk = sentCandidate;
              } else {
                if (sentenceChunk) {
                  rawChunks.push({
                    title: section.title,
                    text: sentenceChunk
                  });
                  sentenceChunk = trimmedSentence;
                } else {
                  // A single sentence exceeds chunkSizeTokens, split by words cleanly
                  const words = trimmedSentence.split(/\s+/);
                  let wordChunk = [];
                  for (const word of words) {
                    wordChunk.push(word);
                    if (estimateTokenCount(wordChunk.join(' ')) >= chunkSizeTokens) {
                      rawChunks.push({
                        title: section.title,
                        text: wordChunk.join(' ')
                      });
                      wordChunk = [];
                    }
                  }
                  if (wordChunk.length > 0) {
                    sentenceChunk = wordChunk.join(' ');
                  }
                }
              }
            }
            paragraphChunk = sentenceChunk;
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
