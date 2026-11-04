import base64
import hashlib
import json
import sys
import unittest
from pathlib import Path
from urllib.parse import quote_from_bytes
from xml.etree.ElementTree import ParseError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from svg_validation import decode_uri, validate_svg

CASES = json.loads((ROOT / "tests/svg-cases.json").read_text(encoding="utf-8"))


class SvgSafety(unittest.TestCase):
    def test_legitimate_originals_keep_their_bytes(self):
        manifest = json.loads((ROOT / "dist/data/archive.json").read_text(encoding="utf-8"))
        expected_files = {f"{token}.svg" for token in manifest["portraits"]}
        self.assertEqual({p.name for p in (ROOT / "dist/art").iterdir()}, expected_files)
        for token, record in manifest["portraits"].items():
            self.assertEqual(record["file"], "art/" + token + ".svg")
            original = (ROOT / "dist" / record["file"]).read_bytes()
            validate_svg(original, "Squeek #" + token)
            self.assertEqual(hashlib.sha256(original).hexdigest(), record["sha256"])
        valid = CASES["valid"].encode()
        for uri in ["data:image/svg+xml;base64," + base64.b64encode(valid).decode(),
                    "data:image/svg+xml;charset=utf-8," + quote_from_bytes(valid)]:
            self.assertEqual(decode_uri(uri, "image/svg+xml"), valid)
            validate_svg(decode_uri(uri, "image/svg+xml"), "Squeek #42")

    def test_rejects_active_xml_and_alternate_encodings(self):
        for fragment in CASES["invalid"]:
            svg = (fragment.replace("@SVG@", CASES["valid"]) if "@SVG@" in fragment
                   else CASES["valid"].replace("</svg>", fragment + "</svg>"))
            for encoding in ("utf-8", "utf-16", "utf-16-le", "utf-16-be"):
                with self.subTest(fragment=fragment, encoding=encoding), self.assertRaises((ValueError, ParseError)):
                    validate_svg(svg.encode(encoding), "Squeek #42")
        with self.assertRaises(ValueError):
            decode_uri("data:image/svg+xml;charset=utf-16,%3Csvg/%3E", "image/svg+xml")


if __name__ == "__main__":
    unittest.main()
