// Git smart-HTTP protocol helpers used at the Outbound boundary.

/** Ref names from a git receive-pack request: pkt-lines "<old> <new> <ref>[\0caps]" up to the flush. */
export function receivePackRefs(body: Uint8Array): string[] {
  const refs: string[] = [];
  const dec = new TextDecoder();
  let i = 0;
  while (i + 4 <= body.length) {
    const len = Number.parseInt(dec.decode(body.subarray(i, i + 4)), 16);
    if (!Number.isFinite(len)) return ["<malformed>"];
    if (len === 0) break;
    if (len < 4 || i + len > body.length) return ["<malformed>"];
    const line = dec.decode(body.subarray(i + 4, i + len)).split("\0")[0]!.trim();
    const parts = line.split(" ");
    if (parts.length !== 3) return ["<malformed>"];
    refs.push(parts[2]!);
    i += len;
  }
  return refs;
}
