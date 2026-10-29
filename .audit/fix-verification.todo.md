# Fix verification audit (poteto Investigation playbook, read-only)

1. Route through the how skill. skip: why skill, question is "are the fixes correct", not motivation.
2. throughput checkpoint: n/a, read-only investigation
3. Produce the how-shaped output, or a recommendation with a tradeoffs table if the request is a decision between alternatives.
4. Apply the unslop skill to the reply.

Task todos:
- [x] Sequential pass (spawn_agent unsupported on this host): server fixes 2, 8, 9 hold
- [x] Sequential pass: editor fixes hold except one new finding in #5 (uploadPending never clears on plain-mode unmount)
- [x] Sequential pass: cart fix 7 holds, all creation paths locked
- [x] Main thread: tsc 0 errors, targeted tests from implementation run still the proof of record
