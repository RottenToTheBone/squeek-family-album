"""Refresh the read-only Sepolia album. Requires Python 3.10+ and requests."""

import base64
import hashlib
import json
import os
import re
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote_to_bytes
from xml.etree import ElementTree

import requests


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
API = "https://api.squeekchain.com/v1"
RPCS = ("https://sepolia.gateway.tenderly.co", "https://rpc.sepolia.ethpandaops.io")
CHAIN = 11155111
HASH = re.compile(r"0x[0-9a-fA-F]{64}")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
SVG_NS = "{http://www.w3.org/2000/svg}"


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


def canonical_providers(block, block_hash):
    providers = []
    for url in RPCS:
        try:
            require(int(rpc(url, "eth_chainId", []), 16) == CHAIN, "wrong RPC chain")
            header = rpc(url, "eth_getBlockByNumber", [hex(block), False])
            require(header["hash"].lower() == block_hash.lower(), "safe block hash differs")
            providers.append(url)
        except (ValueError, KeyError, requests.RequestException) as exc:
            print(f"Skipping {url}: {exc}", file=sys.stderr)
    require(providers, "No archive provider agrees with the official safe block")
    return providers


def read_merges(snapshot):
    release = snapshot["release"]["id"]
    collection = snapshot["identities"]["genesis"].lower()
    staking = snapshot["identities"]["staking"]["proxy"].lower()
    safe_block = int(snapshot["chain"]["safeThroughBlock"])
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
            datetime.fromisoformat(item["at"].replace("Z", "+00:00"))
            key = (tx, item["logIndex"])
            require(key not in events or events[key] == item, "Conflicting duplicate event")
            events[key] = item
        cursor = page["nextCursor"]
        if cursor is None:
            break
        require(cursor and cursor not in cursors, "Repeated or empty event cursor")
        cursors.add(cursor)
        params["cursor"] = cursor
    return sorted(events.values(), key=lambda event: (event["block"], event["logIndex"]))


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


def decode_uri(uri, media_type):
    header, separator, body = uri.partition(",")
    require(separator and header.split(";")[0].lower() == "data:" + media_type, f"Expected {media_type}")
    return base64.b64decode(body, validate=True) if ";base64" in header.lower() else unquote_to_bytes(body)


def validate_svg(svg, name):
    require(0 < len(svg) <= 1_000_000 and b"<!" not in svg and b"<?" not in svg, "Invalid SVG document")
    root = ElementTree.fromstring(svg)
    require(root.tag == SVG_NS + "svg" and root.findtext(SVG_NS + "title") == name, "Wrong SVG token title")
    elements = {"svg", "title", "desc", "metadata", "defs", "g", "path", "rect", "circle", "ellipse",
                "polygon", "polyline", "line", "symbol", "use"}
    attributes = {"id", "fill", "stroke", "stroke-width", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy",
                  "r", "rx", "ry", "width", "height", "aria-label", "opacity", "href", "role", "color",
                  "transform", "d", "points", "viewBox", "fill-rule"}
    for element in root.iter():
        require(element.tag.startswith(SVG_NS) and element.tag[len(SVG_NS):] in elements,
                f"Unexpected SVG element {element.tag}")
        for key, value in element.attrib.items():
            require(key in attributes and "url(" not in value.lower(), f"Unexpected SVG attribute {key}")
            if key == "href":
                require(re.fullmatch(r"#[A-Za-z0-9_.:-]+", value), "External SVG reference")


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
    if manifest.exists():
        previous = json.loads(manifest.read_text(encoding="utf-8"))
        require(previous["collection"] == collection and previous["releaseId"] == release
                and previous["safeBlock"] <= safe_block, "Refusing a deployment change or older snapshot")
    providers = canonical_providers(safe_block, block_hash)
    events = read_merges(snapshot)
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
