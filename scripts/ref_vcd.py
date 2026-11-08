#!/usr/bin/env python3
"""Reference VCD reader for the tests and the real VS Code gate. Written separately from the JS parser.

usage: python3 -I scripts/ref_vcd.py FILE --times 0,15,100 [--paths a.b,c.d] [--list]
Prints JSON: {"paths": {path: [value at each time, ...]}, "end": last time, "vars": n}
A value is the last change at or before the time ("0", "1", "x", "z", a bit string, a float or a string),
or null when the signal has no value yet. Rules match the viewer: time that goes back stays at the
latest time; a change cut off at the end of the file is left out. Streams the file line by line.
"""
import json, re, sys


def main():
    a = sys.argv[1:]
    path = a[0]
    times = [int(x) for x in a[a.index('--times') + 1].split(',')] if '--times' in a else []
    want = a[a.index('--paths') + 1].split(',') if '--paths' in a else None
    f = open(path, 'r', encoding='latin-1', newline='')
    # ---- header ----
    scopes = [('', -1)]  # (path, parent)
    children = {}
    cur = 0
    seen = {}
    vars_ = []  # (path, code, size, kind)
    toks = []
    pending_header = True
    rest = ''
    def tokens_gen():
        for line in f:
            for t in line.split():
                yield t
    gen = tokens_gen()

    def collect():
        out = []
        for t in gen:
            if t == '$end':
                return out
            out.append(t)
        return out
    for t in gen:
        if t == '$scope':
            x = collect()
            name = ' '.join(x[1:]) or '(unnamed)'
            key = (cur, name)
            if key in children:
                cur = children[key]
            else:
                p = scopes[cur][0]
                scopes.append(((p + '.' + name) if p else name, cur))
                children[key] = len(scopes) - 1
                cur = len(scopes) - 1
        elif t == '$upscope':
            collect()
            if cur > 0:
                cur = scopes[cur][1]
        elif t == '$var':
            x = collect()
            if len(x) < 4:
                continue
            typ, size, code, name = x[0].lower(), x[1], x[2], ''.join(x[3:])
            try:
                size = int(size)
            except ValueError:
                size = 1
            size = max(1, size)
            kind = 'real' if typ in ('real', 'realtime', 'shortreal') else 'string' if typ == 'string' else 'scalar' if (size == 1 or typ == 'event') else 'vector'
            p = scopes[cur][0]
            full = (p + '.' + name) if p else name
            n = seen.get(full, 0)
            seen[full] = n + 1
            if n:
                full = f'{full}#{n + 1}'
            vars_.append((full, code, size, kind))
        elif t == '$enddefinitions':
            collect()
            break
        elif t.startswith('$'):
            collect()
    code_kind = {}
    for full, code, size, kind in vars_:
        code_kind.setdefault(code, kind)
    sel = [v for v in vars_ if want is None or v[0] in want]
    wcodes = {v[1] for v in sel}
    hist = {c: [] for c in wcodes}  # code -> [(t, v)]
    now = 0
    pend = None
    for t in gen:
        if pend is not None:
            kind_ch, val = pend
            pend = None
            code = t
            if code in hist:
                k = code_kind[code]
                if kind_ch in 'bB':
                    v = val.lower()
                    if k == 'scalar':
                        v = v[-1] if v[-1] in '01xzuwlh-' else 'x'
                    elif k == 'real':
                        v = float(int(v, 2))
                elif kind_ch in 'rR':
                    v = float(val) if k == 'real' else ('x' if k == 'scalar' else repr(float(val)))
                else:
                    v = val if k in ('string', 'vector') else ('x' if k == 'scalar' else float('nan'))
                hist[code].append((now, v))
            continue
        c = t[0]
        if c == '#':
            if t[1:].isdigit():
                v = int(t[1:])
                if v >= now:
                    now = v
            continue
        if c in '01xXzZuUwWlLhH-':
            if len(t) < 2:
                continue
            code = t[1:]
            if code in hist:
                k = code_kind[code]
                ch = c.lower()
                hist[code].append((now, ch if k in ('scalar', 'vector', 'string') else float('nan')))
            continue
        if c in 'bBrRsS':
            if len(t) >= 2:
                pend = (c, t[1:])
            else:
                pend = None
            continue
        if t == '$comment':
            collect()
            continue
    import bisect
    out = {}
    for full, code, size, kind in sel:
        h = hist[code]
        ts = [x[0] for x in h]
        vals = []
        for q in times:
            i = bisect.bisect_right(ts, q) - 1
            v = h[i][1] if i >= 0 else None
            if isinstance(v, float) and v != v:
                v = 'nan'
            vals.append(v)
        out[full] = vals
    print(json.dumps({'paths': out, 'end': now, 'vars': len(vars_)}))


main()
