# Agent Note: e2e selftest positive fixture predates the frozen m2 audit sequence

Status: implemented
Related: D0

## Problem

tools/e2e/selftest.sh failed on main since #26: the hand-written m2-gateway.positive.txt fixture was drafted before the m2.gateway.audit manifest froze its 16-record sequence (15 records, shifted verdict fields), so the selftest asserted against a stream that never occurs in reality — while the same manifest passed 16/16 against real device captures. The fixture, not the manifest, was wrong.

## Decision

m2-gateway.positive.txt is regenerated from the canonical lines of the real simulator capture (hosts/ios/artifacts/m2-gateway/logs.txt, the run the committed 16/16 verdict came from). Both m2 manifests accept it, both negative fixtures still fail at their named indices, and the m1 slim fixture is unchanged: tools/e2e/selftest.sh is all green again.

## Alternatives considered

Relaxing the audit manifest to match the fixture: rejected — the manifest matches reality (committed device verdicts), the fixture was the lie. Dropping the audit acceptance assertion from the selftest: rejected — it would silence the only replay-level proof of the flat-envelope matcher.
