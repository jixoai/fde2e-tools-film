#!/usr/bin/env python3
"""Audit every compositor frame saved by export-flicker-check.mjs (requires Pillow).

Usage: python3 scripts/export-flicker-audit.py /tmp/film-flicker-evidence
This measures browser compositor output, not the operating system's display.
The dark fixture must never become >80% near-white (all RGB channels >=235).
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

root = Path(sys.argv[1])
frames = json.loads((root / 'visual-frames.json').read_text())
result = json.loads((root / 'result.json').read_text())
audit = {}
for target in ['editor', 'surface']:
    group = [frame for frame in frames if frame['target'] == target]
    assert group, f'{target}: no continuous visual evidence'
    whites = []
    blacks = []
    for frame in group:
        with Image.open(root / frame['file']) as original:
            image = original.convert('RGB').resize((80, 45))
        red, green, blue = image.split()
        darkest = ImageChops.darker(ImageChops.darker(red, green), blue)
        lightest = ImageChops.lighter(ImageChops.lighter(red, green), blue)
        if sum(darkest.histogram()[235:]) / 3600 > .8:
            whites.append(frame['file'])
        if sum(lightest.histogram()[:16]) / 3600 > .99:
            blacks.append(frame['file'])
    audit[target] = dict(observedFrames=len(group), whiteFrames=whites, blackFrames=blacks,
                         firstTime=group[0]['t'], lastTime=group[-1]['t'])
    sheet = Image.new('RGB', (960, 800), (25, 25, 27))
    draw = ImageDraw.Draw(sheet)
    for index in range(12):
        frame = group[round(index * (len(group) - 1) / 11)]
        with Image.open(root / frame['file']) as original:
            image = original.convert('RGB')
            image.thumbnail((320, 180))
        x, y = index % 3 * 320, index // 3 * 200
        sheet.paste(image, (x, y))
        draw.text((x + 4, y + 182), Path(frame['file']).name, fill='white')
    sheet.save(root / f'{target}-sheet.jpg')
audit['visualDropped'] = result.get('visualDropped', 0)
(root / 'visual-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
print(json.dumps(audit, indent=2))
assert audit['visualDropped'] == 0, 'recording was truncated'
assert all(not audit[target]['whiteFrames'] for target in ['editor', 'surface']), 'white flash detected'
assert not audit['editor']['blackFrames'], 'editor became blank'
