# Squeek Family Album

An independent, read-only collection explorer for Squeekchain on Ethereum Sepolia. Enter an NFT ID to trace its merges, examine the artwork of each original and save a family card. The interface is available in English and simplified Chinese. Visitors never need a wallet.

[Open the live album](https://squeek.machinepaystack.com/?id=8923&lang=en) · [打开中文家谱](https://squeek.machinepaystack.com/?id=8923&lang=zh)

## Open the album

From the project directory run `npm start` or `python -m http.server 4179 --bind 127.0.0.1 --directory dist`. Open [the English edition](http://127.0.0.1:4179/?id=8923&lang=en) or [中文版](http://127.0.0.1:4179/?id=8923&lang=zh). The application uses ordinary static files and has no production package dependencies.

Start with **#8923**. Its historical level-three merge combined four originals. Follow **#8925** to see the artwork recovered from block 12,051,304, immediately before its burn. The surviving family can grow through later merges. Open a ledger transaction to inspect the event. The share dialog exports a 1120 × 716 PNG and copies a link to the selected stage. Social platforms receive a collection-level cover.

## How the records are built

- The index follows a pinned Sepolia release, collection and staking contract. It reconciles the event feed with the burn count. For each merge it also reads an independent RPC receipt and canonical block, checks the emitter, event signature, log index and block time, and decodes the surviving ID, burned ID and level.
- The refresh script reads each surviving portrait at the snapshot's safe block. For a burned donor it reads ERC-721 `tokenURI` at the block preceding the merge. It checks the returned NFT name, validates the SVG and records its SHA-256 digest. The archive is replaced only after the complete collection of images is available.
- The browser opens the bundled records immediately and checks for newer merges. It verifies new events in small RPC batches before replacing the visible snapshot. Unmerged IDs outside the bundle use the official token endpoint. New burns can recover their artwork from a public archive RPC. Preview and standalone download accept the renderer's passive UTF-8 SVG subset and preserve the original bytes.
- If the external service is unavailable the timestamped bundled families remain available. An uncached token that cannot be verified displays an explicit unavailable state. A long gap in the feed requires running a full snapshot refresh.

[Official merge rules](https://docs.squeekchain.com/squeeks/merge/) · [API reference](https://docs.squeekchain.com/developers/api/) · [Example surviving token](https://api.squeekchain.com/v1/squeeks/8923) · [Example burn transaction](https://sepolia.etherscan.io/tx/0x2b1490a77b90b5e2d4d8279ce004a2a9088e330b634fcfd117f850ccec13bd98)

## Refresh and check

Refresh the snapshot with `python -B scripts/refresh_archive.py`. This requires Python 3.10+ and the `requests` package. It uses public read-only endpoints. The checked-in snapshot is sufficient to run the site.

Use Node 20.19+ or 22.12+ for the validation commands.

1. Run `npm ci`, `npm test` and `python -B -m unittest discover -s tests -p test_svg.py`. The release also runs `npm run verify:chain` against public Sepolia RPCs to confirm the actual bundled records.
2. Start the local site and run `npm run test:browser` in a second terminal. Set `CHROME_PATH` if the test cannot locate an installed Chrome or Edge.
3. To exercise live uncached token lookup and a missing merge against the real services, set `$env:ALBUM_LIVE='1'` in PowerShell before the browser test. Browser-local fixtures also cover slow loading, malformed data, private link parameters and image validation. Test screenshots and a downloadable share-card sample are saved under `.qa/`.
