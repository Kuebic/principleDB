// Normalize + alnumize, with a per-output-char origin map.
//
// Why a map at all? ADR-0007 says Quotes are relocated *Source* spans, never the AI's
// reproduction. The matcher needs to ignore typographic noise (curly quotes, ligatures,
// hyphen-wraps, whitespace) but the snapped span must point at the SOURCE'S own bytes —
// so `source.slice(span.start, span.end)` yields the source's own words at the snapped
// spot, ligatures and all.
//
// Each output char carries `sourceStart` and `sourceEnd`. Match at output range [a, b)
// snaps back to (originMap[a].sourceStart, originMap[b - 1].sourceEnd). Two output chars
// from a single source char (a ligature expansion) both point at that one source range,
// so matching either still pulls in the whole ligature.

export interface OriginEntry {
  sourceStart: number;
  sourceEnd: number;
}

export interface NormalizedText {
  text: string;
  originMap: OriginEntry[];
}

const CURLY_SINGLE = /[‘’‚‛ʼ′]/;
const CURLY_DOUBLE = /[“”„‟″]/;
const DASHES = /[–—―]/;
const WORDISH = /[A-Za-z0-9]/;

export function normalize(source: string): NormalizedText {
  const outChars: string[] = [];
  const originMap: OriginEntry[] = [];

  const push = (ch: string, start: number, end: number): void => {
    outChars.push(ch);
    originMap.push({ sourceStart: start, sourceEnd: end });
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i]!;

    // Hyphen-wrap: word-char then (- or soft-hyphen) then ws*\nws* then word-char →
    // join (drop the hyphen + newline + surrounding whitespace).
    if ((c === '-' || c === '­') && outChars.length > 0) {
      const prev = outChars[outChars.length - 1]!;
      if (WORDISH.test(prev)) {
        let k = i + 1;
        while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k++;
        if (k < source.length && source[k] === '\n') {
          k++;
          while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k++;
          if (k < source.length && WORDISH.test(source[k]!)) {
            i = k;
            continue;
          }
        }
      }
    }

    // Whitespace run → single space; origin spans the whole run.
    if (/\s/.test(c)) {
      const start = i;
      while (i < source.length && /\s/.test(source[i]!)) i++;
      push(' ', start, i);
      continue;
    }

    if (CURLY_SINGLE.test(c)) {
      push("'", i, i + 1);
      i++;
      continue;
    }

    if (CURLY_DOUBLE.test(c)) {
      push('"', i, i + 1);
      i++;
      continue;
    }

    if (DASHES.test(c)) {
      push('-', i, i + 1);
      i++;
      continue;
    }

    if (c === '…') {
      // Ellipsis → three dots, all pointing at the single source char.
      push('.', i, i + 1);
      push('.', i, i + 1);
      push('.', i, i + 1);
      i++;
      continue;
    }

    if (c === 'ﬁ') {
      // fi ligature → 'f' + 'i', both origins point at the one ligature char.
      push('f', i, i + 1);
      push('i', i, i + 1);
      i++;
      continue;
    }

    if (c === 'ﬂ') {
      push('f', i, i + 1);
      push('l', i, i + 1);
      i++;
      continue;
    }

    push(c.toLowerCase(), i, i + 1);
    i++;
  }

  return { text: outChars.join(''), originMap };
}

// Alnum tier — letters/digits/space only, non-alnum becomes a single space whose origin
// span extends across the consumed run. Built ON TOP OF normalize(), so origin maps
// remain in original-source coordinates. Leading/trailing spaces are trimmed.
export function alnumize(n: NormalizedText): NormalizedText {
  const outChars: string[] = [];
  const originMap: OriginEntry[] = [];
  let inSpace = true; // Suppress leading non-alnum

  for (let i = 0; i < n.text.length; i++) {
    const c = n.text[i]!;
    const o = n.originMap[i]!;
    if (/[a-z0-9]/.test(c)) {
      outChars.push(c);
      originMap.push(o);
      inSpace = false;
      continue;
    }
    if (!inSpace && outChars.length > 0) {
      outChars.push(' ');
      originMap.push(o);
      inSpace = true;
      continue;
    }
    if (inSpace && outChars.length > 0) {
      // Extend prior space's origin to cover this swallowed non-alnum char.
      const last = originMap[originMap.length - 1]!;
      originMap[originMap.length - 1] = {
        sourceStart: last.sourceStart,
        sourceEnd: o.sourceEnd,
      };
    }
  }

  while (outChars.length > 0 && outChars[outChars.length - 1] === ' ') {
    outChars.pop();
    originMap.pop();
  }

  return { text: outChars.join(''), originMap };
}
