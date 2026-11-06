"""Refresh the read-only Sepolia album. Requires Python 3.10+ and requests."""

import hashlib
import json
import os
import re
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from svg_validation import decode_uri, validate_svg


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
API = "https://api.squeekchain.com/v1"
RPCS = ("https://sepolia.gateway.tenderly.co", "https://rpc.sepolia.ethpandaops.io")
CHAIN = 11155111
HASH = re.compile(r"0x[0-9a-fA-F]{64}")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
RELEASE = "core-sepolia-20261103"
COLLECTION = "0xc4c7982657f00509548f3a3a41db7fa439a6856b"
STAKING = "0x50fd1780526c3186a0c037c7622203bc4fb611ca"
ZERO_BURN_BLOCK = 12067109  # First published checkpoint of this deployment.
TOPICS = {
    "wallet": "0x8a9b1a009a32cc0082d2270e9033429b8e1aa3235e7b8198b013f603116a3c87",
    "staking": "0x47dc7fa0b474cf75263255e0530e84606f909e3099ad0d06bd67883467333339",
}
UTC_TIME = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z")
_connections = threading.local()


def session():
    if not hasattr(_connections, "client"):
        client = requests.Session()
        # All RPC POSTs in this script are reads. Retry transient provider failures only.
        retry = Retry(total=2, backoff_factor=0.5, status_forcelist=(429, 502, 503, 504),
                      allowed_methods={"GET", "POST"}, respect_retry_after_header=False)
        client.mount("https://", HTTPAdapter(max_retries=retry))
        _connections.client = client
    return _connections.client


def require(condition, message):
    if not condition:
        raise ValueError(message)


def api(path, params=None):
    response = session().get(f"{API}/{path}", params=params, timeout=30)
    response.raise_for_status()
    data = response.json()
    require(data.get("status") == "available", f"{path}: {data.get('reason', 'unavailable')}")
    require(data["chain"]["target"] == "sepolia" and int(data["chain"]["chainId"]) == CHAIN,
            f"{path}: wrong chain")
    deployment = data["deployment"]
    require(data["schemaVersion"] == {"economy/state": 3, "events": 4}[path]
            and data["release"]["id"] == deployment["releaseId"] == RELEASE
            and deployment["target"] == "sepolia" and int(deployment["chainId"]) == CHAIN
            and deployment["components"]["collection"]["address"].lower() == COLLECTION
            and deployment["components"]["staking"]["address"].lower() == STAKING,
            f"{path}: unsupported deployment or API schema")
    return data


def rpc(url, method, params):
    response = session().post(url, timeout=25, json={
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


def rpc_batch(url, calls):
    response = session().post(url, json=[
        {"jsonrpc": "2.0", "id": i, "method": method, "params": params}
        for i, (method, params) in enumerate(calls, 1)
    ], timeout=45)
    response.raise_for_status()
    replies = response.json()
    require(isinstance(replies, list) and len(replies) == len(calls), "Incomplete RPC batch")
    by_id = {r["id"]: r for r in replies}
    values = []
    for i, (method, _) in enumerate(calls, 1):
        reply = by_id.get(i, {})
        error = reply.get("error") or {}
        code = error.get("code") if isinstance(error, dict) else None
        require(reply.get("jsonrpc") == "2.0" and reply.get("result") is not None and not error,
                f"{method} returned no verified data (RPC code {code if isinstance(code, int) else 'unknown'})")
        values.append(reply["result"])
    return values


def read_merges(snapshot, providers=None, previous=None):
    release = snapshot["release"]["id"]
    collection = snapshot["deployment"]["components"]["collection"]["address"].lower()
    staking = snapshot["deployment"]["components"]["staking"]["address"].lower()
    safe_block = int(snapshot["chain"]["safeThroughBlock"])
    require((release, collection, staking) == (RELEASE, COLLECTION, STAKING), "Unrecognized merge deployment")
    if providers is None:
        providers = canonical_providers(safe_block, snapshot["chain"]["safeBlockHash"], counts=snapshot["nft"],
                                        as_of=snapshot["chain"]["safeBlockTimestamp"])
    events = {}
    cursors = set()
    prior_events = previous["events"] if previous else []
    boundary = previous["safeBlock"] if previous else 0
    missing = int(snapshot["nft"]["burned"]) - len(prior_events)
    require(missing >= 0, "Burn count went backwards")
    params = {"category": "players", "limit": 100}
    while len(events) < missing:
        page = api("events", params)
        for event in page["events"]:
            if event["type"] != "nft.merged":
                continue
            source, payload = event["source"], event["payload"]
            block = int(source["blockNumber"])
            if block > safe_block or block <= boundary:
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
    require(len(proofs) == missing, "Event feed does not cover the onchain burn count")
    return prior_events + verified_events(proofs, providers)


def block_time(header):
    return datetime.fromtimestamp(int(header["timestamp"], 16), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def receipt_event(proof, receipt, header):
    item, custody, block_hash = proof
    if custody is not None:
        confirm_merge(item, custody, block_hash, receipt, header)
        return item
    # Every burn emits the collection event. Staking also emits a wrapper event;
    # use its log index when present so shared stage links agree with the player feed.
    item = {**item, "at": block_time(header)}
    confirm_merge(item, "wallet", block_hash, receipt, header)
    wrappers = []
    for log in receipt["logs"]:
        topics, data = log.get("topics", []), log.get("data", "")
        if (log["address"].lower() == STAKING and len(topics) == 4 and topics[0].lower() == TOPICS["staking"]
                and int(topics[2], 16) == int(COLLECTION, 16) and int(topics[3], 16) == item["survivor"]
                and len(data) == 194 and int(data[2:66], 16) == item["donor"]):
            wrappers.append(int(log["logIndex"], 16))
    require(len(wrappers) <= 1, "Ambiguous staking event")
    if wrappers:
        item = {**item, "logIndex": wrappers[0]}
        confirm_merge(item, "staking", block_hash, receipt, header)
    return item


def verified_events(proofs, providers):

    def verify_group(group):
        calls = []
        for item, _, _ in group:
            for method, params in (("eth_getTransactionReceipt", [item["tx"]]),
                                   ("eth_getBlockByNumber", [hex(item["block"]), False])):
                calls.append((method, params))
        failure = None
        for endpoint in providers:
            try:
                results = rpc_batch(endpoint, calls)
                return [receipt_event(proof, results[2 * i], results[2 * i + 1]) for i, proof in enumerate(group)]
            except (ValueError, KeyError, TypeError, requests.RequestException) as exc:
                failure = exc
        if len(group) > 1:
            middle = len(group) // 2
            return verify_group(group[:middle]) + verify_group(group[middle:])
        item = group[0][0]
        raise ValueError(f"No canonical RPC confirmed {item['tx']} at block {item['block']}: {failure}") from failure

    print(f"Verifying {len(proofs)} new merge receipts.", flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        groups = pool.map(verify_group, (proofs[i:i + 8] for i in range(0, len(proofs), 8)))
        return sorted((event for group in groups for event in group), key=lambda e: (e["block"], e["logIndex"]))


def chain_snapshot():
    for endpoint in RPCS:
        try:
            header, network = rpc_batch(endpoint, [("eth_getBlockByNumber", ["finalized", False]), ("eth_chainId", [])])
            require(int(network, 16) == CHAIN and HASH.fullmatch(header["hash"]), "Invalid finalized Sepolia block")
            block = header["number"]
            counts = rpc_batch(endpoint, [("eth_call", [{"to": COLLECTION, "data": selector}, block])
                                          for selector in ("0x18160ddd", "0xd89135cd")])
            require(all(HASH.fullmatch(n) for n in counts), "Invalid contract supply")
            live, burned = [int(n, 16) for n in counts]
            require(live + burned == 9999, "Unexpected issued supply for the pinned collection")
            return {
                "release": {"id": RELEASE},
                "deployment": {"components": {"collection": {"address": COLLECTION}, "staking": {"address": STAKING}}},
                "chain": {"safeThroughBlock": int(block, 16), "safeBlockHash": header["hash"],
                          "safeBlockTimestamp": block_time(header)},
                "nft": {"issued": live + burned, "live": live, "burned": burned, "maximumLevel": 10},
            }
        except (ValueError, KeyError, TypeError, requests.RequestException):
            continue
    raise ValueError("No archive RPC returned a finalized block and matching collection supply")


def read_chain_merges(snapshot, providers, previous):
    through = int(snapshot["chain"]["safeThroughBlock"])
    start = previous["safeBlock"] if previous else ZERO_BURN_BLOCK
    prior_events = previous["events"] if previous else []
    expected = int(snapshot["nft"]["burned"]) - len(prior_events)
    require(expected >= 0 and through >= start, "Chain checkpoint moved backwards")
    if not expected:
        return prior_events
    events = {}
    for first in range(start + 1, through + 1, 1024):
        last = min(first + 1023, through)
        query = {"address": COLLECTION, "topics": [TOPICS["wallet"]], "fromBlock": hex(first), "toBlock": hex(last)}
        for endpoint in providers:
            try:
                logs = rpc(endpoint, "eth_getLogs", [query])
                require(isinstance(logs, list), "Invalid collection log response")
                break
            except (ValueError, KeyError, TypeError, requests.RequestException):
                continue
        else:
            raise ValueError(f"Unable to read collection logs at blocks {first} to {last}")
        for log in logs:
            topics, data = log["topics"], log["data"]
            block, pos = int(log["blockNumber"], 16), int(log["logIndex"], 16)
            tx, block_hash = log["transactionHash"].lower(), log["blockHash"].lower()
            require(not log.get("removed") and log["address"].lower() == COLLECTION
                    and len(topics) == 3 and topics[0].lower() == TOPICS["wallet"] and all(HASH.fullmatch(t) for t in topics)
                    and re.fullmatch(r"0x[\da-fA-F]{128}", data) and first <= block <= last and pos >= 0
                    and HASH.fullmatch(tx) and HASH.fullmatch(block_hash), "Unexpected collection log")
            item = {"survivor": int(topics[1], 16), "donor": int(topics[2], 16), "level": int(data[2:66], 16),
                    "block": block, "logIndex": pos, "tx": tx}
            key = (tx, pos)
            proof = (item, None, block_hash)
            require(key not in events or events[key] == proof, "Conflicting collection logs")
            events[key] = proof
    require(len(events) == expected, "Collection logs do not match the onchain burn count")
    return prior_events + verified_events(list(events.values()), providers)


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


def art_params(collection, token_id, block):
    return [{"to": collection, "data": f"0xc87b56dd{token_id:064x}"}, hex(block)]


def token_art(url, collection, token_id, block):
    return decode_art(rpc(url, "eth_call", art_params(collection, token_id, block)), token_id)


def decode_art(result, token_id):
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
    return svg, palette if isinstance(palette, str) else None


def fetch_portraits(tokens, burns, safe_block, collection, providers, staging):
    blocks = [burns[i] - 1 if i in burns else safe_block for i in tokens]
    calls = [("eth_call", art_params(collection, i, block)) for i, block in zip(tokens, blocks)]
    error = None
    for url in providers:
        try:
            results = rpc_batch(url, calls)
            images = [decode_art(value, i) for value, i in zip(results, tokens)]
            break
        except (ValueError, KeyError, TypeError, ElementTree.ParseError, requests.RequestException) as exc:
            error = exc
    else:
        if len(tokens) == 1:
            raise ValueError(f"Unable to verify #{tokens[0]} at {blocks[0]}") from error
        # Some archive nodes cap the size of a batch response.
        records = {}
        for token in tokens:
            records.update(fetch_portraits([token], burns, safe_block, collection, providers, staging))
        return records
    records = {}
    for i, block, (svg, palette) in zip(tokens, blocks, images):
        (staging / f"{i}.svg").write_bytes(svg)
        record = {"file": f"current-art/{i}.svg", "block": block, "source": "archive" if i in burns else "chain",
                  "sha256": hashlib.sha256(svg).hexdigest()}
        if palette:
            record["palette"] = palette
        records[str(i)] = record
    return records


def cached_portrait(previous, token, burns):
    record = previous["portraits"].get(str(token)) if previous else None
    filename = f"current-art/{token}.svg"
    if not record:
        return None
    require(record["file"] == filename and 0 < record["block"] <= previous["safeBlock"], "Invalid cached portrait")
    raw = (DIST / filename).read_bytes()
    require(hashlib.sha256(raw).hexdigest() == record["sha256"], "Cached portrait digest differs")
    if token in burns:
        return record if record["source"] == "archive" and record["block"] == burns[token] - 1 else None
    require(record["source"] == "chain", "Unexpected cached burn")
    return record


def refresh(onchain=False):
    snapshot = chain_snapshot() if onchain else api("economy/state")
    collection = snapshot["deployment"]["components"]["collection"]["address"].lower()
    release = snapshot["release"]["id"]
    safe_block, block_hash = int(snapshot["chain"]["safeThroughBlock"]), snapshot["chain"]["safeBlockHash"]
    require(ADDRESS.fullmatch(collection) and HASH.fullmatch(block_hash), "Invalid deployment or block hash")
    issued, burned, live = (int(snapshot["nft"][key]) for key in ("issued", "burned", "live"))
    manifest = DIST / "data" / "current.json"
    previous = None
    if manifest.exists():
        previous = json.loads(manifest.read_text(encoding="utf-8"))
        require(previous["schemaVersion"] == 1 and previous["chainId"] == CHAIN
                and previous["collection"] == collection and previous["releaseId"] == release, "Deployment changed")
        validate_history(previous["events"], previous["issued"], previous["burned"], previous["live"], 10)
        if onchain and previous["safeBlock"] > safe_block:
            canonical_providers(previous["safeBlock"], previous["safeBlockHash"], counts=previous, as_of=previous["asOf"])
            print("Finality has not reached the previous verified checkpoint yet.")
            return
        require(previous["safeBlock"] <= safe_block, "Refusing an older snapshot")
    utc_time(snapshot["chain"]["safeBlockTimestamp"])
    providers = canonical_providers(safe_block, block_hash, previous, snapshot["nft"],
                                    snapshot["chain"]["safeBlockTimestamp"])
    events = (read_chain_merges if onchain else read_merges)(snapshot, providers, previous)
    burns = validate_history(events, issued, burned, live, int(snapshot["nft"]["maximumLevel"]))
    tokens = sorted(set(burns) | {event["survivor"] for event in events} | {1, 8923, 7453, 7458})
    portraits = {}
    missing = []
    for token in tokens:
        record = cached_portrait(previous, token, burns)
        if record is None:
            missing.append(token)
        else:
            portraits[str(token)] = record
    if previous and not missing and previous["events"] == events and previous["issued"] == issued:
        print(f"No new merges. Retaining verified checkpoint {previous['safeBlock']}.", flush=True)
        return
    print(f"Verified {len(events)} unique merges. Reading {len(missing)} original tokenURIs; reusing {len(portraits)}.", flush=True)
    with tempfile.TemporaryDirectory(dir=ROOT, prefix=".refresh-") as temp_dir:
        staging = Path(temp_dir)
        def fetch(group):
            return fetch_portraits(group, burns, safe_block, collection, providers, staging)

        with ThreadPoolExecutor(max_workers=4) as pool:
            for n, group in enumerate(pool.map(fetch, (missing[i:i + 6] for i in range(0, len(missing), 6))), 1):
                portraits.update(group)
                if n % 25 == 0:
                    print(f"  verified {n * 6}/{len(missing)} new portraits", flush=True)
        data = {
            "schemaVersion": 1, "chainId": CHAIN, "collection": collection, "releaseId": release,
            "asOf": snapshot["chain"]["safeBlockTimestamp"], "safeBlock": safe_block, "safeBlockHash": block_hash,
            "issued": issued, "burned": burned, "live": live, "events": events,
            "portraits": {str(i): portraits[str(i)] for i in tokens},
        }
        staged_manifest = staging / "archive.json"
        staged_manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        manifest.parent.mkdir(parents=True, exist_ok=True)
        (DIST / "current-art").mkdir(parents=True, exist_ok=True)
        # Committed art is immutable. New images can appear before a manifest that references them.
        for token in missing:
            portrait = portraits[str(token)]
            target = DIST / portrait["file"]
            require(not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() == portrait["sha256"],
                    f"An existing original differs: {target.name}")
        for token in missing:
            target = DIST / "current-art" / f"{token}.svg"
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
        if sys.argv[1:] not in ([], ["--onchain"]):
            sys.exit("Usage: refresh_archive.py [--onchain]")
        refresh(onchain=bool(sys.argv[1:]))
