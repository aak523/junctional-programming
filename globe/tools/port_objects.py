"""Port the 3D object modules from the viz app (viz/*3d.js) into src/objects3d.js.

The viz app is ES modules on three r169; the globe is one classic-script page on three r128.
Each module becomes a function scope that returns its exports, under one global, OBJ3D:
OBJ3D.vendor.Vendor, OBJ3D.campus.STATUS and so on. Imports between modules are rebound
from the modules already ported, so the order below matters.

usage: python tools/port_objects.py [git ref]   (default origin/viz-state-objects)
"""
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
ref = sys.argv[1] if len(sys.argv) > 1 else "origin/viz-state-objects"
MODULES = ["theme3d", "campus3d", "vendor3d", "broker3d", "power3d", "spot3d", "contract3d"]

out = ["/* Ported from viz/*3d.js at %s by tools/port_objects.py. Do not edit by hand. */" % ref,
       "const OBJ3D = {};"]
for name in MODULES:
    src = subprocess.run(["git", "show", f"{ref}:viz/{name}.js"], cwd=root, check=True,
                         capture_output=True, text=True).stdout
    key = name.removesuffix("3d")
    exports = re.findall(r"^export\s+(?:const|let|class|function)\s+(\w+)", src, flags=re.M)
    lines = []
    for line in src.splitlines():
        m = re.match(r"^import\s+\{([^}]*)\}\s+from\s+'\./(\w+)3d\.js';", line)
        if m:
            lines.append(f"const {{{m.group(1)}}} = OBJ3D.{m.group(2)};")
            continue
        if re.match(r"^import\s", line):
            continue   # three itself is the global THREE
        lines.append(re.sub(r"^export\s+", "", line))
    out.append(f"OBJ3D.{key} = (() => {{")
    out.extend(lines)
    out.append(f"return {{ {', '.join(exports)} }};")
    out.append("})();")

(root / "src" / "objects3d.js").write_text("\n".join(out) + "\n")
print("ported", ", ".join(MODULES), "from", ref)
