/**
 * Every `uses:` in a workflow must be pinned (#99): an action to a full 40-hex commit SHA, a
 * Docker image to a digest. Local actions (`./…`) are fine. Returns one line per offender.
 */
export function unpinnedActions(files) {
  const found = [];
  for (const [file, text] of Object.entries(files)) {
    // Skip the body of block scalars (`run: |`): lines indented deeper than the key that opened them.
    let blockIndent = -1;
    text.split('\n').forEach((line, i) => {
      const indent = line.search(/\S/);
      if (blockIndent >= 0) {
        if (indent === -1 || indent > blockIndent) return;
        blockIndent = -1;
      }
      const key = /^(\s*)(?:-\s+)?[\w-]+:\s*[|>][-+]?\s*$/.exec(line);
      if (key) {
        blockIndent = indent;
        return;
      }
      const m = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)/.exec(line);
      if (!m) return;
      const ref = m[1];
      if (ref.startsWith('./')) return;
      if (ref.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) found.push(`${file}:${i + 1}: ${ref} (pin the image by digest: …@sha256:<digest>)`);
        return;
      }
      if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) found.push(`${file}:${i + 1}: ${ref} (pin to a full commit SHA, with a "# vX.Y.Z" comment)`);
    });
  }
  return found;
}
