"""Build a globe page from src/globe.src.html, the coastline data and one run.

usage: python tools/build.py [run json] [out html]   (default data/run-fable-5.json into globe.html)
"""
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
run = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "data" / "run-fable-5.json"
html = (root / "src" / "globe.src.html").read_text()
html = html.replace("__COAST__", (root / "data" / "coast.json").read_text().strip())
html = html.replace("__OBJECTS__", (root / "src" / "objects3d.js").read_text().strip())
html = html.replace("__RUN__", run.read_text().strip())
out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else root / "globe.html"
out.write_text(html)
print("built", out.name, "with", run.name)
