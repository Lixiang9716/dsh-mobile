#!/usr/bin/env python3
"""check_size_test.py — the code-size gate's own net (tools/check-size.py).

The gate sizes every landing; these tests size the gate. Cases pin the
documented behaviors and the historically-captured failure classes:

  - the comment-state machine (#340: a stuck block-comment state blanked
    every downstream signature, `brace_functions` found zero bodies, and
    L3 passed vacuously for whole files) — the same known-answer cases
    `--self-test` carries, pinned here as regression tests;
  - the indent-fallback ruler's documented language-blindness (#342) and
    its INDENT(indent-fallback) labeling;
  - FILE / FUNC verdicts on the ast/heuristic fallback backend;
  - the CLI contract end to end in a throwaway git repo: a tracked
    oversized file exits 1, vendor/ and staged-closure copies are exempt
    (D6 verbatim upstream + byte-verified mirrors), and an UNTRACKED file
    is still checked (#338: the widened scope that ended the late-red);

Runner: `python3 test/tools/check_size_test.py` (stdlib unittest — no
dependencies), or `python3 -m pytest test/tools/check_size_test.py`.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOL = os.path.join(REPO, "tools", "check-size.py")

_spec = importlib.util.spec_from_file_location("check_size", TOOL)
cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cs)


def strip_all(lines):
    """strip_code over a line list; returns (stripped, final_state)."""
    state = {"bc": False, "bt": False, "q": None}
    out = [cs.strip_code(line, state) for line in lines]
    return out, state


class StripCodeState(unittest.TestCase):
    """The comment/string state machine — #340's capture class."""

    def test_one_liner_block_comment_clears_at_eol(self):
        out, state = strip_all(["/** doc */", "code();"])
        self.assertEqual(out[1].strip(), "code();")
        self.assertFalse(state["bc"])

    def test_multiline_block_comment_carries_state(self):
        out, state = strip_all(["/* start", "still hidden */ code();"])
        self.assertEqual(out[0].strip(), "")
        self.assertEqual(out[1].strip(), "code();")
        self.assertFalse(state["bc"])

    def test_line_comment_hides_rest_of_line(self):
        out, _ = strip_all(["real(); // hidden { brace"])
        self.assertNotIn("{", out[0])

    def test_string_slashes_do_not_open_a_comment(self):
        # string CONTENTS are blanked (the documented behavior) — the
        # property pinned here: the `//` inside the string did not start
        # a line comment, so the code AFTER the string survives
        out, state = strip_all(['const u = "http://x";'])
        self.assertTrue(out[0].startswith("const u = "))
        self.assertTrue(out[0].rstrip().endswith(";"))
        self.assertFalse(state["bc"])
        self.assertFalse(state["q"])

    def test_escaped_quote_keeps_string_open_until_real_close(self):
        out, state = strip_all(['const s = "a \\" b // c";'])
        self.assertFalse(state["q"])
        self.assertNotIn("//", out[0])

    def test_template_literal_spans_lines(self):
        out, state = strip_all(["const t = `multi", "// not a comment`;", "real();"])
        self.assertFalse(state["bt"])
        self.assertNotIn("//", out[1].replace(" ", ""))
        self.assertIn("real", out[2])

    def test_state_ends_clean_on_every_case(self):
        for lines in (["/* a */ f();"], ["`x`"], ["'q'"], ["/* a", "b */ c();"]):
            _, state = strip_all(lines)
            self.assertFalse(any([state["bc"], state["bt"], state["q"]]))


class BraceFunctions(unittest.TestCase):
    """Function spans — #340's known-answer fixtures plus the documented
    anchor cases (destructured params, arrows)."""

    SELF_TEST_CASES = [
        (["/** doc */", "function f() {", "  return 1;", "}"], [(2, 4)]),
        (["/** doc", " * more", " */", "function g() {", "  return 1;", "}"],
         [(4, 6)]),
        (["/** doc", " * more prose */", "function h() {", "  return 1;", "}"],
         [(3, 5)]),
        (["/** a */", "function i() {", "  return 1;", "}",
          "/** b */", "function j() {", "  return 2;", "}"],
         [(2, 4), (6, 8)]),
    ]

    def test_self_test_known_answers(self):
        for lines, expected in self.SELF_TEST_CASES:
            self.assertEqual(cs.brace_functions(lines), expected, lines)

    def test_destructured_param_does_not_close_span(self):
        lines = ["function f({ a, b }) {", "  return a;", "}"]
        self.assertEqual(cs.brace_functions(lines), [(1, 3)])

    def test_arrow_function_span(self):
        lines = ["const f = (x) => {", "  return x;", "}"]
        self.assertEqual(cs.brace_functions(lines), [(1, 3)])

    def test_control_flow_is_not_a_function_start(self):
        self.assertEqual(cs.brace_functions(["if (x) {", "  y();", "}"]), [])


class IndentViolations(unittest.TestCase):
    """Indent depth on code lines only; fallback ruler is language-blind."""

    def test_six_levels_is_a_violation(self):
        lines = ["function f() {"] + ["  " * n + "x();" for n in range(1, 7)] + ["}"]
        bad = cs.indent_violations(lines, is_python=False)
        self.assertEqual([line for line, _ in bad], [7])
        self.assertGreaterEqual(bad[0][1], 6)

    def test_comment_lines_do_not_poison_unit_detection(self):
        lines = ["class C {", "  // leading prose at depth 1", "  m() {", "  }", "}"]
        self.assertEqual(cs.indent_violations(lines, is_python=False), [])

    def test_python_indent_counts_tabs_and_columns(self):
        # the python ruler is ws.count("\t") + len(ws) // 4 (check-size.py
        # _indent_level): a tab is one level AND a quarter column, so five
        # tabs measure level 6 — pinned here as the documented arithmetic
        lines = ["if a:", "\tif b:", "\t\tif c:", "\t\t\tif d:",
                 "\t\t\t\tif e:", "\t\t\t\t\tif f:", "\t\t\t\t\t\tpass"]
        bad = cs.indent_violations(lines, is_python=True)
        self.assertEqual(bad, [(6, 6), (7, 7)])


class CheckFallbackBackend(unittest.TestCase):
    """check() with facts=None: the ast/heuristic fallback verdicts."""

    def test_file_over_500_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "big.js")
            with open(path, "w") as f:
                f.write("// pad\n" * 501)
            violations, backend = cs.check(path, None)
        self.assertEqual(backend, "fallback")
        self.assertIn((1, "FILE", "501 lines > 500"), violations)

    def test_function_over_50_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "fn.js")
            body = ["function f() {"] + ["  x();" for _ in range(51)] + ["}"]
            with open(path, "w") as f:
                f.write("\n".join(body) + "\n")
            violations, _ = cs.check(path, None)
        kinds = [kind for _, kind, _ in violations]
        self.assertIn("FUNC", kinds)

    def test_deep_indent_is_labeled_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "deep.js")
            body = ["function f() {"] + ["  " * n + "x();" for n in range(1, 7)] + ["}"]
            with open(path, "w") as f:
                f.write("\n".join(body) + "\n")
            violations, _ = cs.check(path, None)
        self.assertTrue(any(kind == "INDENT(indent-fallback)" for _, kind, _ in violations))

    def test_clean_small_file_has_no_violations(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "ok.js")
            with open(path, "w") as f:
                f.write("function ok() {\n  return 1;\n}\n")
            violations, backend = cs.check(path, None)
        self.assertEqual((violations, backend), ([], "fallback"))


class CliEndToEnd(unittest.TestCase):
    """The CLI in a throwaway git repo: scope exemptions + exit codes."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dsh-code-size-")
        self.run_git(["init", "-q"])

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_git(self, args):
        subprocess.run(["git"] + args, cwd=self.tmp, check=True, capture_output=True)

    def write_oversized(self, rel, tracked):
        path = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("// pad\n" * 501)
        if tracked:
            self.run_git(["add", rel])

    def run_tool(self):
        cmd = [sys.executable, TOOL]
        r = subprocess.run(cmd, cwd=self.tmp, capture_output=True, text=True)
        return r.returncode, r.stdout

    def test_tracked_oversized_file_exits_1(self):
        self.write_oversized("src/big.js", tracked=True)
        code, out = self.run_tool()
        self.assertEqual(code, 1)
        self.assertIn("src/big.js:1: FILE 501 lines > 500", out)
        self.assertIn("1 violation(s)", out)

    def test_vendor_segment_is_exempt(self):
        self.write_oversized("libs/vendor/pkg/dist/big.js", tracked=True)
        code, out = self.run_tool()
        self.assertEqual((code, out.count("FILE")), (0, 0))

    def test_staged_closure_copy_is_exempt(self):
        rel = "hosts/android/app/src/main/assets/spike/big.js"
        self.write_oversized(rel, tracked=True)
        code, out = self.run_tool()
        self.assertEqual((code, out.count("FILE")), (0, 0))

    def test_untracked_file_is_still_checked(self):
        # #338: `git ls-files` alone hid brand-new files — the widened
        # scope must check them and count them in the summary
        self.write_oversized("src/new.js", tracked=False)
        code, out = self.run_tool()
        self.assertEqual(code, 1)
        self.assertIn("src/new.js:1: FILE", out)
        self.assertIn("1 untracked;", out)

    def test_self_test_leg_exits_zero(self):
        cmd = [sys.executable, TOOL, "--self-test"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("case(s) ok", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
