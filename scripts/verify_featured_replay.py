"""Read-only check of the featured replay against two Sepolia archive nodes."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from pathlib import Path

from refresh_archive import CHAIN, COLLECTION, RPCS, STAKING, confirm_merge, rpc, token_art


SITE = Path(__file__).resolve().parents[1] / "dist"
BLOCK, LOG = 12076748, 87
TX = "0xe2035a8e291cc04c0c4c6f3c7598190022205d0fb65345e7f8074f32e0dcdb85"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def verify(node, event):
    if int(rpc(node, "eth_chainId", []), 16) != CHAIN:
        raise ValueError("Wrong network")
    header = rpc(node, "eth_getBlockByNumber", [hex(BLOCK), False])
    previous = rpc(node, "eth_getBlockByNumber", [hex(BLOCK - 1), False])
    if header["parentHash"] != previous["hash"] or int(previous["number"], 16) != BLOCK - 1:
        raise ValueError("Discontinuous blocks")
    receipt = rpc(node, "eth_getTransactionReceipt", [TX])
    log, = (item for item in receipt["logs"] if int(item["logIndex"], 16) == LOG)
    custody = "staking" if log["address"].lower() == STAKING else "wallet"
    confirm_merge(event, custody, header["hash"], receipt, header)
    burns = [item for item in receipt["logs"] if item["address"].lower() == COLLECTION
             and len(item["topics"]) == 4 and item["topics"][0].lower() == TRANSFER
             and int(item["topics"][2], 16) == 0 and int(item["topics"][3], 16) == 7453]
    if len(burns) != 1:
        raise ValueError("Missing donor burn")
    evidence = {}
    for token, height in [(7453, BLOCK - 1), (7458, BLOCK - 1), (7458, BLOCK)]:
        art, _ = token_art(node, COLLECTION, token, height)
        if art != (SITE / "current-art" / f"{token}.svg").read_bytes():
            raise ValueError(f"Portrait differs for #{token} at {height}")
        evidence[f"{token}@{height}"] = sha256(art).hexdigest()
    return {"blockHash": header["hash"], "burnLog": int(burns[0]["logIndex"], 16), "art": evidence}


if __name__ == "__main__":
    seed = json.loads((SITE / "data/current.json").read_bytes())
    event, = (e for e in seed["events"] if e["block"] == BLOCK and e["logIndex"] == LOG)
    if (event["tx"], event["survivor"], event["donor"], event["level"]) != (TX, 7458, 7453, 2):
        raise ValueError("Wrong featured event")
    with ThreadPoolExecutor(max_workers=len(RPCS)) as pool:
        results = list(pool.map(lambda node: verify(node, event), RPCS))
    if any(r != results[0] for r in results):
        raise ValueError("Archive providers disagree")
    print(f"Matched {len(results)} independent nodes: {json.dumps(results[0])}")
