"""Collect every English UI string shown by the tool JavaScript + the prose
headings from build.py, and write i18n/js/strings.json.

Translations live in i18n/js/<lang>.json as {"English string": "translation"};
build.py turns each into assets/i18n/<lang>.js (window.PDFORA_T).

    python3 extract_ui_strings.py
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
JS = ["assets/js/app.js", "assets/js/tools.js", "assets/js/editors.js"]
STR = r'"((?:[^"\\]|\\.)*)"'
PATTERNS = [
    r'\bT\(\s*' + STR,                       # T("…") / H.T("…")
    r'\bTF\(\s*' + STR,                      # TF("…{n}…")
    r'\b(?:cta|fileLabel|label|hint|placeholder|note)\s*:\s*' + STR,
    r'throw new Error\(\s*' + STR + r'\s*\)',
    r'ctx\.status\(\s*' + STR + r'\s*\)',
    r'comingSoon\(\s*' + STR + r'\s*\)',
]
# editors.js: WF_TOOLS names and uploader() prompts
EXTRA = [r'^\s*(?:"[\w-]+"|\w+)\s*:\s*' + STR, r'uploader\([^;]*?,\s*' + STR + r'\s*\)',
         r'"a PDF to (?:fill & sign|edit)"']
PY_HEADINGS = ["How it works", "When to use this tool", "Tips for the best results"]
# fallbacks written as T(x || "…") that the patterns above can't see
MANUAL = ["PDF files", "a PDF", "Something went wrong.", "Save failed", "Workflow failed",
          "Could not start conversion.", "e.g. 1-3, 4-6", "Pricing",
          "About", "Contact", "Privacy", "Terms", "Disclaimer", "Cookies", "Author",
          "beta", "soon", "online", "new"]

def keep(s):
    s = s.strip()
    return bool(s) and (re.search(r"[A-Za-z]{2,}", s) or s == "e.g. 1-3, 4-6") and not re.fullmatch(r"[\w./-]+\.(pdf|png|jpg|zip|txt)", s)

found = []
for f in JS:
    src = open(os.path.join(HERE, f), encoding="utf-8").read()
    for p in PATTERNS:
        found += re.findall(p, src)
    if f.endswith("editors.js"):
        wf = re.search(r"WF_TOOLS\s*=\s*\{(.*?)\};", src, re.S)
        if wf:
            found += re.findall(r':\s*' + STR, wf.group(1))
        found += re.findall(r'uploader\([^\n]*?' + STR + r'\s*\);', src)
        found += re.findall(r'"(a PDF to (?:fill & sign|edit|add form fields))"', src)
found += PY_HEADINGS + MANUAL
# build.py pages rendered through tp("…") / tj(code, "…")
_py = open(os.path.join(HERE, "build.py"), encoding="utf-8").read()
found += re.findall(r'\btp\(\s*' + STR, _py) + re.findall(r"\btj\(code,\s*'([^']+)'\)", _py) + re.findall(r'\btj\(code,\s*' + STR + r'\)', _py)
out, seen = [], set()
for s in found:
    s = bytes(s, "utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8") if "\\" in s else s
    if keep(s) and s not in seen:
        seen.add(s); out.append(s)
os.makedirs(os.path.join(HERE, "i18n/js"), exist_ok=True)
json.dump(out, open(os.path.join(HERE, "i18n/js/strings.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(out), "strings -> i18n/js/strings.json")
