/** URLs are offered only as observed process output, never guessed from a port. */
export function observedServiceUrls(output: string, running: boolean, partial: boolean): string[] {
  if (!running || partial) return [];
  const urls = new Set<string>();
  for (const match of output.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const candidate = match[0].replace(/[),.;]+$/, "");
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol) || !url.port || url.username || url.password
        || url.search || url.hash || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) continue;
      urls.add(url.href);
    } catch { /* Incomplete output is not an endpoint. */ }
  }
  return [...urls];
}
