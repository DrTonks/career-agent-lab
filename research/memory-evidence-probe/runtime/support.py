#!/usr/bin/env python3
"""Evidence-support supplement; never a replacement for the primary score.

Implemented before V11 freezing. Reads only completed runs and frozen JSON;
Public portability: pure audit functions extracted from the frozen implementation. No model
APIs, credentials, SQLite access, or changes to results/summary. Calculations
use each arm's actual recorded facts, not unread confirmation values. Witness
semantics, genuine counterexamples, retrieval and local-review completion are
separate diagnostics; an empty witness list never proves safety.
"""
import argparse
import copy
import hashlib
import itertools
import json
import math
from collections import Counter
from pathlib import Path

ROLES = ("match", "path", "report")
FIELDS = {"match": "eligible", "path": "next", "report": "recommend"}


def read(path):
    return json.loads(path.read_text())


def equal(a, b):
    """JSON semantic equality: booleans are not numbers; 1 and 1.0 agree."""
    if isinstance(a, dict) or isinstance(b, dict):
        return isinstance(a, dict) and isinstance(b, dict) and a.keys() == b.keys() and all(equal(a[k], b[k]) for k in a)
    if isinstance(a, list) or isinstance(b, list):
        return isinstance(a, list) and isinstance(b, list) and len(a) == len(b) and all(equal(x, y) for x, y in zip(a, b))
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


def domain(field, fact):
    value, alternatives = fact["value"], fact["alternatives"]
    if value is not None:
        if alternatives is not None:
            raise ValueError("Known fact also has alternatives")
        values = [value]
    else:
        values = alternatives
    if values is None:
        return [False, True] if field == "applied" else None
    if not values:
        raise ValueError("Empty observed domain")
    for value in values:
        if field == "applied":
            if type(value) is not bool:
                raise ValueError("Nonboolean application state")
        elif type(value) not in (int, float) or not math.isfinite(value) or value < 0 or (field == "days" and value != int(value)):
            raise ValueError("Invalid nonnegative day/hour domain")
    return values


def allowed_outputs(facts, rule):
    """Exact support for the V11 monotone, nonnegative conjunction.

    An open numeric domain has minimum zero and no stated upper bound. With
    positive factors its product is unbounded; zero times an unbounded domain
    remains zero. These extrema decide existence of satisfying/refuting
    worlds without truncating the open domain to a made-up finite list.
    """
    ds, hs, applications = (domain(k, facts[k]) for k in ("days", "hours", "applied"))
    minimum, threshold = rule["minDays"], rule["minHours"]
    if any(type(x) not in (int, float) or not math.isfinite(x) or x < 0 for x in (minimum, threshold)):
        raise ValueError("Invalid rule threshold")
    dmin, hmin = (0 if xs is None else min(xs) for xs in (ds, hs))
    dmax, hmax = (math.inf if xs is None else max(xs) for xs in (ds, hs))
    product_max = 0 if dmax == 0 or hmax == 0 else dmax * hmax
    eligible = set()
    if dmax >= minimum and product_max >= threshold:
        eligible.add(True)
    if dmin < minimum or dmin * hmin < threshold:
        eligible.add(False)
    if not eligible:
        raise ValueError("Empty qualification support")
    actions = {("wait" if applied else "apply") if e else ("withdraw" if applied else "none")
               for e in eligible for applied in applications}
    supports = {"match": eligible, "path": actions, "report": eligible}
    return {role: sorted(values, key=lambda x: json.dumps(x)) for role, values in supports.items()}


def consensus(supports):
    return {r: {FIELDS[r]: values[0] if len(values) == 1 else None} for r, values in supports.items()}


def full_worlds(facts):
    """Runtime domain coverage: open applied was NOT an observed finite list."""
    domains = []
    for key in ("days", "hours", "applied"):
        f = facts[key]
        if f["value"] is None and f["alternatives"] is None:
            return None
        domains.append(domain(key, f))
    rows = [dict(zip(("days", "hours", "applied"), x)) for x in itertools.product(*domains)]
    return rows if 2 <= len(rows) <= 4 else None


def branch_reference(world, rule):
    if set(world) != {"days", "hours", "applied"}:
        raise ValueError("Branch assumption fields differ from the factual state")
    if any(value is None for value in world.values()):
        raise ValueError("A branch assignment must be concrete, not another unknown domain")
    return consensus(allowed_outputs({k: {"value": v, "alternatives": None} for k, v in world.items()}, rule))


def pre_extra(previous, event):
    facts, rule = copy.deepcopy(previous["facts"]), copy.deepcopy(previous["rule"])
    if event["scope"] == previous["scope"]:
        for key, observed in event.get("observations", {}).items():
            facts[key] = copy.deepcopy(observed)
        rule = copy.deepcopy(event.get("rule", rule))
    return facts, rule


def pre_source_ids(previous, event):
    ids = {source["id"] for source in previous.get("sources", [])}
    if event["scope"] == previous["scope"]:
        ids.add(event["id"])
        if event.get("rule"):
            ids.add(event["rule"]["id"])
    return ids


def known_target(memory, role):
    values = memory.get("values", {})
    return (memory.get("status") == "current" and set(values) == {FIELDS[role]}
            and values[FIELDS[role]] is not None)


def counterexample_audit(record, previous, event):
    extra = record.get("extra")
    if record["arm"] != "probe" or not extra or "witnesses" not in extra:
        return None
    facts, rule = pre_extra(previous, event)
    expected_worlds = full_worlds(facts)
    witnesses = extra["witnesses"]
    candidates = record.get("scheduledCandidates", [])
    sources = pre_source_ids(previous, event)
    target_counts = Counter(w.get("target") for w in witnesses)
    opportunities = {}
    for role in candidates:
        if role not in ROLES or not known_target(previous["memories"][role], role):
            continue
        opportunities[role] = [w for w in expected_worlds or []
                               if not equal(branch_reference(w, rule)[role], previous["memories"][role]["values"])]
    inspected = []
    for index, witness in enumerate(witnesses):
        role, assumption = witness.get("target"), witness.get("assumptions")
        target_valid = role in ROLES and role in candidates
        memory = previous["memories"].get(role, {})
        target_known = role in ROLES and known_target(memory, role)
        legal_world = expected_worlds is not None and any(equal(assumption, w) for w in expected_worlds)
        refs = witness.get("refs", [])
        refs_valid = bool(refs) and rule["id"] in refs and all(ref in sources for ref in refs)
        expected = None
        try:
            if role not in ROLES:
                raise ValueError("Unknown witness target")
            expected = branch_reference(assumption, rule)[role]
        except (KeyError, ValueError, TypeError) as error:
            error_text = str(error)
        else:
            error_text = None
        claimed = witness.get("alternativeValues")
        semantic_correct = expected is not None and equal(claimed, expected)
        refutes = (target_valid and target_known and legal_world and expected is not None
                   and not equal(expected, memory["values"]))
        genuine = refutes and semantic_correct and refs_valid and target_counts[role] == 1
        matching_obligations = [o for o in record.get("obligations", [])
                                if o.get("target") == role and equal(o.get("assumptions"), assumption)
                                and equal(o.get("claimedAlternativeValues"), claimed)]
        inspected.append({"index": index, "target": role, "assumptions": assumption,
                          "claimedAlternativeValues": claimed, "referenceAlternativeValues": expected,
                          "preExtraCurrentValue": memory.get("values"), "targetScheduled": target_valid,
                          "currentTargetKnown": target_known, "assumptionInObservedWorlds": legal_world,
                          "uniqueTarget": target_counts[role] == 1, "sourceReferencesValid": refs_valid,
                          "semanticOutputCorrect": semantic_correct,
                          "actuallyRefutesCurrentValue": refutes,
                          "genuineCounterexample": genuine,
                          "claimedDifferentFromCurrent": target_known and not equal(claimed, memory["values"]),
                          "obligationCreated": bool(matching_obligations), "error": error_text})
    found = {w["target"] for w in inspected if w["genuineCounterexample"]}
    missed = [role for role, ws in opportunities.items() if ws and role not in found]
    return {"preExtraRuleId": rule["id"], "preExtraObservedWorlds": expected_worlds,
            "knownTargetsWithCounterexamples": [role for role, ws in opportunities.items() if ws],
            "counterexampleWorldsByTarget": opportunities, "witnesses": inspected,
            "missedCounterexampleRoles": missed,
            "emptyWitnessDespiteAvailableCounterexample": not witnesses and bool(missed),
            "optionalFailure": record.get("extraError"),
            "note": "A witness is a conditional counterexample, not an observed fact. Absent witnesses are not certificates. Semantics use the pre-read actual state; unread confirmations cannot support a witness."}


def assumption_resolution(assumption, facts):
    """Did current actual observations confirm or exclude the entire witness?"""
    if not assumption or set(assumption) != {"days", "hours", "applied"}:
        return "not-applicable"
    fully_known = True
    for field, value in assumption.items():
        observed = facts[field]
        possibilities = domain(field, observed)
        if possibilities is not None and not any(equal(value, v) for v in possibilities):
            return "refuted"
        if observed["value"] is None:
            fully_known = False
    return "confirmed" if fully_known else "unresolved"


def obligation_audit(record, previous, event, role_assessments):
    extra = record.get("extra") or {}
    by_id = {d["id"]: d for d in event.get("documents", [])}
    read_ids = record.get("reads", [])
    before_facts, _ = pre_extra(previous, event)
    items = []
    for obligation in record.get("obligations", []):
        target = obligation["target"]
        dependencies = {"days", "hours", "applied"} if target == "path" else {"days", "hours"}
        requested = obligation.get("requestedDocumentIds", extra.get("readIds", []))
        source_rows = []
        for doc_id in read_ids:
            doc = by_id.get(doc_id)
            if doc is None:
                source_rows.append({"id": doc_id, "availableInEventCatalog": False,
                                    "relevantConfirmation": False})
                continue
            relevant = {k: v for k, v in doc.get("observations", {}).items() if k in dependencies}
            same_scope = doc["scope"] == previous["scope"]
            confirmation = same_scope and any(v["value"] is not None for v in relevant.values())
            changed = [k for k, v in relevant.items() if not equal(
                {"value": before_facts[k]["value"], "alternatives": before_facts[k]["alternatives"]}, v)] if same_scope else []
            reflected = same_scope and all(equal(
                {"value": record["state"]["facts"][k]["value"],
                 "alternatives": record["state"]["facts"][k]["alternatives"]}, v)
                for k, v in doc.get("observations", {}).items())
            source_rows.append({"id": doc_id, "availableInEventCatalog": True,
                                "scopeMatches": same_scope, "relevantConfirmation": confirmation,
                                "sameScopeNoise": same_scope and not relevant,
                                "changedRelevantFacts": changed, "recordedFactsReflectDocument": reflected})
        confirmation_read = any(d["relevantConfirmation"] and d.get("recordedFactsReflectDocument") for d in source_rows)
        requested_read = all(doc_id in read_ids for doc_id in requested) if requested else None
        target_after = record["state"]["memories"][target]
        before_version = previous["memories"][target]["version"]
        committed = (any(d["role"] == target for d in record.get("decisions", []))
                     and target_after["version"] > before_version)
        resolution = assumption_resolution(obligation.get("assumptions"), record["state"]["facts"])
        aligned = role_assessments[target]["evidenceAligned"]
        # A successful role call alone does not discharge an evidence request.
        # No requested read yields None, not vacuous success or mandatory failure.
        evidence_completed = (bool(requested_read and confirmation_read) if requested else None)
        witness_resolved = confirmation_read and resolution in ("confirmed", "refuted")
        completed = (evidence_completed and committed and aligned
                     and (resolution == "not-applicable" or witness_resolved)) if requested else None
        items.append({"id": obligation["id"], "target": target, "kind": obligation.get("kind"),
                      "hostStatus": obligation.get("status"), "requestedDocumentIds": requested,
                      "actuallyReadIds": read_ids, "readDocuments": source_rows,
                      "allRequestedDocumentsRead": requested_read,
                      "relevantConfirmationRead": confirmation_read,
                      "requestedEvidenceReadCompleted": evidence_completed,
                      "assumptionResolutionFromActualFacts": resolution,
                      "witnessResolvedByRead": witness_resolved,
                      "localReviewCommitted": committed,
                      "hostCompletionMarkerAgrees": (obligation.get("status") == "local-review-completed") == committed,
                      "finalTargetEvidenceAligned": aligned,
                      "finalTargetGoldCorrect": role_assessments[target]["goldCorrect"],
                      "requestedEvidenceAndReviewCompleted": completed,
                      "note": "A refuted witness can be successfully resolved by a real confirmation. Conditional witness truth and actual-world truth are different."})
    return {"obligations": items,
            "note": "Counts are per target obligation, not per distinct document fetch. Three obligations may share one read. No requested evidence is reported as null for evidence-task completion."}


def assess(record, label, previous, event):
    state = record["state"]
    supports = allowed_outputs(state["facts"], state["rule"])
    evidence_values = consensus(supports)
    roles = {}
    for role in ROLES:
        memory, field = state["memories"][role], FIELDS[role]
        value = memory["values"].get(field)
        expected_status = "current" if len(supports[role]) == 1 else "uncertain"
        entailed = len(supports[role]) == 1 and equal(value, supports[role][0])
        unsupported = value is not None and not entailed
        roles[role] = {"actual": memory["values"], "status": memory["status"],
                       "allowedOutputs": supports[role], "evidenceExpected": evidence_values[role],
                       "evidenceExpectedStatus": expected_status,
                       "evidenceAligned": equal(memory["values"], evidence_values[role]) and memory["status"] == expected_status,
                       "unsupportedKnown": memory["status"] == "current" and unsupported,
                       "unsupportedConcrete": unsupported,
                       "refutedConcrete": value is not None and not any(equal(value, v) for v in supports[role]),
                       "goldCorrect": equal(memory["values"], label["expected"][role]) and memory["status"] == label["statuses"][role]}
    facts = {k: v["value"] for k, v in state["facts"].items()}
    false_facts = [k for k, v in facts.items() if v is not None and not equal(v, label["expectedFacts"][k])]
    rule_matches = equal(state["rule"], label.get("effectiveRule", label["rule"]))
    primary = all(x["goldCorrect"] for x in roles.values()) and not false_facts and not record["errors"]
    supported = all(x["evidenceAligned"] for x in roles.values()) and rule_matches and not record["errors"]
    unsupported = [r for r in ROLES if roles[r]["unsupportedKnown"]]
    return {"eventId": record["eventId"], "arm": record["arm"], "category": label["category"],
            "primaryCorrectRecomputed": bool(primary), "evidenceSupportedFullState": bool(supported),
            "truthAndEvidenceSupportedFullState": bool(primary and supported),
            "luckyPrimarySuccess": bool(primary and unsupported),
            "unsupportedKnownConclusions": unsupported,
            "unsupportedConcreteConclusions": [r for r in ROLES if roles[r]["unsupportedConcrete"]],
            "refutedConcreteConclusions": [r for r in ROLES if roles[r]["refutedConcrete"]],
            "wrongSkipsAgainstGold": [r for r in record["skipped"] if not roles[r]["goldCorrect"]],
            "unsupportedSkipsAtActualEvidence": [r for r in record["skipped"] if roles[r]["unsupportedKnown"]],
            "ruleMatchesEffectiveGold": rule_matches, "actualFacts": state["facts"], "falseFactsAgainstGold": false_facts,
            "factsCompleteAgainstGold": equal(facts, label["expectedFacts"]), "roles": roles,
            "ordinaryPathErrors": record["errors"], "optionalFailure": record.get("extraError"),
            "counterexampleAudit": counterexample_audit(record, previous, event),
            "evidenceObligationAudit": obligation_audit(record, previous, event, roles)}
