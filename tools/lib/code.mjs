// Shared helpers for n8n Code-node scripts in n8n/code/.
//  * //@include <file> inlines a shared helper at build time (n8n Code nodes
//    cannot import local files).
//  * syntaxCheck() parses a script the way n8n runs it (async function body).
//  * nodeRefs() lists every $('Node name') reference, for static checks.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'n8n', 'code');

export function inlineIncludes(src, dir = CODE_DIR, seen = new Set()) {
  return src
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*\/\/@include\s+(\S+)\s*$/);
      if (!m) return line;
      if (seen.has(m[1])) return '';
      seen.add(m[1]);
      return inlineIncludes(readFileSync(join(dir, m[1]), 'utf8'), dir, seen);
    })
    .join('\n');
}

export function readScript(file, dir = CODE_DIR) {
  return inlineIncludes(readFileSync(join(dir, file), 'utf8'), dir, new Set([file]));
}

// n8n evaluates a Code node body as an async function body.
export function syntaxCheck(code, filename = 'code-node.js') {
  try {
    new vm.Script(`(async function(){${code}\n})`, { filename });
    return null;
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
}

export function nodeRefs(code) {
  const out = new Set();
  const re = /\$\(\s*(['"`])((?:\\.|(?!\1).)+)\1\s*\)/g;
  let m;
  while ((m = re.exec(code))) out.add(m[2]);
  return [...out];
}
