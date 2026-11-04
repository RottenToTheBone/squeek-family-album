"""Validate the passive UTF-8 artwork stored and served by the album."""
import base64
import re
from urllib.parse import unquote_to_bytes
from xml.etree import ElementTree

SVG = "{http://www.w3.org/2000/svg}"
ELEMENTS = set("svg title desc metadata defs g path rect circle ellipse polygon polyline line symbol use".split())
ATTRIBUTES = set(("id fill stroke stroke-width x y x1 x2 y1 y2 cx cy r rx ry width height aria-label opacity "
                  "href role color transform d points viewBox fill-rule").split())
PAINT = re.compile(r"none|currentColor|#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})", re.I | re.ASCII)


def decode_uri(uri, media_type):
    header, separator, body = uri.partition(",")
    if not separator or not re.fullmatch("data:" + re.escape(media_type) + r"(?:;charset=utf-8)?(?:;base64)?", header.lower()):
        raise ValueError(f"Expected UTF-8 {media_type}")
    if header.lower().endswith(";base64"):
        return base64.b64decode(body, validate=True)
    if re.search(r"%(?![a-fA-F0-9]{2})", body):
        raise ValueError("Invalid percent encoding")
    return unquote_to_bytes(body)


def validate_svg(svg, name):
    if not 0 < len(svg) <= 1_000_000:
        raise ValueError("Invalid SVG size")
    text = svg.decode("utf-8-sig", errors="strict")
    if "\0" in text or "<!" in text or "<?" in text:
        raise ValueError("Unexpected XML markup")
    root = ElementTree.fromstring(text)
    if root.tag != SVG + "svg" or root.findtext(SVG + "title") != name:
        raise ValueError("Wrong SVG token title")
    for element in root.iter():
        if not element.tag.startswith(SVG) or element.tag[len(SVG):] not in ELEMENTS:
            raise ValueError("Unexpected SVG element")
        for key, value in element.attrib.items():
            if key not in ATTRIBUTES or "\\" in value or re.search(r"url\s*\(", value, re.I):
                raise ValueError("Unexpected SVG attribute")
            if key in {"fill", "stroke", "color"} and not PAINT.fullmatch(value):
                raise ValueError("Unexpected SVG paint")
            if key == "href" and not re.fullmatch(r"#[A-Za-z0-9_.:-]+", value):
                raise ValueError("External SVG reference")
