// dsh:logging-exempt (pure function module — a range match takes no policy decisions)
/**
 * semver-range — the marketplace lookup's version algebra (data-protocols.md
 * §7.3): `satisfies(version, range)` over the v0 range grammar
 * ("^1.2.3" / "~1.2.3" / "1.2.3" / "*") and `versionLess(a, b)` for the
 * highest-version-per-id anchor. Pure predicates over semver 2.0.0 strings;
 * an unsupported range string throws (fail loud, rule 5) — the caller
 * translates that into the catalog rejection vocabulary.
 */
import { InstallRejected } from 'install-pipeline.js';

/** Does `version` satisfy `range`? */
export const satisfies = (version, range) => {
  const v = version.split(/[.+-]/).slice(0, 3).map(Number);
  if (range === '*' || range === '') return true;
  const m = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) throw new InstallRejected('invalid', `unsupported range: ${range}`);
  const [, op, mj, mn, pa] = m;
  if (!op) return v[0] === +mj && v[1] === +mn && v[2] === +pa;
  if (op === '^') return v[0] === +mj && (v[1] > +mn || (v[1] === +mn && v[2] >= +pa));
  return v[0] === +mj && v[1] === +mn && v[2] >= +pa; // ~
};

/** True iff semver `a` < semver `b` (release segments only). */
export const versionLess = (a, b) => {
  const pa = a.split(/[.+-]/)[0].split('.').map(Number);
  const pb = b.split(/[.+-]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
};
