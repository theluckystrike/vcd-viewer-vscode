#!/usr/bin/env python3
"""Writes the sample VCD files used by the tests, the real VS Code gate and the README screenshots.

usage: python3 -I scripts/make_samples.py <outDir>
No simulator is needed. Each file copies the header style of one simulator (Icarus, Verilator, Vivado
xsim, ModelSim, GHDL). Three files are hostile on purpose (cut off, odd identifiers, time going back).
"""
import math, os, random, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'samples'
os.makedirs(OUT, exist_ok=True)


def ident(n):
    """Identifier code n in the usual VCD order: !, ", #, ... then two characters."""
    s = ''
    n += 1
    while n > 0:
        n -= 1
        s += chr(33 + n % 94)
        n //= 94
    return s


def binv(v, w):
    return format(v & ((1 << w) - 1), 'b')


class W:
    def __init__(self, name, timescale='1ns', date='Sat Nov  7 10:00:00 2026', version='Icarus Verilog', style='icarus'):
        self.name, self.ts, self.style = name, timescale, style
        self.head = []
        if date:
            self.head.append(f'$date\n\t{date}\n$end')
        if version:
            self.head.append(f'$version\n\t{version}\n$end')
        if style == 'vivado':
            self.head.append(f'$timescale\n\t{timescale}\n$end')
        else:
            self.head.append(f'$timescale {timescale} $end')
        self.n = 0
        self.body = []
        self.ids = {}

    def scope(self, name, kind='module'):
        self.head.append(f'$scope {kind} {name} $end')

    def up(self):
        self.head.append('$upscope $end')

    def var(self, name, width=1, kind='wire', rng=None, code=None):
        c = code or ident(self.n)
        if code is None:
            self.n += 1
        if width > 1 and rng is None and kind not in ('real', 'integer', 'string'):
            rng = f'[{width - 1}:0]'
        if self.style == 'verilator':
            line = f'$var {kind} {width:>2} {c} {name}{(" " + rng) if rng else ""} $end'
        else:
            line = f'$var {kind} {width} {c} {name}{(" " + rng) if rng else ""} $end'
        self.head.append(line)
        return c

    def t(self, t):
        self.body.append(f'#{t}')

    def s(self, c, v):
        self.body.append(f'{v}{c}')

    def b(self, c, v, w=None):
        if isinstance(v, int):
            v = binv(v, w)
        self.body.append(f'b{v} {c}')

    def r(self, c, v):
        self.body.append(f'r{v:.10g} {c}')

    def raw(self, text):
        self.body.append(text)

    def save(self, enddefs=True, eol=True):
        text = '\n'.join(self.head) + ('\n$enddefinitions $end\n' if enddefs else '\n') + '\n'.join(self.body) + ('\n' if eol else '')
        with open(os.path.join(OUT, self.name), 'w', newline='\n') as f:
            f.write(text)
        return text


def counter():
    w = W('counter.vcd', '1ns')
    w.scope('tb_counter')
    clk, rst, en = w.var('clk', kind='reg'), w.var('rst', kind='reg'), w.var('en', kind='reg')
    w.scope('dut')
    cnt = w.var('count', 8, 'reg')
    wrap = w.var('wrap')
    w.up(); w.up()
    w.t(0); w.raw('$dumpvars'); w.s(clk, 0); w.s(rst, 1); w.s(en, 0); w.b(cnt, 'xxxxxxxx'); w.s(wrap, 'x'); w.raw('$end')
    c = 0
    for t in range(5, 2000, 5):
        w.t(t)
        hi = (t // 5) % 2
        w.s(clk, hi)
        if t == 15:
            w.s(rst, 0)
        if t == 20:
            w.s(en, 1)
            w.b(cnt, 0, 8); w.s(wrap, 0)
        if hi and t > 20:
            c = (c + 1) % 256
            w.b(cnt, c, 8)
            w.s(wrap, 1 if c == 0 else 0)
    w.save()


def fsm():
    w = W('fsm_traffic_light.vcd', '10ns', version='Verilator 5.030', style='verilator')
    w.scope('TOP'); w.scope('traffic')
    clk = w.var('clk')
    st = w.var('state', 2, 'logic')
    name = w.var('state_name', 48, 'logic')  # 6 ASCII characters
    tmr = w.var('timer', 6, 'logic')
    w.up(); w.up()
    names = ['RED', 'GREEN', 'YELLOW']
    w.t(0); w.s(clk, 0); w.b(st, 0, 2); w.b(name, int.from_bytes(names[0].ljust(6).encode(), 'big'), 48); w.b(tmr, 0, 6)
    s, timer = 0, 0
    for k in range(1, 400):
        w.t(k * 5)
        w.s(clk, k % 2)
        if k % 2:
            timer += 1
            if timer >= [10, 8, 3][s]:
                timer = 0
                s = (s + 1) % 3
                w.b(st, s, 2)
                w.b(name, int.from_bytes(names[s].ljust(6).encode(), 'big'), 48)
            w.b(tmr, timer, 6)
    w.save()


def axi():
    w = W('axi_lite_bus.vcd', '1ps', version='ModelSim Version 2020.4', style='modelsim')
    w.scope('tb'); w.scope('dut'); w.scope('s_axi')
    aclk = w.var('aclk'); aresetn = w.var('aresetn')
    awvalid = w.var('awvalid'); awready = w.var('awready'); awaddr = w.var('awaddr', 32)
    wvalid = w.var('wvalid'); wready = w.var('wready'); wdata = w.var('wdata', 32); wstrb = w.var('wstrb', 4)
    bvalid = w.var('bvalid'); bready = w.var('bready'); bresp = w.var('bresp', 2)
    arvalid = w.var('arvalid'); arready = w.var('arready'); araddr = w.var('araddr', 32)
    rvalid = w.var('rvalid'); rready = w.var('rready'); rdata = w.var('rdata', 32); rresp = w.var('rresp', 2)
    w.up(); w.up(); w.up()
    sigs1 = [awvalid, awready, wvalid, wready, bvalid, bready, arvalid, arready, rvalid, rready]
    w.t(0); w.raw('$dumpvars'); w.s(aclk, 0); w.s(aresetn, 0)
    for c in sigs1:
        w.s(c, 0)
    for c, wd in [(awaddr, 32), (wdata, 32), (araddr, 32), (rdata, 32)]:
        w.b(c, 'x' * wd)
    w.b(wstrb, 0, 4); w.b(bresp, 0, 2); w.b(rresp, 0, 2); w.raw('$end')
    rnd = random.Random(7)
    mem = {}
    t = 0
    period = 4000
    cyc = 0
    plan = []
    for k in range(12):
        addr = 0x40000000 + 4 * rnd.randrange(16)
        if k % 3 == 2:
            plan.append(('r', addr, 0))
        else:
            plan.append(('w', addr, rnd.getrandbits(32)))
    step = 0
    stage = 0
    cur = None
    while cyc < 160:
        t += period // 2
        w.t(t); w.s(aclk, 1)
        cyc += 1
        if cyc == 4:
            w.s(aresetn, 1)
        if cyc > 6 and step < len(plan):
            if stage == 0:
                cur = plan[step]
                if cur[0] == 'w':
                    w.s(awvalid, 1); w.b(awaddr, cur[1], 32); w.s(wvalid, 1); w.b(wdata, cur[2], 32); w.b(wstrb, 0xF, 4)
                else:
                    w.s(arvalid, 1); w.b(araddr, cur[1], 32)
                stage = 1
            elif stage == 1:
                if cur[0] == 'w':
                    w.s(awready, 1); w.s(wready, 1)
                else:
                    w.s(arready, 1)
                stage = 2
            elif stage == 2:
                if cur[0] == 'w':
                    w.s(awvalid, 0); w.s(awready, 0); w.s(wvalid, 0); w.s(wready, 0); w.b(awaddr, 'x' * 32); w.b(wdata, 'x' * 32)
                    w.s(bvalid, 1); w.s(bready, 1); w.b(bresp, 0, 2)
                    mem[cur[1]] = cur[2]
                else:
                    w.s(arvalid, 0); w.s(arready, 0); w.b(araddr, 'x' * 32)
                    w.s(rvalid, 1); w.s(rready, 1); w.b(rdata, mem.get(cur[1], 0xDEADBEEF), 32)
                    w.b(rresp, 0 if cur[1] in mem else 2, 2)
                stage = 3
            else:
                w.s(bvalid, 0); w.s(bready, 0); w.s(rvalid, 0); w.s(rready, 0); w.b(rdata, 'x' * 32)
                stage = 0
                step += 1
        t += period // 2
        w.t(t); w.s(aclk, 0)
    w.save()


def wide_xz():
    w = W('wide_64bit_x_z.vcd', '1ns', style='icarus')
    w.scope('tb'); w.scope('alu')
    a = w.var('a', 64); b = w.var('b', 64); y = w.var('y', 64)
    bus = w.var('tri_bus', 16, 'tri')
    flag = w.var('carry')
    short = w.var('short_val', 12)
    w.up(); w.up()
    w.t(0); w.b(a, 'x'); w.b(b, 'z'); w.b(y, 'x'); w.b(bus, 'z'); w.s(flag, 'x'); w.b(short, '1')
    rnd = random.Random(64)
    for k in range(1, 120):
        w.t(k * 10)
        av, bv = rnd.getrandbits(64), rnd.getrandbits(64)
        if k % 17 == 0:
            w.b(a, 'x' * 32 + binv(av, 32))
        else:
            w.b(a, av, 64)
        w.b(b, bv, 64)
        s = av + bv
        w.b(y, s, 64)
        w.s(flag, 1 if s >> 64 else 0)
        if k % 5 == 0:
            w.b(bus, 'z')
        elif k % 5 == 1:
            w.b(bus, 'zzzzzzzz' + binv(k, 8))
        else:
            w.b(bus, rnd.getrandbits(16), 16)
        w.b(short, '10' if k % 2 else 'x1')  # short values: zero-extended, x-extended
    w.save()


def reals():
    w = W('real_values_analog.vcd', '100ps', version='Icarus Verilog')
    w.scope('tb_adc')
    vin = w.var('vin', 1, 'real', rng='')
    temp = w.var('temperature', 1, 'real', rng='')
    tr = w.var('t_now', 1, 'realtime', rng='')
    code = w.var('adc_code', 10, 'reg')
    w.up()
    w.t(0); w.r(vin, 0.0); w.r(temp, 25.0); w.r(tr, 0.0); w.b(code, 0, 10)
    for k in range(1, 250):
        w.t(k * 4)
        v = 1.65 + 1.5 * math.sin(k / 12.0)
        w.r(vin, v)
        if k % 25 == 0:
            w.r(temp, 25.0 + k / 50.0)
        w.r(tr, k * 0.4)
        w.b(code, int(v / 3.3 * 1023), 10)
    w.save()


def soc():
    w = W('soc_256_signals.vcd', '1ps', version='Icarus Verilog', style='icarus')
    w.scope('tb'); w.scope('soc')
    clk = w.var('clk'); rstn = w.var('rst_n')
    cores = []
    for c in range(4):
        w.scope(f'core{c}')
        for u in ['fetch', 'decode', 'alu', 'lsu']:
            w.scope(u)
            ids = []
            for k in range(8):
                ids.append((w.var(f'valid_{k}'), 1))
                ids.append((w.var(f'data_{k}', 16), 16))
            w.up()
            cores.append(ids)
        w.up()
    w.up()
    # the same scope opened again later (allowed in VCD): its signals merge into tb.soc
    w.scope('soc')
    irq = w.var('irq', 4)
    w.up(); w.up()
    allv = [x for ids in cores for x in ids]
    w.t(0); w.raw('$dumpvars'); w.s(clk, 0); w.s(rstn, 0); w.b(irq, 0, 4)
    for c, wd in allv:
        if wd == 1:
            w.s(c, 0)
        else:
            w.b(c, 'x' * wd)
    w.raw('$end')
    rnd = random.Random(256)
    for k in range(1, 300):
        w.t(k * 500)
        w.s(clk, k % 2)
        if k == 6:
            w.s(rstn, 1)
        if k % 2 and k > 6:
            for c, wd in rnd.sample(allv, 24):
                if wd == 1:
                    w.s(c, rnd.getrandbits(1))
                else:
                    w.b(c, rnd.getrandbits(16), 16)
            if k % 37 == 0:
                w.b(irq, rnd.getrandbits(4), 4)
    w.save()


def dumpoff():
    w = W('dumpoff_dumpon.vcd', '1ps')
    w.scope('tb')
    clk = w.var('clk'); d = w.var('data', 8); v = w.var('valid')
    w.up()
    w.t(0); w.raw('$dumpvars'); w.s(clk, 0); w.b(d, 0, 8); w.s(v, 0); w.raw('$end')
    val = 0
    for k in range(1, 100):
        w.t(k * 1000)
        if k == 40:
            w.raw('$dumpoff'); w.s(clk, 'x'); w.b(d, 'x'); w.s(v, 'x'); w.raw('$end')
            continue
        if 40 < k < 60:
            continue
        if k == 60:
            w.raw('$dumpon'); w.s(clk, k % 2); w.b(d, val, 8); w.s(v, 1); w.raw('$end')
            continue
        if k == 80:
            w.raw('$comment checkpoint: all values below $end')
            w.raw('$dumpall'); w.s(clk, k % 2); w.b(d, val, 8); w.s(v, 1); w.raw('$end')
            continue
        w.s(clk, k % 2)
        if k % 2:
            val = (val * 5 + 3) % 256
            w.b(d, val, 8)
            w.s(v, 1 if k % 3 else 0)
    w.save()


def vivado():
    w = W('vivado_xsim_dump.vcd', '1ps', date='Nov 07, 2026 10:12:41', version='Vivado v2024.2 (64-bit)', style='vivado')
    w.scope('tb_uart')
    clk = w.var('clk', kind='reg'); tx = w.var('tx'); busy = w.var('busy')
    w.scope('uart_tx_i')
    sh = w.var('shift_reg', 10, rng='[9:0]'); bit = w.var('bit_idx', 4, rng='[3:0]'); data = w.var('data_in', 8, rng='[7:0]')
    w.up(); w.up()
    w.t(0); w.raw('$dumpvars'); w.s(clk, 0); w.s(tx, 1); w.s(busy, 0); w.b(sh, '1111111111'); w.b(bit, 0, 4); w.b(data, 0, 8); w.raw('$end')
    t = 0
    msg = b'Hi'
    k = 0
    for ch in msg:
        frame = [0] + [(ch >> i) & 1 for i in range(8)] + [1]
        t += 10000; w.t(t); w.b(data, ch, 8); w.s(busy, 1)
        sr = int(''.join(str(b) for b in reversed(frame)), 2)
        w.b(sh, sr, 10)
        for i, bv in enumerate(frame):
            t += 8680
            w.t(t); w.s(tx, bv); w.b(bit, i, 4); w.s(clk, k % 2); k += 1
        t += 8680; w.t(t); w.s(busy, 0); w.s(tx, 1)
    w.save()


def ghdl():
    w = W('ghdl_vhdl_std_logic.vcd', '1fs', date='Sat Nov 7 10:20:00 2026', version='GHDL v0', style='ghdl')
    w.scope('tb_vhdl')
    clk = w.var('clk', kind='reg'); rst = w.var('rst', kind='reg')
    q = w.var('q', 4, 'reg', rng='[3:0]')
    weak = w.var('pullup_line', kind='reg')
    w.up()
    w.t(0); w.s(clk, 'U'); w.s(rst, 'U'); w.b(q, 'UUUU'); w.s(weak, 'Z')
    seq = ['0', '1']
    val = 0
    for k in range(1, 80):
        w.t(k * 5000000)  # 5 ns in fs
        w.s(clk, seq[k % 2])
        if k == 1:
            w.s(rst, '1'); w.b(q, '----')
        if k == 4:
            w.s(rst, '0'); w.s(weak, 'H')
        if k % 2 and k > 4:
            val = (val + 1) % 16
            w.b(q, binv(val, 4).zfill(4))
        if k == 30:
            w.s(weak, 'L')
        if k == 50:
            w.s(weak, 'W')
        if k == 60:
            w.s(weak, 'H')
    w.save()


def strings():
    w = W('strings_and_events.vcd', '1ns', version='Verilator 5.030', style='verilator')
    w.scope('TOP'); w.scope('cpu')
    pc = w.var('pc', 32, 'logic')
    op = w.var('opcode_name', 1, 'string', rng='')
    ev = w.var('retire', 1, 'event')
    w.up(); w.up()
    ops = ['addi', 'lw', 'sw', 'beq', 'jal', 'nop']
    w.t(0); w.b(pc, 0x80000000, 32); w.raw(f's{ops[0]} {op}'); w.s(ev, 0)
    for k in range(1, 60):
        w.t(k * 10)
        w.b(pc, 0x80000000 + 4 * k, 32)
        w.raw(f's{ops[k % len(ops)]} {op}')
        w.s(ev, 1)
    w.save()


# ---------- hostile ----------
def hostile_truncated():
    w = W('hostile_truncated.vcd', '1ns')
    w.scope('tb')
    clk = w.var('clk'); d = w.var('data', 16)
    w.up()
    w.t(0); w.s(clk, 0); w.b(d, 0, 16)
    for k in range(1, 50):
        w.t(k * 5); w.s(clk, k % 2); w.b(d, k * 37, 16)
    w.t(250)
    w.raw('b10110')  # the dump stops here, in the middle of a value change
    w.save(eol=False)


def hostile_ids():
    w = W('hostile_ids_100k_bits.vcd', '1ns')
    w.scope('tb')
    codes = []
    for n in range(94):  # every printable character as a one-character identifier code
        codes.append(w.var(f'sig_{n}', code=chr(33 + n)))
    w.n = 94
    codes.append(w.var('two_char', code='}~'))
    longc = w.var('long_code', 4, code='LongIdentifierCode_$%&')
    big = w.var('huge_vector', 100000, code='#x9')
    w.var('dup_name', code='d1')
    w.var('dup_name', code='d2')  # the same name declared again, with another code
    w.var('alias_of_sig_0', code='!')  # a second name for an existing code (an alias)
    w.up()
    w.t(0)
    for i, c in enumerate(codes):
        w.s(c, i % 2)
    w.b(longc, 5, 4)
    w.b(big, '1' + '0' * 99998 + '1')
    w.s('d1', 0); w.s('d2', 1)
    w.t(100)
    for i, c in enumerate(codes):
        w.s(c, (i + 1) % 2)
    w.b(longc, 'x1z0')
    w.b(big, ('10' * 50000))
    w.s('d1', 1)
    w.t(200)
    w.b(big, 'x' * 50000 + '1' * 50000)
    w.s('UNDECLARED', 1)  # an identifier that no $var declares
    w.s('d2', 0)
    w.t(300)
    w.b(big, 'z')
    w.save()


def hostile_backwards():
    w = W('hostile_time_backwards.vcd', '1ns')
    w.scope('tb')
    clk = w.var('clk'); n = w.var('n', 8)
    w.up()
    for k, t in enumerate([0, 10, 20, 30, 25, 40, 35, 50, 60]):
        w.t(t); w.s(clk, k % 2); w.b(n, k, 8)
    w.save()


def not_vcd():
    with open(os.path.join(OUT, 'hostile_not_a_vcd.vcd'), 'wb') as f:
        f.write(bytes(random.Random(1).getrandbits(8) for _ in range(4096)))


for fn in [counter, fsm, axi, wide_xz, reals, soc, dumpoff, vivado, ghdl, strings,
           hostile_truncated, hostile_ids, hostile_backwards, not_vcd]:
    fn()
print('samples written to', OUT, len(os.listdir(OUT)))
