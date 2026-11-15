import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import typescript from 'highlight.js/lib/languages/typescript';

/** The stock bash grammar only colors shell built-ins; every command on this
 *  site is a toolchain CLI, so extend the built-in list with our vocabulary. */
const TOOLCHAIN_COMMANDS = ['bunx', 'bun', 'scriptca', 'node', 'deno', 'npx', 'wrangler'];

const bashWithToolchain = (hljsInstance: Parameters<typeof bash>[0]) => {
  const grammar = bash(hljsInstance);
  const keywords = grammar.keywords;
  if (keywords && !Array.isArray(keywords) && typeof keywords !== 'string') {
    const existing = keywords.built_in;
    const existingList = Array.isArray(existing)
      ? existing.filter((entry): entry is string => typeof entry === 'string')
      : typeof existing === 'string'
        ? [existing]
        : [];
    keywords.built_in = [...existingList, ...TOOLCHAIN_COMMANDS];
  }
  return grammar;
};

hljs.registerLanguage('bash', bashWithToolchain);
hljs.registerLanguage('ts', typescript);

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Highlight a static, site-owned snippet into HTML. Unknown languages (and
 * unregistered aliases) fall back to escaped plain text, so a typo can never
 * blank a code surface. All inputs here are i18n string literals — no
 * user-supplied code is ever rendered through this path.
 */
export function highlightCode(code: string, lang: string): string {
  if (hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  }
  return escapeHtml(code);
}
