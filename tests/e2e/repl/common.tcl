# Shared helpers for driving `wots` in a pseudo-terminal. argv: <wots executable> <mock scenario>
set timeout 30
set wots [lindex $argv 0]
set scenario [lindex $argv 1]
proc step {pat what} { expect -re $pat {} timeout { puts "\nFAIL $what"; exit 1 } eof { puts "\nFAIL eof at $what"; exit 1 } }
# The input prompt is a bold magenta glyph. Waiting for it (not sleeping) also drains output,
# so keystrokes never land while the terminal is between readline instances.
proc prompt {what} { expect -re {\[1m\x1b\[35m.{1,3}\x1b\[0m\x1b\[0m } {} timeout { puts "\nFAIL prompt before $what"; exit 1 } eof { puts "\nFAIL eof before $what"; exit 1 } }
