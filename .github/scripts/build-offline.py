#!/usr/bin/env python3
"""Inline all external CSS and JS into index.html to produce a single self-contained file.

Local <link rel="stylesheet" href="..."> → <style>...</style>
Local <script src="...">                 → <script>...</script>
CDN  <script src="https://...">         → <script>...</script>  (fetched over HTTP)
data/wormhole-types.json                → window.WH_TYPE_DATA = [...] inline script

Usage: python3 build-offline.py [output-filename]
Default output: eve-wormhole-roller.html
"""
import re, sys, json, urllib.request
from pathlib import Path

output = sys.argv[1] if len(sys.argv) > 1 else 'eve-wormhole-roller.html'

with open('index.html', encoding='utf-8') as f:
    html = f.read()

def inline_local_css(match):
    path = match.group(1)
    print(f'  Inlining {path}', flush=True)
    src = Path(path).read_text(encoding='utf-8')
    return f'<style>\n{src}\n</style>'

def inline_local_js(match):
    path = match.group(1)
    print(f'  Inlining {path}', flush=True)
    src = Path(path).read_text(encoding='utf-8')
    return f'<script>\n{src}\n</script>'

def inline_cdn_script(match):
    url = match.group(1)
    print(f'  Fetching {url}', flush=True)
    with urllib.request.urlopen(url) as r:
        src = r.read().decode('utf-8')
    return f'<script>{src}</script>'

# Inline local stylesheets
result = re.sub(
    r'<link rel="stylesheet" href="([^"]+)">',
    inline_local_css,
    html,
)

# Inline local scripts (non-CDN)
result = re.sub(
    r'<script src="(?!https://)([^"]+)"></script>',
    inline_local_js,
    result,
)

# Inline CDN scripts
result = re.sub(
    r'<script src="(https://[^"]+)"></script>',
    inline_cdn_script,
    result,
)

# Embed wormhole type data as a global variable (replaces fetch from data/wormhole-types.json)
wh_types_path = Path('data/wormhole-types.json')
if wh_types_path.exists():
    print(f'  Embedding {wh_types_path}', flush=True)
    wh_types = json.loads(wh_types_path.read_text(encoding='utf-8'))
    wh_json = json.dumps(wh_types, separators=(',', ':'))
    wh_script = f'<script>window.WH_TYPE_DATA={wh_json};</script>'
    # Insert before </head>
    result = result.replace('</head>', f'{wh_script}\n</head>', 1)
else:
    print(f'  WARNING: {wh_types_path} not found — wormhole type data will not be embedded', flush=True)

with open(output, 'w', encoding='utf-8') as f:
    f.write(result)

print(f'{output} written ({len(result):,} bytes)', flush=True)
