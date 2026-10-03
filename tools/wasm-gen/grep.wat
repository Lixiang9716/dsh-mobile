;; grep.wat — the `grep` starter program (system-plugins/dsh-shell-wasm).
;;
;; One export, `run(ptr, len) -> i32`, the contract v1.2.0 wasmRun ABI: the
;; host writes the caller's input text into the module's memory and hands over
;; (ptr, len); the module reports through the imported dsh.emit(ptr, len) and
;; its i32 return is the exit status.
;;
;; Fixed-string grep over the executor's one input channel. The input layout
;; is `<pattern><one whitespace byte><text>`: the pattern runs to the FIRST
;; whitespace byte, exactly one separator byte is consumed, and the remainder
;; — newlines inside it included — is the searched text. Every text line
;; containing the pattern as a byte substring is emitted verbatim (its
;; newline included when it has one). Exit statuses are the grep convention,
;; not an error report: 0 = at least one line matched, 1 = none did, 2 = bad
;; usage (empty input → the usage line; a pattern with no separator, hence no
;; text, has nothing to search → 1, the no-match answer).
;;
;; An empty pattern matches every line (it is a substring of each), matching
;; grep. The search is the naive scan — needle-in-haystack over ≤4 KiB, the
;; honest cost for the honest input. The usage string is the module's only
;; data, at address 0; the input lives at the TOP of memory (the host pins it
;; 4096 bytes before the end) — the two never meet.
(module
  (import "dsh" "emit" (func $emit (param i32 i32)))

  (memory (export "memory") 1)
  (data (i32.const 0) "usage: grep <pattern> <text>\n")

  ;; $isws — the separator set: space, or the 0x09..0x0D control block
  ;; (tab, LF, VT, FF, CR) — the same set isspace(3) names.
  (func $isws (param $c i32) (result i32)
    (i32.or
      (i32.eq (local.get $c) (i32.const 32))
      (i32.and (i32.ge_u (local.get $c) (i32.const 9))
               (i32.le_u (local.get $c) (i32.const 13)))))

  ;; $find — 1 when the needle [p, p+plen) occurs inside the haystack
  ;; [h, h+hlen), else 0. Naive left-to-right scan, first match wins.
  (func $find (param $h i32) (param $hlen i32)
              (param $p i32) (param $plen i32) (result i32)
    (local $i i32) (local $j i32)
    (if (i32.gt_u (local.get $plen) (local.get $hlen))
      (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $done
      (loop $scan
        (br_if $done
          (i32.gt_u (i32.add (local.get $i) (local.get $plen))
                    (local.get $hlen)))
        ;; compare the needle at this offset
        (local.set $j (i32.const 0))
        (block $mismatch
          (loop $cmp
            (br_if $mismatch (i32.ge_u (local.get $j) (local.get $plen)))
            (if
              (i32.ne
                (i32.load8_u
                  (i32.add (local.get $h)
                           (i32.add (local.get $i) (local.get $j))))
                (i32.load8_u (i32.add (local.get $p) (local.get $j))))
              (then (br $mismatch)))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $cmp)))
        (if (i32.eq (local.get $j) (local.get $plen))
          (then (return (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
    (i32.const 0))

  (func (export "run") (param $ptr i32) (param $len i32) (result i32)
    (local $pat i32) (local $patlen i32)
    (local $txt i32) (local $txtlen i32)
    (local $i i32) (local $k i32) (local $linelen i32) (local $matched i32)
    ;; empty input: usage and the usage exit
    (if (i32.eqz (local.get $len))
      (then
        (call $emit (i32.const 0) (i32.const 29))
        (return (i32.const 2))))
    ;; the pattern runs to the first whitespace byte
    (local.set $pat (local.get $ptr))
    (local.set $i (i32.const 0))
    (block $split
      (loop $scan
        (br_if $split (i32.ge_u (local.get $i) (local.get $len)))
        (br_if $split
          (call $isws
            (i32.load8_u (i32.add (local.get $ptr) (local.get $i)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
    (local.set $patlen (local.get $i))
    ;; no separator byte: a pattern with no text — nothing to search, and
    ;; grep answers "no match" (1), not an error
    (if (i32.ge_u (local.get $i) (local.get $len))
      (then (return (i32.const 1))))
    ;; exactly one separator byte is consumed
    (local.set $txt (i32.add (local.get $ptr) (i32.add (local.get $i) (i32.const 1))))
    (local.set $txtlen (i32.sub (local.get $len) (i32.add (local.get $i) (i32.const 1))))
    ;; walk the text line by line; emit the lines that contain the pattern
    (local.set $i (i32.const 0))
    (block $done
      (loop $line
        (br_if $done (i32.ge_u (local.get $i) (local.get $txtlen)))
        ;; the line ends at the next newline (included) or at the text's end
        (local.set $k (local.get $i))
        (block $eol
          (loop $findnl
            (if (i32.eq (i32.load8_u (i32.add (local.get $txt) (local.get $k)))
                        (i32.const 10))
              (then
                (local.set $k (i32.add (local.get $k) (i32.const 1)))
                (br $eol)))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br_if $findnl (i32.lt_u (local.get $k) (local.get $txtlen)))
            (br $eol)))
        (local.set $linelen (i32.sub (local.get $k) (local.get $i)))
        (if
          (call $find (i32.add (local.get $txt) (local.get $i)) (local.get $linelen)
                      (local.get $pat) (local.get $patlen))
          (then
            (local.set $matched (i32.const 1))
            (call $emit (i32.add (local.get $txt) (local.get $i))
                        (local.get $linelen))))
        (local.set $i (i32.add (local.get $i) (local.get $linelen)))
        (br $line)))
    ;; the grep convention: 0 when something matched, 1 when nothing did
    (if (local.get $matched)
      (then (return (i32.const 0))))
    (i32.const 1)))
