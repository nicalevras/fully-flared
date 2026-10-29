# Application change boundary

The first Gate 0 tool output in this chat, before artifact workers started, recorded this status:

```
 M web/package.json
?? .audit/
?? web/.grok/
?? web/scripts/verify-stock-sale.mjs
```

This is a transcription of the contemporaneous tool output, not a cryptographic before-state snapshot. No initial full-tree hash was collected. The same application paths remain dirty/untracked at handoff; the package change adds the existing verify:stock script. Audit writes were confined to .audit/gate0 and disposable /tmp state. No application patches, migrations or production commands were issued during Gate 0.

Thirty cited source files were independently compared byte-for-byte against git object 6339f228c3dd7b9a71442d0983b73695bdab306e, the isolated main archive and the current checkout. Their hashes are in architecture/baseline-provenance.json. This proves the inspected source baseline, not every byte of the working directory across time.

The source archive baseline-source.tar.gz was created with git archive from that exact main object. Its SHA-256 is b723f9027e8ae911be164ddbb26f0d12f8d1ab346baef3f09f98e53cadc96878. It contains tracked repository files only; local variables, credentials, user changes and node_modules are excluded. Source reference is bundled for reproduction, not a proposed application change.
