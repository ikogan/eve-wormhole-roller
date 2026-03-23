#!/usr/bin/env python3
"""Inline all CDN <script src="https://..."> tags into index.html.

Usage: python3 build-offline.py [output-filename]
Default output: eve-wormhole-roller.html
"""
import re, sys, urllib.request

output = sys.argv[1] if len(sys.argv) > 1 else 'eve-wormhole-roller.html'

with open('index.html', encoding='utf-8') as f:
    html = f.read()

def inline_script(match):
    url = match.group(1)
    print(f'  Fetching {url}', flush=True)
    with urllib.request.urlopen(url) as r:
        src = r.read().decode('utf-8')
    return f'<script>{src}</script>'

result = re.sub(
    r'<script src="(https://[^"]+)"></script>',
    inline_script,
    html,
)

with open(output, 'w', encoding='utf-8') as f:
    f.write(result)

print(f'{output} written ({len(result):,} bytes)', flush=True)
