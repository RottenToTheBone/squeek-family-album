"""Refresh the read-only Sepolia album. Requires Python 3.10+ and requests."""

import hashlib
import json
import os
import re
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree

import requests

from svg_validation import decode_uri, validate_svg


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
API = "https://api.squeekchain.com/v1"
RPCS = ("https://sepolia.gateway.tenderly.co", "https://rpc.sepolia.ethpandaops.io")
CHAIN = 11155111
HASH = re.compile(r"0x[0-9a-fA-F]{64}")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
RELEASE = "stream-game-sepolia-test-20261026-01"
COLLECTION = "0xcb98349c134ab983da5bfd80527dfe2552bdb70f"
STAKING = "0x4b67b739dfd832f4eac67a7aa3bc244fb74cea4f"
TOPICS = {
    "wallet": "0x8a9b1a009a32cc0082d2270e9033429b8e1aa3235e7b8198b013f603116a3c87",
    "staking": "0x47dc7fa0b474cf75263255e0530e84606f909e3099ad0d06bd67883467333339",
}
UTC_TIME = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def api(path, params=None):
    response = requests.get(f"{API}/{path}", params=params, timeout=30)
    response.raise_for_status()
    data = response.json()
    require(data.get("status") == "available", f"{path}: {data.get('reason', 'unavailable')}")
    require(data["chain"]["target"] == "sepolia" and int(data["chain"]["chainId"]) == CHAIN,
            f"{path}: wrong chain")
    return data


def rpc(url, method, params):
    response = requests.post(url, timeout=25, json={
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
    })
    response.raise_for_status()
    body = response.json()
    require("result" in body and body["result"] is not None, f"{method}: {body.get('error', 'no result')}")
    return body["result"]


def canonical_providers(block, block_hash, previous=None, counts=None, as_of=None):
    providers = []
    for url in RPCS:
        try:
            require(int(rpc(url, "eth_chainId", []), 16) == CHAIN, "wrong RPC chain")
            header = rpc(url, "eth_getBlockByNumber", [hex(block), False])
            require(int(header["number"], 16) == block and header["hash"].lower() == block_hash.lower(),
                    "safe block differs")
            if as_of is not None:
                require(int(header["timestamp"], 16) == utc_time(as_of).timestamp(), "safe block time differs")
            if previous is not None:
                old = rpc(url, "eth_getBlockByNumber", [hex(previous["safeBlock"]), False])
                require(int(old["number"], 16) == previous["safeBlock"]
                        and old["hash"].lower() == previous["safeBlockHash"].lower(),
                        "previous snapshot is on another fork")
            if counts is not None:
                for field, selector in (("live", "0x18160ddd"), ("burned", "0xd89135cd")):
                    raw = rpc(url, "eth_call", [{"to": COLLECTION, "data": selector}, hex(block)])
                    require(HASH.fullmatch(raw) and int(raw, 16) == int(counts[field]), "Onchain supply mismatch")
            providers.append(url)
        except (ValueError, KeyError, requests.RequestException) as exc:
            print(f"Skipping {url}: {exc}", file=sys.stderr)
    require(providers, "No archive provider agrees with the official safe block")
    return providers


def utc_time(value):
    require(isinstance(value, str) and UTC_TIME.fullmatch(value), "Invalid UTC timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def confirm_merge(event, custody, block_hash, receipt, header):
    block, tx = event["block"], event["tx"]
    require(custody in TOPICS and header["hash"].lower() == block_hash
            and int(header["number"], 16) == block
            and int(header["timestamp"], 16) == utc_time(event["at"]).timestamp(), "Canonical block mismatch")

    def same_transaction(record):
        return (record["transactionHash"].lower() == tx and int(record["blockNumber"], 16) == block
                and record["blockHash"].lower() == block_hash)

    require(int(receipt["status"], 16) == 1 and same_transaction(receipt), "Merge receipt mismatch")
    logs = [log for log in receipt["logs"] if int(log["logIndex"], 16) == event["logIndex"]]
    require(len(logs) == 1, "Missing or ambiguous merge log")
    log = logs[0]
    staked = custody == "staking"
    topics, data = log["topics"], log["data"]
    require(same_transaction(log) and not log.get("removed", False)
            and log["address"].lower() == (STAKING if staked else COLLECTION)
            and len(topics) == (4 if staked else 3) and all(HASH.fullmatch(t) for t in topics)
            and topics[0].lower() == TOPICS[custody] and re.fullmatch(r"0x[\da-fA-F]+", data)
            and len(data) == 2 + 64 * (3 if staked else 2), "Unexpected receipt log")
    words = [int(data[i:i + 64], 16) for i in range(2, len(data), 64)]
    if staked:
        require(int(topics[2], 16) == int(COLLECTION, 16) and re.fullmatch(r"0x0{24}[\da-fA-F]{40}", topics[1]),
                "Wrong staking event collection")
        actual = (int(topics[3], 16), words[0], words[1])
    else:
        actual = (int(topics[1], 16), int(topics[2], 16), words[0])
    require(actual == (event["survivor"], event["donor"], event["level"]), "Onchain merge IDs or level differ")


def read_merges(snapshot, providers=None):
    release = snapshot["release"]["id"]
    collection = snapshot["identities"]["genesis"].lower()
    staking = snapshot["identities"]["staking"]["proxy"].lower()
    safe_block = int(snapshot["chain"]["safeThroughBlock"])
    require((release, collection, staking) == (RELEASE, COLLECTION, STAKING), "Unrecognized merge deployment")
    if providers is None:
        providers = canonical_providers(safe_block, snapshot["chain"]["safeBlockHash"], counts=snapshot["nft"],
                                        as_of=snapshot["chain"]["safeBlockTimestamp"])
    events = {}
    cursors = set()
    params = {"category": "players", "limit": 100}
    while True:
        page = api("events", params)
        require(page["release"]["id"] == release and page["identities"]["genesis"].lower() == collection,
                "The event feed changed deployment")
        for event in page["events"]:
            if event["type"] != "nft.merged":
                continue
            source, payload = event["source"], event["payload"]
            block = int(source["blockNumber"])
            if block > safe_block:
                continue
            expected_contract = {"wallet": collection, "staking": staking}.get(payload["custody"])
            require(source["kind"] == "chain" and source["target"] == "sepolia"
                    and int(source["chainId"]) == CHAIN and source["releaseId"] == release
                    and source["confirmationStatus"] in {"safe", "finalized"}
                    and payload["collection"].lower() == collection
                    and source["contractAddress"].lower() == expected_contract,
                    f"Unrecognized merge source at block {block}")
            tx = source["transactionHash"].lower()
            require(HASH.fullmatch(tx) and HASH.fullmatch(source["blockHash"]), "Invalid event hash")
            item = {
                "survivor": int(payload["survivorTokenId"]), "donor": int(payload["donorTokenId"]),
                "level": int(payload["level"]), "block": block, "logIndex": int(source["logIndex"]),
                "tx": tx, "at": event["occurredAt"],
            }
            utc_time(item["at"])
            key = (tx, item["logIndex"])
            proof = (item, payload["custody"], source["blockHash"].lower())
            require(key not in events or events[key] == proof, "Conflicting duplicate event")
            events[key] = proof
        cursor = page["nextCursor"]
        if cursor is None:
            break
        require(cursor and cursor not in cursors, "Repeated or empty event cursor")
        cursors.add(cursor)
        params["cursor"] = cursor
    proofs = list(events.values())
    for offset in range(0, len(proofs), 8):
        group = proofs[offset:offset + 8]
        calls = []
        for item, _, _ in group:
            for method, params in (("eth_getTransactionReceipt", [item["tx"]]),
                                   ("eth_getBlockByNumber", [hex(item["block"]), False])):
                calls.append({"jsonrpc": "2.0", "id": len(calls) + 1, "method": method, "params": params})
        failure = None
        for endpoint in providers:
            try:
                response = requests.post(endpoint, json=calls, timeout=25)
                response.raise_for_status()
                replies = response.json()
                require(isinstance(replies, list) and len(replies) == len(calls), "Incomplete RPC batch")
                results = {entry["id"]: entry["result"] for entry in replies}
                for i, (item, custody, block_hash) in enumerate(group):
                    confirm_merge(item, custody, block_hash, results[2 * i + 1], results[2 * i + 2])
                break
            except (ValueError, KeyError, TypeError, requests.RequestException) as exc:
                failure = exc
        else:
            raise ValueError("No canonical RPC confirmed the merge batch") from failure
    return sorted((p[0] for p in proofs), key=lambda event: (event["block"], event["logIndex"]))


def validate_history(events, issued, burned, live, max_level):
    require(issued == burned + live and len(events) == burned, "Merge coverage disagrees with NFT supply")
    levels = {}
    burns = {}
    positions = set()
    for event in events:
        survivor, donor, level = event["survivor"], event["donor"], event["level"]
        position = (event["block"], event["logIndex"])
        require(position not in positions and event["block"] > 0 and event["logIndex"] >= 0,
                f"Invalid or repeated log position {position}")
        require(1 <= survivor <= issued and 1 <= donor <= issued and survivor != donor,
                f"Invalid IDs at {position}")
        require(survivor not in burns and donor not in burns, f"Burned token was reused at {position}")
        require(2 <= level <= max_level and levels.get(survivor, 1) == levels.get(donor, 1) == level - 1,
                f"Missing or inconsistent merge ancestry at {position}")
        levels[survivor] = level
        burns[donor] = event["block"]
        positions.add(position)
    return burns


def token_art(url, collection, token_id, block):
    result = rpc(url, "eth_call", [
        {"to": collection, "data": f"0xc87b56dd{token_id:064x}"}, hex(block),
    ])
    raw = bytes.fromhex(result.removeprefix("0x"))
    require(len(raw) >= 64 and int.from_bytes(raw[:32], "big") == 32, "Malformed tokenURI return value")
    length = int.from_bytes(raw[32:64], "big")
    require(0 < length <= len(raw) - 64 and length <= 2_000_000, "Malformed tokenURI length")
    metadata = json.loads(decode_uri(raw[64:64 + length].decode(), "application/json"))
    name = f"Squeek #{token_id}"
    require(metadata["name"] == name, f"Expected {name}, got {metadata['name']}")
    svg = decode_uri(metadata["image"], "image/svg+xml")
    validate_svg(svg, name)
    palette = next((trait["value"] for trait in metadata.get("attributes", [])
                    if trait.get("trait_type") == "Palette"), None)
    return svg, palette


def fetch_portrait(token_id, burns, safe_block, collection, providers, staging):
    archived = token_id in burns
    block = burns[token_id] - 1 if archived else safe_block
    failures = []
    for url in providers:
        try:
            svg, palette = token_art(url, collection, token_id, block)
            break
        except (ValueError, KeyError, ElementTree.ParseError, requests.RequestException) as exc:
            failures.append(f"{url}: {exc}")
    else:
        raise ValueError(f"Unable to verify #{token_id} at {block}: {'; '.join(failures)}")
    (staging / f"{token_id}.svg").write_bytes(svg)
    result = {"file": f"art/{token_id}.svg", "block": block, "source": "archive" if archived else "chain",
              "sha256": hashlib.sha256(svg).hexdigest()}
    if palette:
        result["palette"] = palette
    return result


def refresh():
    snapshot = api("economy/state")
    collection = snapshot["identities"]["genesis"].lower()
    release = snapshot["release"]["id"]
    safe_block, block_hash = int(snapshot["chain"]["safeThroughBlock"]), snapshot["chain"]["safeBlockHash"]
    require(ADDRESS.fullmatch(collection) and HASH.fullmatch(block_hash), "Invalid deployment or block hash")
    issued, burned, live = (int(snapshot["nft"][key]) for key in ("issued", "burned", "live"))
    manifest = DIST / "data" / "archive.json"
    previous = None
    if manifest.exists():
        previous = json.loads(manifest.read_text(encoding="utf-8"))
        require(previous["collection"] == collection and previous["releaseId"] == release
                and previous["safeBlock"] <= safe_block, "Refusing a deployment change or older snapshot")
    utc_time(snapshot["chain"]["safeBlockTimestamp"])
    providers = canonical_providers(safe_block, block_hash, previous, snapshot["nft"],
                                    snapshot["chain"]["safeBlockTimestamp"])
    events = read_merges(snapshot, providers)
    burns = validate_history(events, issued, burned, live, int(snapshot["nft"]["maximumLevel"]))
    tokens = sorted(set(burns) | {event["survivor"] for event in events} | {1})
    print(f"Verified {len(events)} unique merges. Reading {len(tokens)} original tokenURIs.", flush=True)
    with tempfile.TemporaryDirectory(dir=ROOT, prefix=".refresh-") as temp_dir:
        staging = Path(temp_dir)
        def fetch(token_id):
            return fetch_portrait(token_id, burns, safe_block, collection, providers, staging)

        with ThreadPoolExecutor(max_workers=4) as pool:
            portraits = dict(zip(map(str, tokens), pool.map(fetch, tokens)))
        data = {
            "schemaVersion": 1, "chainId": CHAIN, "collection": collection, "releaseId": release,
            "asOf": snapshot["chain"]["safeBlockTimestamp"], "safeBlock": safe_block, "safeBlockHash": block_hash,
            "issued": issued, "burned": burned, "live": live, "events": events, "portraits": portraits,
        }
        staged_manifest = staging / "archive.json"
        staged_manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        manifest.parent.mkdir(parents=True, exist_ok=True)
        (DIST / "art").mkdir(parents=True, exist_ok=True)
        # Committed art is immutable. New images can appear before a manifest that references them.
        for portrait in portraits.values():
            target = DIST / portrait["file"]
            require(not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() == portrait["sha256"],
                    f"An existing original differs: {target.name}")
        for token in tokens:
            target = DIST / "art" / f"{token}.svg"
            if not target.exists():
                os.replace(staging / target.name, target)
        os.replace(staged_manifest, manifest)
    print(f"Saved block {safe_block}: {len(events)} merges, {len(portraits)} original portraits.")


if __name__ == "__main__":
    # A checkout has a single writer; the OS releases this lock even if the process is interrupted.
    with Path(__file__).open("rb") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                # Lock a byte beyond any script data, so another Python process can still read the file.
                lock.seek(1 << 30)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            sys.exit("Cannot acquire the archive refresh lock. Check for an active refresh.")
        refresh()
