# Squeek Family Album

Recover original Squeek artwork from before an NFT was burned, trace the family that inherited it, and export a personal family card. The album supports the current Squeekchain collection and a separate historical Sepolia collection. It works in English and simplified Chinese without connecting a wallet.

[Open #7458's merge](https://squeek.machinepaystack.com/?release=current&id=7458&stage=m-12076748-87&lang=en) · [Recover #7453](https://squeek.machinepaystack.com/?release=current&id=7453&stage=o-7453&lang=en) · [Recover historical #8925](https://squeek.machinepaystack.com/?release=archive&id=8925&stage=o-8925&lang=en) · [打开中文家谱](https://squeek.machinepaystack.com/?lang=zh)

## Open the album

From the project directory run `npm start` or `python -m http.server 4179 --bind 127.0.0.1 --directory dist`. Open [the English edition](http://127.0.0.1:4179/?lang=en) or [中文版](http://127.0.0.1:4179/?lang=zh). The application uses ordinary static files and has no production package dependencies.

The home page opens the current collection at the merge of #7458 and #7453. Both numbers open the same family. Select #7453 to see its original portrait at block 12,076,747, one block before it burned. **Share family card** exports a 1120 × 716 PNG with the selected portrait and its family. **Historical archive · Recover #8925** opens the earlier four-original family at block 12,051,304. Shared links preserve the selected collection and stage. Older unversioned token links still open the historical archive.

## How the records are built

- The scheduled update reads a finalized Sepolia block and fetches merge logs from the pinned NFT contract for release `core-sepolia-20261103`. For a staked merge, the collection and staking contract can emit two logs in one transaction. The album verifies both and uses the staking log's index, so the same merge has the same shared link as in the official player feed. The total must match onchain supply. The browser can add newer merges from that feed after checking their receipts.
- New portraits are read from ERC-721 `tokenURI` at a verified safe block. A new burn always requires a read at the block before the merge, including when its earlier surviving portrait was already saved. The refresh checks the token name, SVG and SHA-256 digest. Each recorded merge participant has a bundled original. Verified surviving originals retain the block of their actual read.
- The browser opens bundled portraits immediately. On a current lookup outside the bundle, it compares the official token image byte-for-byte with the collection's onchain tokenURI. The historical collection `stream-game-sepolia-test-20261026-01` uses its own contracts, original images and fixed block. Unbundled historical reads go directly to that contract. Preview and standalone download accept the renderer's passive UTF-8 SVG subset.
- A GitHub Actions workflow runs at 17 and 47 minutes past each hour on the default branch. It resumes from the previous verified block, reconciles the new total with onchain supply and checks the image files and browser exports before deploying to the same site. A failed refresh leaves the last complete site available. GitHub may delay a scheduled run. The footer shows the block time of the displayed index.

[Official merge rules](https://docs.squeekchain.com/squeeks/merge/) · [API reference](https://docs.squeekchain.com/developers/api/) · [#7458 + #7453 transaction](https://sepolia.etherscan.io/tx/0xe2035a8e291cc04c0c4c6f3c7598190022205d0fb65345e7f8074f32e0dcdb85) · [#8925 historical transaction](https://sepolia.etherscan.io/tx/0x2b1490a77b90b5e2d4d8279ce004a2a9088e330b634fcfd117f850ccec13bd98)

## Refresh and check

Refresh the current snapshot with `python -B scripts/refresh_archive.py --onchain`. This requires Python 3.10+ and the `requests` package. It reads public Sepolia RPCs and writes to `dist/data/current.json` and `dist/current-art/`. Omit `--onchain` to use the official economy and player APIs as the event source with the same receipt checks. The historical manifest and portraits reside separately in `dist/data/archive.json` and `dist/art/`.

Use Node 20.19+ or 22.12+ for the validation commands.

1. Run `npm ci`, `npm test` and `python -B -m unittest discover -s tests -p "test_*.py"`. Run `npm run verify:chain` for a full independent replay of the bundled receipts. Scheduled releases verify the unchanged checkpoint and independently replay the new receipts.
2. Start the local site and run `npm run test:browser` in a second terminal. Set `CHROME_PATH` if the test cannot locate an installed Chrome or Edge.
3. Set `$env:ALBUM_LIVE='1'` in PowerShell before the browser test to check an uncached current portrait and recover both #7453 and historical #8925 from their pre-burn blocks. The browser downloads and checks PNGs for both featured current IDs. Fixtures cover a future merge, wrong collections, mismatched artwork and invalid receipts. Test screenshots and cards are saved under `.qa/`.

squeekchain-project: 9c3269ac-ae72-4d40-ac2f-db56a1776672
