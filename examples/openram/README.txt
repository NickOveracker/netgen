Cells from OpenRAM (https://github.com/VLSIDA/OpenRAM, branch stable at b2b069ce119d),
technology/scn4m_subm, under OpenRAM's BSD 3-Clause licence (LICENSE in this folder):

  dff.sp, sense_amp.sp, tri_gate.sp, cell_1rw.sp
                  schematics (sp_lib/), unchanged
  setup.tcl       OpenRAM's netgen setup (tech/), unchanged
  dff.spice, sense_amp.spice, tri_gate.spice, cell_1rw.spice
                  the layouts' netlists, extracted by the Magic web app
                  (https://magic.stixu.io, demo openram) from OpenRAM's mag_lib/
                  cells, with the schematics' pins made ports

Each layout matches its schematic. The Compare window (Windows > Compare) picks another pair.
