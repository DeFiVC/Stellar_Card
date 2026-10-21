---
'stellar_card': patch
---

Implement secure in-memory zeroization of secret keys in `ows.ts` (#687). Adds `zeroizeSecret` to wipe `Uint8Array`/`Buffer` secret material after it has been copied into a derived form, and applies it in `importStellarKey` so raw Stellar secret key bytes do not linger in memory.