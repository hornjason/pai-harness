---
description: Worked instances behind `.claude/rules/self-referential-tests.md` — the three checks this very file tripped while being written, moved out of the always-loaded surface (#1009)
doc-type: reference
status: active
owner: jason
updated: 2026-10-22
---

# Self-referential tests — the worked instances

The rule is in `.claude/rules/self-referential-tests.md` and loads on every
turn. This write-up is the evidence behind it, kept verbatim and read when
somebody wants the demonstration rather than the list. It moved here because
the always-loaded surface was 36 bytes under its budget and the rule needed a
new row (#1001).

## This file tripped one of its own checks on the first run

Worth leaving in, because it is the cheapest possible demonstration that the
list above is not theoretical.

The draft closed by citing a rules file named for exemption-list
self-reference. No such file exists — the idea does, in `harness-managed.md`
and in the no-exemption-list rows above, but not under that name.
`test/rule-provenance.test.ts` caught it immediately: *"every
`.claude/rules/*.md` the repo routes to exists"*. One file added, zero code
touched, and a test in a file nobody had opened went red.

**Then the obvious repair failed too, for a reason worth knowing.** Rewriting
the paragraph to explain that the path does not exist left the path *in the
prose*, and the scanner counted it again — a checker that greps for a filename
cannot tell a citation from a sentence about a citation. Same shape as
`claiming-sc-coverage.md`'s central problem, met from the other side. The only
fix is not to write the literal path at all, which is why the name is spelled
out in words above.

The check is good: it names the citing file and the missing path, which is
more than most of Tier 1 does.

**Then CI caught a third one, and this is the one that matters.** The draft
cited ten `file.ts:NNN` line positions, so `#541`'s citation ratchet refused
it — *"`.claude/rules/self-referential-tests.md` is not in
`.claude/line-citation-ratchet.json` and carries 10 line citations. A document
absent from the ratchet is allowed none."*

Two things to take from it. First, **I did not run the test this very file
tells you to run**: "added or edited a doc → `test/line-citation-ratchet.test.ts`"
is a row above, written before the push, and the local run skipped it. Writing
the rule is not the same as following it, which is the argument for the census
block in the swarm brief rather than a document.

Second, **the right fix was not to bank an entry in the ratchet.** The ratchet
exists because line numbers rot, and a rule file is read months after it is
written. Every citation here now names a stable symbol — `SCANNED_FILES` in
`test/consumer-no-rebuild-delegation.test.ts` — instead of a line that will be
wrong by the time someone needs it. The cheap fix was one JSON entry; the
correct one made the document better and the ratchet entry unnecessary.

And the failure message is genuinely good — it names the file, the count, the
ratchet, and the policy. It belongs with `SC-1466` as a model, not with Tier 1.
