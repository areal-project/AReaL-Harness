'use strict';
// Presentation data shared by desktop Review and native task-history routes.

const path = require('node:path');
const languages = { js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', json: 'json', css: 'css', html: 'html', py: 'python', sh: 'shellscript', yml: 'yaml', yaml: 'yaml', md: 'markdown', rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp' };

async function highlightFiles(files) {
  const { codeToTokensWithThemes } = await import('shiki');
  let remaining = 300000;
  for (const file of files) {
    const lang = languages[path.extname(file.path).slice(1)];
    if (!lang) continue;
    for (const hunk of file.hunks) {
      const size = hunk.lines.reduce((sum, line) => sum + line.text.length, 0);
      if (size > remaining) continue;
      remaining -= size;
      // Tokenize each side separately so deleted syntax cannot alter added code.
      for (const side of ['old', 'new']) {
        const lines = hunk.lines.filter(line => line[`${side}Line`] !== null);
        if (!lines.length) continue;
        const result = await codeToTokensWithThemes(lines.map(line => line.text).join('\n'), {
          lang, themes: { light: 'github-light', dark: 'github-dark' },
        });
        lines.forEach((line, index) => {
          if (side === 'old' && line.kind !== 'del') return;
          line.tokens = result[index].map(token => ({ text: token.content, light: token.variants.light.color, dark: token.variants.dark.color }));
        });
      }
    }
  }
  return files;
}

module.exports = { highlightFiles };
