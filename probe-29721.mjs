/**
 * Execution probe for issue #29721: prove the bare-subtraction comparator in
 * resolveConversation's recency fallback is nondeterministic / mis-selecting
 * when updatedAt strings are unparseable, and that compareConversationsByRecency
 * (the in-repo total-order comparator) fixes the selection.
 *
 * Pure logic probe — no runtime, no I/O. Run: bun run probe-29721.mjs
 */

// Current production comparator (client-chat-sender.ts lines 123-126)
function currentComparator(a, b) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function pickCurrent(convs) {
  return Array.from(convs).sort(currentComparator)[0];
}

// Candidate: in-repo total-order comparator (conversation-sort.ts)
function finiteOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function compareConversationsByRecency(a, b) {
  const bVal = finiteOrZero(new Date(b.updatedAt).getTime());
  const aVal = finiteOrZero(new Date(a.updatedAt).getTime());
  return bVal - aVal || a.id.localeCompare(b.id);
}
function pickFixed(convs) {
  return Array.from(convs).sort(compareConversationsByRecency)[0];
}

let failures = 0;
function probe(name, actual, expected, why) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} — ${why}`);
}

// Case 1: NaN comparator poisons sort — insertion order + engine decides.
// With a NaN comparator, V8's TimSort can leave the corrupt entry first
// depending on array layout. Demonstrate that the CURRENT pick CAN return
// the corrupt conversation even when a strictly newer valid one exists.
const newer = { id: "c-new", updatedAt: "2026-08-28T00:00:00.000Z" };
const corrupt = { id: "c-bad", updatedAt: "not-a-date" };
// Direct comparator calls: NaN in at least one direction
const cmpCorruptVsNew = currentComparator(corrupt, newer); // NaN - finite = NaN
const cmpNewVsCorrupt = currentComparator(newer, corrupt); // finite - NaN = NaN
probe("current comparator returns NaN (corrupt,new)", Number.isNaN(cmpCorruptVsNew), true, "new Date('not-a-date').getTime() is NaN; subtraction yields NaN");
probe("current comparator returns NaN (new,corrupt)", Number.isNaN(cmpNewVsCorrupt), true, "NaN poisons both directions -> sort implementation-defined");
probe("fixed comparator orders corrupt LAST", compareConversationsByRecency(newer, corrupt) < 0, true, "corrupt coerces to epoch 0 = oldest");

// Case 2: sweep insertion orders — current pick is layout-dependent.
let badSelections = 0;
const orders = [
  [corrupt, newer],
  [newer, corrupt],
];
for (const order of orders) {
  if (pickCurrent([...order]).id === "c-bad") badSelections++;
}
console.log(`INFO layout sweep: current pick selected corrupt conversation in ${badSelections}/2 insertion orders (NaN sort is engine/layout-defined; ANY selection of c-bad here is wrong)`);

// Case 3: all-corrupt timestamps — current is arbitrary; fixed is deterministic (id tie-break).
// NOTE: fixture strings must be verified-unparseable — V8 accepts surprising
// strings like "garbage-1" (year 2001); "not-a-date"/"///" are NaN in V8+JSC.
const allCorrupt = [
  { id: "c-c", updatedAt: "not-a-date" },
  { id: "c-a", updatedAt: "not-a-date-either" },
  { id: "c-b", updatedAt: "///" },
];
probe("fixed pick with all-corrupt timestamps is deterministic (lowest id)", pickFixed([...allCorrupt]).id, "c-a", "total order via id tie-break");

// Case 4: valid ordering preserved by fixed comparator.
const valid = [
  { id: "c-old", updatedAt: "2026-08-20T00:00:00.000Z" },
  { id: "c-new", updatedAt: "2026-08-28T00:00:00.000Z" },
];
probe("fixed pick selects most recent on valid data", pickFixed([...valid]).id, "c-new", "recency ordering unchanged for healthy input");

// Case 5: equal timestamps tie-break (both comparators relevant).
const equal = [
  { id: "c-z", updatedAt: "2026-08-28T00:00:00.000Z" },
  { id: "c-y", updatedAt: "2026-08-28T00:00:00.000Z" },
];
probe("fixed tie-break on equal timestamps is deterministic", pickFixed([...equal]).id, "c-y", "id localeCompare tie-break");

console.log(failures === 0 ? "ALL PROBES PASS" : `${failures} PROBE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
