/* Pure Markdown segmentation. Every source block is retained in order. */
export const LIMITS = { fine: 420, balanced: 850, relaxed: 1600 };

export function plainText(value) {
  return value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' 代码示例 ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/[#*_~`>|]/g, '').replace(/\s+/g, ' ').trim();
}

export function wordCount(value) {
  const plain = plainText(value);
  return (plain.match(/[\u3400-\u9fff]/g) || []).length +
    (plain.replace(/[\u3400-\u9fff]/g, ' ').match(/[\p{L}\p{N}]+/gu) || []).length;
}

export function parseBlocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let current = [], fence = null, fenceLength = 0;
  const flush = () => {
    if (current.some(line => line.trim())) blocks.push(current.join('\n').trim());
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      current.push(line);
      if (new RegExp('^ {0,3}' + fence + '{' + fenceLength + ',}\\s*$').test(line)) {
        fence = null; flush();
      }
      continue;
    }
    if (marker) {
      flush(); fence = marker[1][0]; fenceLength = marker[1].length; current.push(line); continue;
    }
    if (!line.trim()) { flush(); continue; }
    // Headings are atomic so even Markdown without blank lines can be segmented.
    if (/^ {0,3}#{1,6}\s+/.test(line)) { flush(); blocks.push(line.trim()); continue; }
    // Normalize setext headings before splitting; skip table separator syntax.
    if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) && line.trim()) {
      flush(); blocks.push((lines[i + 1].trim()[0] === '=' ? '# ' : '## ') + line.trim()); i++; continue;
    }
    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      flush(); blocks.push(line.trim()); continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

export function headingOf(block) {
  const match = block.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  return match ? { level: match[1].length, title: plainText(match[2]) || '未命名章节' } : null;
}

// Conservative, local recognition of common comparison labels. Source text is
// never rewritten, and a diagram is created only when both sides are present.
const COMPARISON_PAIRS = [
  [/^逐条.{0,14}$/, /^批量.{0,14}$/],
  [/^单(?:个|次|独).{0,14}$/, /^批量.{0,14}$/],
  [/^串行.{0,14}$/, /^并行.{0,14}$/],
  [/^优化前.{0,14}$/, /^优化后.{0,14}$/],
  [/^改进前.{0,14}$/, /^改进后.{0,14}$/],
  [/^(?:方案|方式|方法)\s*[一1Aa][：:].{0,14}$/, /^(?:方案|方式|方法)\s*[二2Bb][：:].{0,14}$/],
  [/^(?:方案|方式|方法)\s*[一1Aa]$/, /^(?:方案|方式|方法)\s*[二2Bb]$/],
  [/^before$/i, /^after$/i],
];

function comparisonLabel(block) {
  if (block.includes('\n')) return null;
  if (!headingOf(block) && !/^(?:\*\*[^\n]+\*\*|__[^\n]+__)\s*$/.test(block)) return null;
  const title = plainText(block);
  for (let pair = 0; pair < COMPARISON_PAIRS.length; pair++) {
    const side = COMPARISON_PAIRS[pair].findIndex(re => re.test(title));
    if (side !== -1) return { title, pair, side };
  }
  return null;
}

function metricText(block) {
  if (block.includes('\n') || /[`<>\[\]]/.test(block)) return null;
  const text = plainText(block);
  return /^(?:约|最多|至少|仅|只需)?\s*\d+(?:\.\d+)?\s*(?:次|个|步|ms|毫秒|秒|分钟|小时|天|%|MB|GB|KB)$/i.test(text) ? text : null;
}

export function findComparisonRanges(blocks) {
  const ranges = [];
  for (let i = 0; i < blocks.length; i++) {
    const left = comparisonLabel(blocks[i]);
    if (!left) continue;
    for (let j = i + 1; j < blocks.length && j <= i + 100; j++) {
      const right = comparisonLabel(blocks[j]);
      if (right && left.pair === right.pair && left.side !== right.side) {
        let end = j + 1;
        while (end < blocks.length && !comparisonLabel(blocks[end]) && !(headingOf(blocks[end]) && !metricText(blocks[end]))) end++;
        if (j > i + 1 && end > j + 1) {
          ranges.push({ start: i, middle: j, end, title: `${left.title} / ${right.title}`, labels: [left.title, right.title] });
          i = end - 1;
        }
        break;
      }
      // Do not search through unrelated sections, code fences, or other pairs.
      if (right || (headingOf(blocks[j]) && !metricText(blocks[j]))) break;
    }
  }
  return ranges;
}

export function comparisonModel(markdown) {
  const blocks = parseBlocks(markdown);
  const range = findComparisonRanges(blocks)[0];
  if (!range || (range.start !== 0 && !blocks.slice(0, range.start).every(headingOf)) || range.end !== blocks.length) return null;
  const rightBlocks = blocks.slice(range.middle + 1, range.end);
  let note = '';
  if (rightBlocks.length > 1 && /^(?:(?:注意|说明|注)[：:]|实际[\s\S]*(?:取决于|比较的是|不代表))/.test(plainText(rightBlocks.at(-1)))) note = rightBlocks.pop();
  const segments = body => {
    const pieces = [];
    let prose = [], numbers = [];
    const flushProse = () => { if (prose.length) pieces.push({ type: 'markdown', value: prose.join('\n\n') }); prose = []; };
    const flushNumbers = () => {
      if (numbers.length >= 2) { flushProse(); pieces.push({ type: 'sequence', values: numbers }); }
      else if (numbers.length) prose.push(...numbers);
      numbers = [];
    };
    for (const block of body) {
      if (/^\d+(?:\n\d+)*$/.test(block)) { numbers.push(...block.split('\n')); continue; }
      flushNumbers();
      const metric = metricText(block);
      if (metric) { flushProse(); pieces.push({ type: 'metric', value: metric }); }
      else prose.push(block);
    }
    flushNumbers(); flushProse(); return pieces;
  };
  return { title: range.title, sides: [
    { title: range.labels[0], segments: segments(blocks.slice(range.start + 1, range.middle)) },
    { title: range.labels[1], segments: segments(rightBlocks) },
  ], note };
}

function safeSplitText(block, limit) {
  // Keep code fences, tables, lists, blockquotes and HTML intact.
  if (/^(?: {0,3}(?:`{3,}|~{3,}|>|[-*+]\s|\d+[.)]\s)|\s*<)/.test(block) || /[|\n`\[\]*_<>]/.test(block)) return [block];
  if (block.length <= limit) return [block];
  // Only break at sentence boundaries; never cut Markdown inline syntax in half.
  const sentences = block.split(/(?<=[。！？!?])(?=\s*\S)/u);
  let part = '', parts = [];
  for (const sentence of sentences) {
    if (part && part.length + sentence.length > limit) { parts.push(part); part = ''; }
    part += sentence;
  }
  if (part) parts.push(part);
  return parts;
}

export function segmentMarkdown(source, { mode = 'smart', size = 'balanced' } = {}) {
  let blocks = parseBlocks(source);
  if (!blocks.length) return { title: '未命名内容', cards: [], sections: [], words: 0 };
  const comparisonTitles = new Map();
  if (mode === 'smart') {
    const ranges = findComparisonRanges(blocks);
    // Treat an entire comparison as one atomic reading unit, even if a large
    // count was written as a Markdown heading or the fine size was selected.
    for (const range of [...ranges].reverse()) {
      const merged = blocks.slice(range.start, range.end).join('\n\n');
      comparisonTitles.set(merged, range.title);
      blocks.splice(range.start, range.end - range.start, merged);
    }
  }
  const firstHeading = blocks.map(headingOf).find(Boolean);
  const headings = blocks.map(headingOf).filter(Boolean);
  // A lone H1 usually names the document; its H2/H3 sections become the steps.
  const uniqueH1 = headings.filter(h => h.level === 1).length === 1;
  const splitLevel = uniqueH1 && headings.some(h => h.level > 1) ? Math.min(...headings.filter(h => h.level > 1).map(h => h.level)) : firstHeading?.level;
  const title = firstHeading?.title || comparisonTitles.get(blocks[0]) || plainText(blocks[0]).slice(0, 32) || '未命名内容';
  const limit = LIMITS[size] || LIMITS.balanced;
  const groups = [];
  let current = { title: '开始阅读', blocks: [] };
  const flush = () => {
    if (current.blocks.length) groups.push(current);
    current = { title: current.title, blocks: [] };
  };
  for (const block of blocks) {
    if (comparisonTitles.has(block)) {
      flush(); current.title = comparisonTitles.get(block); current.blocks.push(block); flush();
      current.title = '继续阅读'; continue;
    }
    const heading = headingOf(block);
    const separator = /^(?:-{3,}|\*{3,}|_{3,})$/.test(block);
    if (heading && mode !== 'paragraph' && heading.level <= splitLevel) {
      flush(); current.title = heading.title;
    } else if (separator && mode !== 'heading') {
      flush(); current.title = '继续阅读';
    }
    current.blocks.push(block);
    if (mode === 'paragraph' && !heading && !separator) flush();
  }
  flush();
  // Fold a short document title/introduction into the first meaningful section.
  if (uniqueH1 && groups.length > 1 && groups[0].blocks.length === 1 && headingOf(groups[0].blocks[0])?.level === 1) {
    groups[1].blocks.unshift(...groups.shift().blocks);
  }
  const cards = [], sections = [];
  for (const [groupIndex, group] of groups.entries()) {
    const section = { id: `section-${groupIndex}`, title: group.title, cardIds: [] };
    const chunks = [];
    let chunk = [], length = 0;
    for (const block of group.blocks) {
      const pieces = mode === 'heading' ? [block] : safeSplitText(block, limit);
      for (const piece of pieces) {
        if (mode !== 'heading' && chunk.length && length + piece.length > limit && chunk.some(b => !headingOf(b))) {
          chunks.push(chunk); chunk = []; length = 0;
        }
        chunk.push(piece); length += piece.length;
      }
    }
    if (chunk.length) chunks.push(chunk);
    chunks.forEach((parts, index) => {
      const markdown = parts.join('\n\n');
      const firstBody = parts.find(p => !headingOf(p) && !/^[-*_]{3,}$/.test(p));
      let cardTitle = group.title;
      if (mode === 'paragraph' || cardTitle === '开始阅读' || cardTitle === '继续阅读') {
        cardTitle = parts.map(headingOf).find(Boolean)?.title || plainText(firstBody || markdown).slice(0, 24) || '继续阅读';
      }
      if (chunks.length > 1) cardTitle += ` · ${index + 1}`;
      if (!section.cardIds.length && ['开始阅读', '继续阅读'].includes(section.title)) section.title = cardTitle.replace(/ · 1$/, '');
      section.cardIds.push(cards.length);
      cards.push({ id: cards.length, title: cardTitle, sectionId: section.id, sectionTitle: section.title, part: index + 1, parts: chunks.length, markdown, summary: plainText(firstBody || markdown).slice(0, 56), words: wordCount(markdown) });
    });
    sections.push(section);
  }
  return { title, cards, sections, words: wordCount(source) };
}
