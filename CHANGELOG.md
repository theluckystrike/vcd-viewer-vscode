# Changelog

## 0.1.0

- First release. Opens `.vcd` files from Icarus Verilog, Verilator, Vivado, ModelSim and GHDL as waveforms, with no signal limit.
- Signal tree by scope, with search and "add every signal in this scope".
- Cursor, markers A and B with the time between them, and jumps to the next or previous change of a signal.
- Radix per signal (hex, binary, unsigned, signed, ASCII), red x and yellow z, bus from bits, rename, reorder and remove.
- Large files are read in blocks by background threads. Only the signals you add are loaded.
- The signal list is kept per file, comes back when the simulator writes the file again, and can be exported and imported as JSON.
- Notes for damaged files: cut off, time going back, signals declared twice, unknown identifiers.
- Small Sponsor, More free viewers and Rate links in the status line (setting `vcdViewer.showSupportLinks`), and one rating ask after a few days of use (setting `vcdViewer.askForRating`).
