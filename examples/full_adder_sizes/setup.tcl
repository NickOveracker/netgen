# netgen setup for Magic's scmos technology.
#
# Magic's ext2spice calls the transistors nfet and pfet; ext2sim (and Stixu's
# IRSIM export) call them n and p.  Equate the names when the two netlists use
# different ones; the defaults let source and drain swap and compare the
# transistors' sizes.
permute default
property default
foreach {a b} {nfet n pfet p} {
   catch {equate classes "-circuit1 $a" "-circuit2 $b"}
   catch {equate classes "-circuit1 $b" "-circuit2 $a"}
}
