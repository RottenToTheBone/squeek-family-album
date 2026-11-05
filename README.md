# Squeek Family Album

Recover original Squeek artwork from before an NFT was burned, trace the family that inherited it, and export a personal family card. The album supports the current Squeekchain collection and a separate historical Sepolia collection. It works in English and simplified Chinese without connecting a wallet.

[Open the current collection](https://squeek.machinepaystack.com/?release=current&id=42&lang=en) · [Recover historical #8925](https://squeek.machinepaystack.com/?release=archive&id=8925&stage=o-8925&lang=en) · [打开中文家谱](https://squeek.machinepaystack.com/?lang=zh)

## Open the album

From the project directory run `npm start` or `python -m http.server 4179 --bind 127.0.0.1 --directory dist`. Open [the English edition](http://127.0.0.1:4179/?lang=en) or [中文版](http://127.0.0.1:4179/?lang=zh). The application uses ordinary static files and has no production package dependencies.

The home page opens the current collection. Choose **Recover the burned #8925 portrait** to examine the historical artwork at block 12,051,304, immediately before its burn. Its family contains four originals. Use **Current collection** to inspect that same number on the new contract. The share dialog exports a 1120 × 716 PNG labeled with the collection and copies a link to the selected stage. Older unversioned token links open the historical archive.

## How the records are built

- The current index pins release `core-sepolia-20261103`, its NFT and staking contracts, and the expected API schemas. It reconciles the event feed with onchain supply. Each merge must match its transaction receipt, canonical block, emitter, log index, token IDs and level.
- The refresh script reads each surviving portrait at the snapshot's safe block. For a burned donor it reads ERC-721 `tokenURI` at the block preceding the merge. It checks the returned NFT name, validates the SVG and records its SHA-256 digest. The archive is replaced only after the complete collection of images is available.
- The browser opens bundled portraits immediately. On a current lookup outside the bundle, it compares the official token image byte-for-byte with the collection's onchain tokenURI. The historical collection `stream-game-sepolia-test-20261026-01` uses its own contracts, original images and fixed block. Unbundled historical reads go directly to that contract. Preview and standalone download accept the renderer's passive UTF-8 SVG subset.
- If the external service is unavailable the timestamped bundled families remain available. An uncached token that cannot be verified displays an explicit unavailable state. A long gap in the feed requires running a full snapshot refresh.

[Official merge rules](https://docs.squeekchain.com/squeeks/merge/) · [API reference](https://docs.squeekchain.com/developers/api/) · [Example surviving token](https://api.squeekchain.com/v1/squeeks/8923) · [Example burn transaction](https://sepolia.etherscan.io/tx/0x2b1490a77b90b5e2d4d8279ce004a2a9088e330b634fcfd117f850ccec13bd98)

## Refresh and check

Refresh the current snapshot with `python -B scripts/refresh_archive.py`. This requires Python 3.10+ and the `requests` package. It uses public read-only endpoints and writes to `dist/data/current.json` and `dist/current-art/`. The historical manifest and portraits reside separately in `dist/data/archive.json` and `dist/art/`.

Use Node 20.19+ or 22.12+ for the validation commands.

1. Run `npm ci`, `npm test` and `python -B -m unittest discover -s tests -p test_svg.py`. The release also runs `npm run verify:chain` against public Sepolia RPCs to confirm the actual bundled records.
2. Start the local site and run `npm run test:browser` in a second terminal. Set `CHROME_PATH` if the test cannot locate an installed Chrome or Edge.
3. Set `$env:ALBUM_LIVE='1'` in PowerShell before the browser test to check an uncached current portrait against the contract and recover a missing historical portrait from its pre-burn block. Fixtures test a future current merge, wrong collections, mismatched artwork and invalid receipts. Test screenshots and an exported card are saved under `.qa/`.

squeekchain-project: 9c3269ac-ae72-4d40-ac2f-db56a1776672
