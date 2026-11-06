import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import refresh_archive as archive


class CheckpointUpdates(unittest.TestCase):
    def test_incremental_feed_checks_only_new_receipts_and_retries_idempotently(self):
        at = "2026-11-06T00:00:00.000Z"
        tx, block_hash = "0x" + "a" * 64, "0x" + "b" * 64
        snapshot = {"release": {"id": archive.RELEASE}, "nft": {"burned": 2},
                    "deployment": {"components": {"collection": {"address": archive.COLLECTION},
                                                  "staking": {"address": archive.STAKING}}},
                    "chain": {"safeThroughBlock": 105}}
        old = {"survivor": 1, "donor": 2, "level": 2, "block": 100, "logIndex": 1,
               "tx": "0x" + "c" * 64, "at": at}
        source = {"kind": "chain", "target": "sepolia", "chainId": archive.CHAIN, "releaseId": archive.RELEASE,
                  "confirmationStatus": "safe", "contractAddress": archive.COLLECTION, "transactionHash": tx,
                  "blockNumber": 105, "logIndex": 7, "blockHash": block_hash}
        event = {"type": "nft.merged", "occurredAt": at, "source": source,
                 "payload": {"custody": "wallet", "collection": archive.COLLECTION,
                             "survivorTokenId": 3, "donorTokenId": 4, "level": 2}}
        previous = {"safeBlock": 100, "events": [old]}
        common = {"transactionHash": tx, "blockNumber": hex(105), "blockHash": block_hash}
        log = {**common, "logIndex": "0x7", "address": archive.COLLECTION,
               "topics": [archive.TOPICS["wallet"], f"0x{3:064x}", f"0x{4:064x}"], "data": f"0x{2:064x}{1:064x}"}
        receipt = {**common, "status": "0x1", "logs": [log]}
        header = {"number": hex(105), "hash": block_hash, "timestamp": hex(int(archive.utc_time(at).timestamp()))}
        page = {"events": [event, event], "nextCursor": "older-page"}
        with patch.object(archive, "api", return_value=page) as feed, \
                patch.object(archive, "rpc_batch", return_value=[receipt, header]) as rpc:
            result = archive.read_merges(snapshot, ["rpc"], previous)
            self.assertEqual([(e["survivor"], e["donor"]) for e in result], [(1, 2), (3, 4)])
            self.assertEqual(archive.read_merges(snapshot, ["rpc"], {"safeBlock": 105, "events": result}), result)
            self.assertEqual(feed.call_count, 1)
            rpc.assert_called_once_with("rpc", [("eth_getTransactionReceipt", [tx]), ("eth_getBlockByNumber", [hex(105), False])])

    def test_cached_survivor_requires_a_fresh_read_at_its_burn(self):
        image = b"previously verified image bytes"
        record = {"file": "current-art/7453.svg", "block": 100, "source": "chain",
                  "sha256": hashlib.sha256(image).hexdigest()}
        previous = {"safeBlock": 120, "portraits": {"7453": record}}
        with tempfile.TemporaryDirectory() as temp, patch.object(archive, "DIST", Path(temp)):
            path = Path(temp) / record["file"]
            path.parent.mkdir()
            path.write_bytes(image)
            self.assertEqual(archive.cached_portrait(previous, 7453, {}), record)
            self.assertIsNone(archive.cached_portrait(previous, 7453, {7453: 125}))
            record.update(source="archive", block=115)
            self.assertEqual(archive.cached_portrait(previous, 7453, {7453: 116}), record)
            path.write_bytes(b"corrupted bytes")
            with self.assertRaisesRegex(ValueError, "digest"):
                archive.cached_portrait(previous, 7453, {7453: 116})

    def test_gap_never_replaces_the_last_complete_manifest(self):
        seed = json.loads((ROOT / "dist/data/current.json").read_text(encoding="utf-8"))
        target = {"release": {"id": seed["releaseId"]},
                  "deployment": {"components": {"collection": {"address": archive.COLLECTION},
                                                "staking": {"address": archive.STAKING}}},
                  "chain": {"safeThroughBlock": seed["safeBlock"] + 1, "safeBlockHash": seed["safeBlockHash"],
                            "safeBlockTimestamp": seed["asOf"]},
                  "nft": {"issued": seed["issued"], "burned": seed["burned"] + 1,
                          "live": seed["live"] - 1, "maximumLevel": 10}}
        def api(path, params=None):
            return target if path == "economy/state" else {"events": [], "nextCursor": None}
        with tempfile.TemporaryDirectory() as temp, patch.object(archive, "DIST", Path(temp)), \
                patch.object(archive, "api", api), patch.object(archive, "canonical_providers", return_value=["offline"]):
            manifest = Path(temp) / "data/current.json"
            manifest.parent.mkdir()
            original = json.dumps(seed).encode()
            manifest.write_bytes(original)
            with self.assertRaisesRegex(ValueError, "cover the onchain burn count"):
                archive.refresh()
            self.assertEqual(manifest.read_bytes(), original)
            self.assertFalse((Path(temp) / "current-art").exists())
