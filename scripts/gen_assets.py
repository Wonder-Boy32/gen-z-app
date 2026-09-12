# -*- coding: utf-8 -*-
"""Generate GENZ brand assets: original jingle (WAV) + watermark wordmark (PNG)."""
import math, os, struct, wave, zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')
SR = 44100

# ---------------------------------------------------------------- jingle
def synth():
    n = int(SR * 2.4)
    buf = [0.0] * n

    def add(s, start, dur, fn, amp=1.0):
        i0 = int(start * SR)
        i1 = min(n, int((start + dur) * SR))
        for i in range(i0, i1):
            t = (i - i0) / SR
            buf[i] += fn(t) * amp

    def env_adsr(t, dur, a=0.008, d=0.25, s=0.55, r=0.35):
        if t < a: return t / a
        if t < a + d: return 1 - (1 - s) * ((t - a) / d)
        if t < dur - r: return s
        if t < dur: return s * (1 - (t - (dur - r)) / r)
        return 0.0

    def tone(f, t, dur, amp, harm=1.0, decay=None):
        e = env_adsr(t, dur) if decay is None else math.exp(-t * decay) if t < dur else 0.0
        return math.sin(2 * math.pi * f * t) * e * amp * harm

    # 0) sub drop + kick (t=0)
    add(0, 0.0, 0.5, lambda t: tone(52, t, 0.5, 1.0, decay=9))
    add(0, 0.0, 0.35, lambda t: tone(105, t, 0.35, 0.6, decay=14))

    # 1) riser whoosh 0.35 -> 1.15
    for i in range(60):
        tt = 0.35 + i * 0.013
        f = 220 * (2 ** (i / 60 * 2.2))
        add(tt, 0.0, 0.08, lambda t, f=f: tone(f, t, 0.08, 0.05, decay=22))

    # 2) three ascending pluck stabs (A4 C#5 E5 -> A5) at 0.55/0.78/1.01
    notes = [440.0, 554.37, 659.25, 880.0]
    for k, f in enumerate(notes):
        st = 0.55 + k * 0.23
        add(st, 0.0, 0.5, lambda t, f=f: (
            tone(f, t, 0.5, 0.22, decay=7)
            + tone(f * 2, t, 0.5, 0.05, decay=12)
            + tone(f * 1.5, t, 0.5, 0.03, decay=9)
        ))

    # 3) the logo hit at 1.35: bright chord + shimmer (A3 A4 E5 A5)
    st = 1.35
    chord = [220.0, 440.0, 659.25, 880.0]
    for f in chord:
        add(st, 0.0, 1.0, lambda t, f=f: tone(f, t, 1.0, 0.16, decay=3.2))
    for f in [1760.0, 2637.0]:
        add(st + 0.02, 0.0, 0.8, lambda t, f=f: tone(f, t, 0.8, 0.035, decay=5))
    add(st, 0.0, 0.9, lambda t: tone(110, t, 0.9, 0.5, decay=3.5))  # bass root

    # 4) tiny snare-ish tick right before hit (0.05s noise burst)
    import random
    random.seed(7)
    add(1.28, 0.0, 0.06, lambda t: (random.random() * 2 - 1) * (1 - t / 0.06) * 0.12)

    # soft limiter
    peak = max(1e-9, max(abs(x) for x in buf))
    g = min(1.0, 0.92 / peak)
    pcm = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, x * g)) * 32767)) for x in buf)
    with wave.open(os.path.join(OUT, 'genz_jingle.wav'), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    print('jingle: genz_jingle.wav %.2fs' % (n / SR))

# ------------------------------------------------------------ wordmark png
def png(path, w, h, px):
    raw = b''
    for y in range(h):
        raw += b'\x00' + b''.join(px[y][x] for x in range(w))
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))

def wordmark():
    from PIL import Image, ImageDraw, ImageFont
    cands = [r'C:\Windows\Fonts\arialbd.ttf', r'C:\Windows\Fonts\segoeuib.ttf', r'C:\Windows\Fonts\bahnschrift.ttf']
    fp = next((p for p in cands if os.path.exists(p)), None)
    font = ImageFont.truetype(fp, 220) if fp else ImageFont.load_default()
    text = 'GEN Z'
    # per-letter spacing for the letterSpacing brand look
    spacing = 46
    letter_w = [font.getbbox(c)[2] - font.getbbox(c)[0] + spacing for c in text]
    W = sum(letter_w) - spacing
    H = 300
    img = Image.new('RGBA', (W + 80, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 40
    asc = font.getmetrics()[0]
    for ch, lw in zip(text, letter_w):
        if ch == ' ':
            x += lw - spacing
            continue
        # soft dark shadow (offset) for contrast on any video
        d.text((x + 6, (H - asc) // 2 + 6), ch, font=font, fill=(0, 0, 0, 110))
        d.text((x, (H - asc) // 2), ch, font=font, fill=(255, 255, 255, 235))
        x += lw
    # trim transparent borders and save a real PNG
    bbox = img.getbbox()
    img = img.crop(bbox)
    img.save(os.path.join(OUT, 'wm-genz.png'))
    print('wordmark: wm-genz.png %dx%d' % img.size)

os.makedirs(OUT, exist_ok=True)
synth()
wordmark()
