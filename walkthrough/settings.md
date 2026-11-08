# Signal lists and settings

The viewer keeps your signal list, radixes, names, zoom, cursor and markers for each file, on this computer only.
When the simulator writes the file again, it is read again and your signals stay.
Export writes the list as a `.signals.json` file that you can commit next to the testbench; Import loads it.

| Setting | Default | What it does |
|---|---|---|
| `vcdViewer.defaultRadix` | hex | Radix for vector signals when you add them |
| `vcdViewer.initialSignals` | 64 | Signals shown when a file opens for the first time |
| `vcdViewer.autoReload` | true | Read the file again when it changes on disk |
| `vcdViewer.rowHeight` | normal | compact, normal or large rows |
| `vcdViewer.maxFileMB` | 16384 | Larger files show a message and are not read |
| `vcdViewer.askForRating` | true | Ask one time for a Marketplace rating after a few days of use |
