# Changelog

## 0.1.1

- Busy buses in big files load faster and use less memory. Bus and string values now travel from the reader to the view as packed bytes instead of one text item per change. A 400 MB file with a 32-bit counter that changes every nanosecond (11 million changes) shows in about 5 s instead of 23 s, and VS Code stays responsive when you open and close it many times.
- A signal declared wider than 1,048,576 bits is read as 1,048,576 bits, with a note. Before, a file that declared 2,147,483,647 bits left that signal at "loading".
- Files with thousands of nested scopes open without an error in the signal tree.

## 0.1.0

- First release. Opens `.vcd` files from Icarus Verilog, Verilator, Vivado, ModelSim and GHDL as waveforms, with no signal limit.
- Signal tree by scope, with search and "add every signal in this scope".
- Cursor, markers A and B with the time between them, and jumps to the next or previous change of a signal.
- Radix per signal (hex, binary, unsigned, signed, ASCII), red x and yellow z, bus from bits, rename, reorder and remove.
- Large files are read in blocks by background threads. Only the signals you add are loaded.
- The signal list is kept per file, comes back when the simulator writes the file again, and can be exported and imported as JSON.
- Notes for damaged files: cut off, time going back, signals declared twice, unknown identifiers.
- Small Sponsor, More free viewers and Rate links in the status line (setting `vcdViewer.showSupportLinks`), and one rating ask after a few days of use (setting `vcdViewer.askForRating`).
