/**
 * `source` with its comments blanked out, string and template literals left
 * intact.
 *
 * A comment explaining what must not happen reads exactly like the thing
 * happening, and the files that reach for this are full of such comments.
 * Blanking rather than deleting keeps every offset where it was, so a
 * reported match still points at the right place.
 *
 * ## Why this is a helper and not an export from a test file
 *
 * It lived in `test/consumer-no-rebuild-delegation.test.ts` until #627 needed
 * it in a second place. Importing it from there also REGISTERS that file's
 * tests into the importer — measured, not assumed: the five-file AC-7 command
 * went from 147 cases to 180, and the thirty-three extra ones were reported
 * under a file that does not contain them. A shared helper has no `test()` at
 * module scope, so it can be imported without changing what the importer runs.
 */
export function stripComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i] === c) {
          i++;
          break;
        } else i++;
      }
    } else i++;
  }
  return out.join("");
}
