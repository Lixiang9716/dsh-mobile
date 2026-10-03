;; wc.wat — the `wc` starter program (system-plugins/dsh-shell-wasm).
;;
;; One export, `run(ptr, len) -> i32`, the contract v1.2.0 wasmRun ABI: the
;; host writes the caller's input text into the module's memory and hands over
;; (ptr, len); the module reports through the imported dsh.emit(ptr, len) and
;; its i32 return is the exit status.
;;
;; Counts lines, words and bytes OF THE INPUT TEXT — the executor's argument
;; text, exactly the data the ABI carries — and emits them as
;; `<lines> <words> <bytes>\n` (single-space separated; this module's own
;; format, not busybox's column layout). Word characters run between
;; whitespace bytes; whitespace is space and the C control block 0x09..0x0D
;; (tab, LF, VT, FF, CR) — the same set isspace(3) names. An unterminated tail
;; line counts, the POSIX way: the last line needs no newline to be one.
;; Always exits 0: counting is not failing.
;;
;; The scratch buffer for the formatted line is linear memory at 0..47 (the
;; module defines no other data; counts of a ≤4095-byte input fit in 4 digits
;; each, so 36 bytes is the hard ceiling). The input itself lives at the TOP
;; of memory (the host pins it 4096 bytes before the end) — the two never meet.
(module
  (import "dsh" "emit" (func $emit (param i32 i32)))

  (memory (export "memory") 1)

  ;; $isws — the whitespace set: space, or the 0x09..0x0D control block.
  (func $isws (param $c i32) (result i32)
    (i32.or
      (i32.eq (local.get $c) (i32.const 32))
      (i32.and (i32.ge_u (local.get $c) (i32.const 9))
               (i32.le_u (local.get $c) (i32.const 13)))))

  ;; $fmt — write the decimal digits of <n> at cursor <cur>, then one
  ;; separator space; returns the cursor after them. Two passes: count the
  ;; digits, then write most-significant first (a single divmod pass would
  ;; spill the digits in reverse — `14` as `41`).
  (func $fmt (param $n i32) (param $cur i32) (result i32)
    (local $d i32) (local $t i32) (local $count i32) (local $k i32)
    (local.set $t (local.get $n))
    (loop $count
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      (local.set $t (i32.div_u (local.get $t) (i32.const 10)))
      (br_if $count (i32.gt_u (local.get $t) (i32.const 0))))
    (local.set $k (local.get $count))
    (loop $write
      (local.set $k (i32.sub (local.get $k) (i32.const 1)))
      (local.set $d (i32.rem_u (local.get $n) (i32.const 10)))
      (i32.store8 (i32.add (local.get $cur) (local.get $k))
                  (i32.add (i32.const 48) (local.get $d)))
      (local.set $n (i32.div_u (local.get $n) (i32.const 10)))
      (br_if $write (i32.gt_u (local.get $k) (i32.const 0))))
    (i32.store8 (i32.add (local.get $cur) (local.get $count)) (i32.const 32))
    (i32.add (local.get $cur) (i32.add (local.get $count) (i32.const 1))))

  (func (export "run") (param $ptr i32) (param $len i32) (result i32)
    (local $i i32) (local $c i32)
    (local $lines i32) (local $words i32) (local $inword i32)
    (local $cur i32)
    ;; one pass: lines (newline count), words (ws->non-ws transitions),
    ;; bytes (the length itself).
    (local.set $i (i32.const 0))
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $c
          (i32.load8_u (i32.add (local.get $ptr) (local.get $i))))
        (if (i32.eq (local.get $c) (i32.const 10))
          (then (local.set $lines (i32.add (local.get $lines) (i32.const 1)))))
        (if (call $isws (local.get $c))
          (then (local.set $inword (i32.const 0)))
          (else
            (if (i32.eqz (local.get $inword))
              (then (local.set $words (i32.add (local.get $words) (i32.const 1)))))
            (local.set $inword (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
    ;; the POSIX tail: input that does not end in a newline still ended in a
    ;; line — and empty input has no lines at all.
    (if (i32.gt_u (local.get $len) (i32.const 0))
      (then
        (if (i32.ne (i32.load8_u (i32.add (local.get $ptr)
                                          (i32.sub (local.get $len) (i32.const 1))))
                    (i32.const 10))
          (then (local.set $lines (i32.add (local.get $lines) (i32.const 1)))))))
    ;; "<lines> <words> <bytes>\n" at the scratch buffer, then emit it.
    (local.set $cur (call $fmt (local.get $lines) (i32.const 0)))
    (local.set $cur (call $fmt (local.get $words) (local.get $cur)))
    (local.set $cur (call $fmt (local.get $len) (local.get $cur)))
    (i32.store8 (i32.sub (local.get $cur) (i32.const 1)) (i32.const 10))
    (call $emit (i32.const 0) (local.get $cur))
    (i32.const 0)))
