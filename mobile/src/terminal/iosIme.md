# iOS direct input ownership

Installed after `Terminal.open`, the parent capture listeners exclude xterm 5.5's
CompositionHelper composition events, its keyCode 229 deferred reader, and
`_inputEvent`. Hardware keys and native paste remain xterm-owned. Toolbar input,
modified shortcuts, blur, paste and reset invalidate the adapter's editable suffix.

Composition preedit is not sent. Final DOM edits are reconciled once, including
input interleaved with compositionend and later-task final mutations. An unchanged
DOM notification is not an edit. An appended identical phrase or witnessed textarea
reset is a new edit, regardless of elapsed time. No phrase repetition heuristics.

Corrections require beforeinput selection evidence within the still-owned suffix.
DEL is counted by Unicode scalar for ASCII and CJK ideographs, not UTF-16 units or
screen columns. This assumes the remote line editor erases one such character per
DEL. Arbitrary raw/full-screen applications cannot offer a universal replacement
protocol. Complex graphemes or unproven destructive changes are not sent; this can
omit a correction rather than corrupt unrelated terminal contents.

Some input methods insert text the user never typed: typing `(` can leave an
auto-paired closer behind the caret, and smart quotes do the same. Those ranges
are tracked as ghosts (offsets into the routing baseline). They are never sent,
never counted as DEL targets, and never make an edit in front of them
unprovable: an insertion at the caret is mapped by its inserted run, with the
part the caret moved past treated as typed and the rest registered as ghost.
An edit is only mapped while no sent character sits behind the edited region,
because the terminal is append-only. A declined edit still drops ownership
rather than erasing text it could not map.

One shape sends the closer before the caret can prove anything: the method
appends the whole pair while the caret is still at the end (measured on device),
then moves the caret back inside without a DOM edit. `lastPadding` keeps the
closer's range, and the first input that lands exactly in front of it retracts
that one character from the terminal (DEL), keeps it as untyped text, and then
sends what the user typed. A key that leaves through xterm retracts it the same
way first, so `(` followed by Enter sends the typed bracket and the Enter only.
The open half of a pair is never retracted: it is the typed half. A single
appended closer counts as padding too, because that is how the same padding
arrives when the method emits it as its own edit.

## Physical-device diagnosis (opt-in)

In Safari's remote Web Inspector for the actual iOS webview:

```js
window.__agentportIosImeDiagnostics.enable()
// Reproduce once, including an intentional repeated phrase.
window.__agentportIosImeDiagnostics.snapshot()
window.__agentportIosImeDiagnostics.disable()
```

At most 256 records exist in memory, with event/input types, data/value lengths,
DOM equality against the routing baseline, selection, composition state, emission
length and decision reason. No text, hashes, key names, storage or transmission.
Disable clears the buffer; snapshot returns copies. The browser's live textarea
necessarily contains input, but the diagnostic buffer never does.

Tests open installed xterm and exercise synthetic DOM sequences. They do not
simulate WebKit's native keyboard pipeline or certify physical Doubao behavior.
The paired-punctuation regression (`iOS IME text the user never typed`) fails on
the pre-ghost implementation, including two cases where that version sent a DEL
for text it had never sent.
No real Doubao trace is available. If a keyboard really inserts the phrase twice
as two DOM edits, both are preserved: distinguishing that from intentional repeats
requires evidence, not string/time dedup. A compositionend whose DOM never reaches
the reported final value and has no final input notification cannot be reliably
committed. Length/equality-only traces identify ordering and ownership failures
but cannot reconstruct lexical correctness; compare the observed terminal result
on-device. Canvas rendering warnings in jsdom are not device rendering validation.
