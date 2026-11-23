// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Section 5: the three matching tiers ---

/** One line of a hunk's or chunk's body: context, old or new. */
interface BItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  oi: number; // its index in O
  ni: number; // its index in N
  bs: boolean; // a `\` line follows it in the body
}

const rtrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

const EQS: ((a: string, b: string) => boolean)[] = [
  (a, b) => a === b,
  (a, b) => rtrail(a) === rtrail(b),
  (a, b) => stripBoth(a) === stripBoth(b),
];

/** Where O occurs in F at tier t; occurrences may overlap. */
function occursAt(F: string[], O: string[], t: number): number[] {
  const eq = EQS[t]!;
  const out: number[] = [];
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length && ok; j++) if (!eq(F[i + j]!, O[j]!)) ok = false;
    if (ok) out.push(i);
  }
  return out;
}

/** The first of the three tiers (section 5) at which O occurs in F, or null. */
function findTier(F: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const pos = occursAt(F, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** A file's lines, its line break and whether it ends with one (section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

const joinFile = (lines: string[], br: string, final: boolean): string =>
  lines.length === 0 ? '' : lines.join(br) + (final ? br : '');

/** The lines written for a matched hunk or chunk (section 5). */
function replacement(items: BItem[], F: string[], p: number, tier: number, O: string[]): string[] {
  const out: string[] = [];
  const f = leadWs(F[p]!);
  const pr = leadWs(O[0]!);
  for (const it of items) {
    if (it.kind === 'ctx') out.push(F[p + it.oi]!);
    else if (it.kind === 'add') {
      if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(pr)) out.push(f + it.text.slice(pr.length));
      else out.push(it.text);
    }
  }
  return out;
}

/** The lines a SEARCH/REPLACE block writes (section 5: no context lines). */
function srLines(N: string[], F: string[], p: number, tier: number, O: string[]): string[] {
  if (tier < 2) return N.slice();
  const f = leadWs(F[p]!);
  const pr = leadWs(O[0]!);
  return N.map((t) => (t !== '' && t.trim() !== '' && t.startsWith(pr) ? f + t.slice(pr.length) : t));
}

// --- Section 6: unified diffs ---

interface UHunk {
  a: number;
  items: BItem[];
  bsLastCP: boolean; // a `\` line follows the hunk's last context or `+` line
}
interface USection {
  oldHdr: string | null | undefined; // from a `--- ` line; null: /dev/null
  newHdr: string | null | undefined; // from a `+++ ` line
  oldRename: string | undefined;
  newRename: string | undefined;
  oldGit: string | undefined;
  newGit: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function hdrPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[]): USection[] {
  const secs: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice(11);
      const sep = rest.lastIndexOf(' b/');
      if (!rest.startsWith('a/') || sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldHdr: undefined, newHdr: undefined, oldRename: undefined, newRename: undefined, oldGit: rest.slice(2, sep), newGit: rest.slice(sep + 3), newFile: false, delFile: false, hunks: [] };
      secs.push(cur);
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        cur = { oldHdr: undefined, newHdr: undefined, oldRename: undefined, newRename: undefined, oldGit: undefined, newGit: undefined, newFile: false, delFile: false, hunks: [] };
        secs.push(cur);
      }
      cur.oldHdr = hdrPath(line);
      cur.newHdr = hdrPath(lines[i + 1]!);
      i += 2;
    } else if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    } else if (line.startsWith('@@')) {
      const m = HUNK.exec(line);
      if (cur === null || m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USection = cur;
      const raw: string[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          raw.push(b);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const items: BItem[] = [];
      let oi = 0;
      let ni = 0;
      for (const b of raw) {
        if (b[0] === '\\') {
          if (items.length > 0) items[items.length - 1]!.bs = true;
          continue;
        }
        const kind: 'ctx' | 'del' | 'add' = b === '' || b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'del' : 'add';
        const it: BItem = { kind, text: b === '' ? '' : b.slice(1), oi: 0, ni: 0, bs: false };
        if (kind === 'ctx') {
          it.oi = oi;
          it.ni = ni;
          oi += 1;
          ni += 1;
        } else if (kind === 'del') it.oi = oi++;
        else it.ni = ni++;
        items.push(it);
      }
      let bsLastCP = false;
      for (const it of items) if (it.kind === 'ctx' || it.kind === 'add') bsLastCP = it.bs;
      sec.hunks.push({ a: Number(m[1]), items, bsLastCP });
      i = j;
    } else {
      if (cur !== null && cur.hunks.length === 0) {
        if (line.startsWith('rename from ')) cur.oldRename = line.slice(12).trim();
        else if (line.startsWith('rename to ')) cur.newRename = line.slice(10).trim();
        else if (line.startsWith('new file mode')) cur.newFile = true;
        else if (line.startsWith('deleted file mode')) cur.delFile = true;
      }
      i += 1;
    }
  }
  return secs;
}

/** Apply a section's hunks in order to a file's text (section 6). */
function applyHunks(src: string, sec: USection, strict: boolean, path: string): string {
  const split = splitFile(src);
  const lines = split.lines.slice();
  let final = split.final;
  let d = 0;
  for (const h of sec.hunks) {
    const O = h.items.filter((x) => x.kind !== 'add').map((x) => x.text);
    const N = h.items.filter((x) => x.kind !== 'del').map((x) => x.text);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...N);
      if (atEnd) final = !h.bsLastCP;
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const rep = replacement(h.items, lines, best, found.tier, O);
      const toEnd = best + O.length === lines.length;
      lines.splice(best, O.length, ...rep);
      if (toEnd) final = !h.bsLastCP;
      d += N.length - O.length;
    }
  }
  return joinFile(lines, split.br, final);
}

function unifiedEdits(secs: USection[], strict: boolean): Edit[] {
  return secs.map((sec) => (tree) => {
    const old = sec.oldHdr !== undefined ? sec.oldHdr : sec.oldRename !== undefined ? sec.oldRename : sec.oldGit;
    const nw = sec.newHdr !== undefined ? sec.newHdr : sec.newRename !== undefined ? sec.newRename : sec.newGit;
    const isCreate = sec.oldHdr === null || sec.newFile;
    const isDelete = !isCreate && (sec.newHdr === null || sec.delFile);
    if (isCreate) {
      const p = nw === null || nw === undefined ? '/dev/null' : nw;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let bs = false;
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') { plus.push(it.text); bs = it.bs; }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (bs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = old === null || old === undefined ? '/dev/null' : old;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = old ?? '';
    const q = nw ?? '';
    const isMove = p !== q;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isMove && !safe(q)) throw new Fail('unsafe', q);
    const src = tree.get(p);
    if (src === null) throw new Fail('missing', p);
    if (isMove && tree.get(q) !== null) throw new Fail('exists', q);
    const text = applyHunks(src, sec, strict, p);
    if (isMove) {
      tree.now.set(q, text);
      tree.now.set(p, null);
      tree.moves.push({ old: p, new: q });
    } else tree.now.set(p, text);
  });
}

// --- Section 7: SEARCH/REPLACE blocks ---

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prev = -1; // the previous block's `>>>>>>> REPLACE` line
  let lastPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let j = -1;
    for (let k = i + 1; k < lines.length; k++) if (lines[k]!.trimEnd() === '=======') { j = k; break; }
    if (j < 0) throw new Exit2(`error: parse ${i + 1}`);
    let e = -1;
    for (let k = j + 1; k < lines.length; k++) if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { e = k; break; }
    if (e < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | undefined;
    for (let k = i - 1; k > prev; k--) {
      if (blank(lines[k]!)) continue;
      if (lines[k]!.trim().startsWith('```')) continue;
      path = lines[k]!.trim();
      break;
    }
    if (path === undefined) {
      if (lastPath === undefined) throw new Exit2(`error: parse ${i + 1}`);
      path = lastPath;
    }
    lastPath = path;
    blocks.push({ path, old: lines.slice(i + 1, j), nw: lines.slice(j + 1, e) });
    prev = e;
    i = e + 1;
  }
  return blocks;
}

function srEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const src = tree.get(b.path);
    if (src === null) throw new Fail('missing', b.path);
    const split = splitFile(src);
    const found = findTier(split.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const p = found.pos[0]!;
    split.lines.splice(p, b.old.length, ...srLines(b.nw, split.lines, p, found.tier, b.old));
    tree.now.set(b.path, joinFile(split.lines, split.br, split.final));
  });
}

// --- Section 8: V4A patches ---

interface VChunk {
  anchor: string;
  hasAnchor: boolean;
  items: BItem[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | undefined;
  chunks: VChunk[];
  content: string[];
  line: number; // the section's first line, for `error: parse`
}

const indexItems = (items: BItem[]): void => {
  let oi = 0;
  let ni = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      it.oi = oi;
      it.ni = ni;
      oi += 1;
      ni += 1;
    } else if (it.kind === 'del') it.oi = oi++;
    else it.ni = ni++;
  }
};

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSection[] = [];
  let cur: VSection | null = null;
  let raws: { text: string; line: number }[] = [];
  const close = (): void => {
    if (cur === null) return;
    const sec = cur;
    while (raws.length > 0 && blank(raws[raws.length - 1]!.text)) raws.pop();
    if (sec.kind === 'add') {
      for (const r of raws) {
        if (r.text === '') sec.content.push('');
        else if (r.text.startsWith('+')) sec.content.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.line}`);
      }
    } else if (sec.kind === 'delete') {
      if (raws.length > 0) throw new Exit2(`error: parse ${raws[0]!.line}`);
    } else {
      let idx = 0;
      if (raws.length > 0 && raws[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raws[0]!.text.slice(13).trim();
        idx = 1;
      }
      let open: VChunk | null = null;
      let saw = false;
      const finish = (eof: boolean): void => {
        if (open !== null) {
          open.eof = eof;
          indexItems(open.items);
          sec.chunks.push(open);
          open = null;
        } else if (eof) sec.chunks.push({ anchor: '', hasAnchor: false, items: [], eof: true });
      };
      for (; idx < raws.length; idx++) {
        const r = raws[idx]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          finish(false);
          const anchor = t.slice(2).trim();
          open = { anchor, hasAnchor: anchor !== '', items: [], eof: false };
          saw = true;
        } else if (t.startsWith('*** End of File') && (t.length === 16 || blank(t.slice(16)))) {
          finish(true);
          saw = true;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (open === null) {
            if (saw) throw new Exit2(`error: parse ${r.line}`);
            open = { anchor: '', hasAnchor: false, items: [], eof: false };
            saw = true;
          }
          const kind: 'ctx' | 'del' | 'add' = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'del' : 'add';
          open.items.push({ kind, text: t === '' ? '' : t.slice(1), oi: 0, ni: 0, bs: false });
        } else {
          throw new Exit2(`error: parse ${r.line}`);
        }
      }
      finish(false);
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.line}`);
    }
    cur = null;
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      close();
      const kind: 'add' | 'delete' | 'update' = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      cur = { kind, path: line.slice(line.indexOf(': ') + 2).trim(), moveTo: undefined, chunks: [], content: [], line: i + 1 };
      secs.push(cur);
      raws = [];
    } else if (cur === null) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      raws.push({ text: line, line: i + 1 });
    }
    i += 1;
  }
  close();
  return secs;
}

function v4aEdits(secs: VSection[], strict: boolean): Edit[] {
  return secs.map((sec) => (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.content.length === 0 ? '' : sec.content.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const src = tree.get(sec.path);
    if (src === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const split = splitFile(src);
    const lines = split.lines.slice();
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.hasAnchor) {
        let found = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const eq = EQS[t]!;
          for (let k = cursor; k < lines.length; k++) {
            if (eq(lines[k]!, ch.anchor)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const O = ch.items.filter((x) => x.kind !== 'add').map((x) => x.text);
      const N = ch.items.filter((x) => x.kind !== 'del').map((x) => x.text);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...N);
        cursor = at + N.length;
      } else {
        let tier = -1;
        let p = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const pos = occursAt(lines, O, t).filter((x) => x >= cursor && (!ch.eof || x + O.length === lines.length));
          if (pos.length > 0) {
            tier = t;
            p = pos[0]!;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', sec.path);
        const rep = replacement(ch.items, lines, p, tier, O);
        lines.splice(p, O.length, ...rep);
        cursor = p + N.length;
      }
    }
    const text = joinFile(lines, split.br, split.final);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(sec.path, null);
      tree.moves.push({ old: sec.path, new: sec.moveTo });
    } else tree.now.set(sec.path, text);
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(parseUnified(lines), strict)
      : kind === 'search-replace' ? srEdits(parseSR(lines), strict)
      : v4aEdits(parseV4A(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const mv of tree.moves) {
    const di = rows.findIndex((r) => r.text === `D ${mv.old}`);
    const ai = rows.findIndex((r) => r.text === `A ${mv.new}`);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
