"""Build globe.html from src/globe.src.html, the coastline data and one run.

usage: python tools/build.py [run json]   (default data/run-reference-9.json)
"""
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
run = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "data" / "run-reference-9.json"
html = (root / "src" / "globe.src.html").read_text()
html = html.replace("__COAST__", (root / "data" / "coast.json").read_text().strip())
html = html.replace("__RUN__", run.read_text().strip())
(root / "globe.html").write_text(html)
print("built globe.html with", run.name)
